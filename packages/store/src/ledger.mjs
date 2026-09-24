import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { ACTIONABLE_STAGES, SCHEMA_SQL, assertStage } from './schema.mjs'

function nowIso(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString()
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * 打开账本。
 *
 * 用 Node 内置的 node:sqlite，不引入原生依赖——服务器与本机都是 Node 24，
 * 而多一个需要编译的依赖就多一处部署会失败的地方。
 *
 * 幂等键：tasks.replay_key 与 deliveries.dedupe_key 都是唯一约束，
 * 因此"重复发现同一个回放"与"同一课次重复发通知"在数据库层就不可能发生。
 */
export function openLedger(databasePath = ':memory:', options = {}) {
  const resolved = databasePath === ':memory:' ? databasePath : path.resolve(databasePath)
  if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true })

  const db = new DatabaseSync(resolved)
  if (resolved !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  const statements = {
    insertTask: db.prepare(`
      INSERT INTO tasks (replay_key, course_key, course_name, title, starts_at_text, teacher,
                         stage, artifacts, runtime, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)
      ON CONFLICT (replay_key) DO UPDATE SET
        course_name = excluded.course_name,
        title = excluded.title,
        starts_at_text = excluded.starts_at_text,
        teacher = excluded.teacher,
        updated_at = excluded.updated_at
    `),
    findByReplayKey: db.prepare('SELECT * FROM tasks WHERE replay_key = ?'),
    selectActionable: db.prepare(`
      SELECT * FROM tasks
      WHERE stage IN (SELECT value FROM json_each(?))
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY id
      LIMIT 1
    `),
    claim: db.prepare(`
      UPDATE tasks
      SET claimed_by = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `),
    heartbeat: db.prepare(`
      UPDATE tasks SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND claimed_by = ?
    `),
    updateStage: db.prepare(`
      UPDATE tasks
      SET stage = ?, last_error = ?, artifacts = ?, runtime = ?, next_attempt_at = ?,
          claimed_by = '', lease_expires_at = NULL, updated_at = ?
      WHERE id = ?
    `),
    insertEvent: db.prepare('INSERT INTO task_events (task_id, at, stage, message, data) VALUES (?, ?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id'),
    listTasks: db.prepare('SELECT * FROM tasks WHERE (? IS NULL OR stage = ?) ORDER BY id LIMIT ?'),
    insertDelivery: db.prepare(`
      INSERT INTO deliveries (dedupe_key, purpose, body_text, object_url, status, scheduled_for, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT (dedupe_key) DO NOTHING
    `),
    findDelivery: db.prepare('SELECT * FROM deliveries WHERE dedupe_key = ?'),
    selectDelivery: db.prepare(`
      SELECT * FROM deliveries
      WHERE status = 'pending' AND scheduled_for <= ?
      ORDER BY scheduled_for, id
      LIMIT 1
    `),
    claimDelivery: db.prepare(`
      UPDATE deliveries
      SET status = 'claimed', claimed_at = ?, claimed_by = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    ackDelivery: db.prepare(`
      UPDATE deliveries
      SET status = ?, external_id = ?, last_error = ?, sent_at = ?, updated_at = ?
      WHERE id = ?
    `)
  }

  function hydrate(row) {
    if (!row) return null
    return {
      ...row,
      artifacts: parseJson(row.artifacts, {}),
      runtime: parseJson(row.runtime, {})
    }
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    db,
    path: resolved,

    /**
     * 幂等登记回放。已存在的 replay_key 只刷新展示字段，绝不重置阶段与重试计数——
     * 这正是旧系统靠 (owner_id, replay_key) 唯一约束达成的语义。
     */
    discoverReplays(replays = [], { now } = {}) {
      const at = nowIso(now)
      return transaction(() => {
        let inserted = 0
        let existing = 0
        for (const replay of replays) {
          const replayKey = String(replay.replay_key || replay.replayKey || '').trim()
          const courseKey = String(replay.course_key || replay.courseKey || '').trim()
          if (!replayKey || !courseKey) throw new Error('登记回放需要 replay_key 与 course_key')
          const before = statements.findByReplayKey.get(replayKey)
          if (before) existing += 1
          else inserted += 1
          statements.insertTask.run(
            replayKey,
            courseKey,
            String(replay.course_name || replay.courseName || ''),
            String(replay.title || ''),
            String(replay.starts_at_text || replay.startsAtText || ''),
            String(replay.teacher || ''),
            JSON.stringify(replay.artifacts || {}),
            JSON.stringify(replay.runtime || {}),
            at,
            at
          )
        }
        return { inserted, existing }
      })
    },

    getTask(replayKey) {
      return hydrate(statements.findByReplayKey.get(String(replayKey)))
    },

    listTasks({ stage = null, limit = 100 } = {}) {
      return statements.listTasks.all(stage, stage, limit).map(hydrate)
    },

    /**
     * 领取一个可执行任务。租约未过期时不会被别人抢走；
     * 过期租约可被重新领取（进程崩溃后的自愈路径）。
     */
    claimNext({ workerId, leaseSeconds = 900, now } = {}) {
      if (!workerId) throw new Error('领取任务需要 workerId')
      const at = nowIso(now)
      const leaseUntil = new Date(new Date(at).getTime() + leaseSeconds * 1000).toISOString()
      return transaction(() => {
        const candidate = hydrate(
          statements.selectActionable.get(JSON.stringify(ACTIONABLE_STAGES), at, at)
        )
        if (!candidate) return null
        const result = statements.claim.run(workerId, leaseUntil, at, at, candidate.id, at)
        if (result.changes === 0) return null
        return this.getTask(candidate.replay_key)
      })
    },

    heartbeat({ id, workerId, leaseSeconds = 900, now } = {}) {
      const at = nowIso(now)
      const leaseUntil = new Date(new Date(at).getTime() + leaseSeconds * 1000).toISOString()
      const result = statements.heartbeat.run(leaseUntil, at, at, id, workerId)
      return result.changes > 0
    },

    /** 记录阶段推进。lease 在这一步释放，下一次领取从新阶段继续。 */
    reportStage({ id, stage, message = '', data = {}, error = '', nextAttemptAt = null, now } = {}) {
      assertStage(stage)
      const at = nowIso(now)
      return transaction(() => {
        const current = hydrate(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
        if (!current) throw new Error(`任务不存在：${id}`)
        statements.updateStage.run(
          stage,
          String(error || ''),
          JSON.stringify({ ...current.artifacts, ...(data.artifacts || {}) }),
          JSON.stringify({ ...current.runtime, ...(data.runtime || {}) }),
          nextAttemptAt,
          at,
          id
        )
        statements.insertEvent.run(id, at, stage, String(message || ''), JSON.stringify(data.meta || {}))
        return this.getTask(current.replay_key)
      })
    },

    events(taskId) {
      return statements.listEvents.all(taskId)
    },

    /** 入队一条推送。同一 dedupe_key 只会存在一条，重复入队静默忽略。 */
    enqueueDelivery({ dedupeKey, purpose, bodyText, objectUrl = '', scheduledFor, now } = {}) {
      if (!dedupeKey || !purpose || !bodyText) throw new Error('推送需要 dedupeKey、purpose 与 bodyText')
      const at = nowIso(now)
      const result = statements.insertDelivery.run(
        String(dedupeKey), String(purpose), String(bodyText), String(objectUrl),
        nowIso(scheduledFor ?? now), at, at
      )
      return { inserted: result.changes > 0, delivery: statements.findDelivery.get(String(dedupeKey)) }
    },

    claimDelivery({ workerId, now } = {}) {
      const at = nowIso(now)
      return transaction(() => {
        const candidate = statements.selectDelivery.get(at)
        if (!candidate) return null
        const result = statements.claimDelivery.run(at, String(workerId || ''), at, candidate.id)
        if (result.changes === 0) return null
        return statements.findDelivery.get(candidate.dedupe_key)
      })
    },

    ackDelivery({ id, status, externalId = '', error = '', now } = {}) {
      const at = nowIso(now)
      const sentAt = status === 'sent' ? at : null
      const result = statements.ackDelivery.run(String(status), String(externalId), String(error), sentAt, at, id)
      return result.changes > 0
    },

    countTasks() {
      return db.prepare('SELECT stage, COUNT(*) AS n FROM tasks GROUP BY stage ORDER BY stage').all()
    },

    close() {
      db.close()
    }
  }
}
