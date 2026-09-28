import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'


import { ACTIONABLE_STAGES, SCHEMA_SQL, assertStage, migrate } from './schema.mjs'

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
  if (resolved !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    // WAL 之下 synchronous=NORMAL 是安全且明显更快的选择：掉电最多丢最后几个事务，
    // 不会损坏数据库（完整模式每个事务都要 fsync，而账本是高频小写入）
    db.exec('PRAGMA synchronous = NORMAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  /**
   * 忙等：worker、站点、管理台 CLI 会同时读写同一个账本文件。
   * 没有 busy_timeout 时，撞上别人持有写锁会直接抛 SQLITE_BUSY——记一次"失败"，
   * 对账本这种"改一行"的操作是完全不必要的失败。等 5 秒再放弃。
   */
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  migrate(db, options.log || (() => {}))

  const statements = {
    insertTask: db.prepare(`
      INSERT INTO tasks (replay_key, course_key, course_name, title, starts_at_text, teacher,
                         stage, artifacts, runtime, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)
      ON CONFLICT (replay_key) DO UPDATE SET
        -- 空值只补不覆盖：一次只带了部分字段的重复登记，不得把已存的标题/教师清空
        course_name = COALESCE(NULLIF(excluded.course_name, ''), tasks.course_name),
        title = COALESCE(NULLIF(excluded.title, ''), tasks.title),
        starts_at_text = COALESCE(NULLIF(excluded.starts_at_text, ''), tasks.starts_at_text),
        teacher = COALESCE(NULLIF(excluded.teacher, ''), tasks.teacher),
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
      WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR claimed_by = ?)
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
    countDeliveries: db.prepare('SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status'),
    listDeliveries: db.prepare('SELECT * FROM deliveries WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?'),
    // deliveries 表用的是 scheduled_for（投递行没有 next_attempt_at 那一列）
    reviveFailedDeliveries: db.prepare(`
      UPDATE deliveries SET status = 'pending', attempts = 0, last_error = '',
        scheduled_for = ?, claimed_by = '', claimed_at = NULL, updated_at = ?
      WHERE status = 'failed'
    `),
    resetAttempts: db.prepare('UPDATE tasks SET attempts = 0 WHERE id = ?'),
    resetTask: db.prepare(`
      UPDATE tasks
      SET stage = ?, attempts = 0, last_error = '', next_attempt_at = NULL,
          claimed_by = '', lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
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
    /**
     * 可领取的投递 = 到点的 pending，**加上租约已过期的 claimed**。
     *
     * 后半句是崩溃自愈：发送进程在"领取之后、记录结果之前"挂掉（或整机重启），
     * 那条投递会永远停在 claimed，而它既不在 pending 里、也没有人再去看它——
     * 通知就这么静默消失了。过期可领，配合 attempts 上限，最终要么发出、要么标失败。
     */
    selectDelivery: db.prepare(`
      SELECT * FROM deliveries
      WHERE (status = 'pending' AND scheduled_for <= ?)
         OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      ORDER BY scheduled_for, id
      LIMIT 1
    `),
    claimDelivery: db.prepare(`
      UPDATE deliveries
      SET status = 'claimed', claimed_at = ?, claimed_by = ?, attempts = attempts + 1,
          lease_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND (status = 'pending'
             OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
    `),
    ackDelivery: db.prepare(`
      UPDATE deliveries
      SET status = ?, external_id = ?, last_error = ?, sent_at = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?
    `),
    retryDelivery: db.prepare(`
      UPDATE deliveries
      SET status = 'pending', claimed_at = NULL, claimed_by = '', lease_expires_at = NULL, last_error = ?,
          scheduled_for = COALESCE(?, scheduled_for), updated_at = ?
      WHERE id = ?
    `),
    countStuckDeliveries: db.prepare(`
      SELECT COUNT(*) AS n FROM deliveries
      WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
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

  /** 投递行没有 JSON 字段，但保持与 hydrate 同形（管理台读的时候不用分两种）。 */
  function hydrateDelivery(row) {
    return row ? { ...row } : null
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
        // 新增了哪几条也要报出来：发现新课要提醒用户上传课件，光有计数不够用。
        const created = []
        for (const replay of replays) {
          const replayKey = String(replay.replay_key || replay.replayKey || '').trim()
          const courseKey = String(replay.course_key || replay.courseKey || '').trim()
          if (!replayKey || !courseKey) throw new Error('登记回放需要 replay_key 与 course_key')
          const before = statements.findByReplayKey.get(replayKey)
          if (before) existing += 1
          else {
            inserted += 1
            created.push({
              replayKey,
              courseName: String(replay.course_name || replay.courseName || ''),
              title: String(replay.title || '')
            })
          }
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
        return { inserted, existing, created }
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

    /**
     * 领取一条指定回放。
     *
     * 手动跑单节课时必须能精确指定，不能"领到哪条算哪条"。
     * 语义与 claimNext 一致：仅当阶段可执行且租约空闲时才会成功。
     */
    claimTask({ replayKey, workerId, leaseSeconds = 900, now } = {}) {
      if (!workerId) throw new Error('领取任务需要 workerId')
      const key = String(replayKey || '').trim()
      if (!key) throw new Error('领取任务需要 replayKey')
      const at = nowIso(now)
      const leaseUntil = new Date(new Date(at).getTime() + leaseSeconds * 1000).toISOString()
      return transaction(() => {
        const task = hydrate(statements.findByReplayKey.get(key))
        if (!task) return { claimed: false, reason: 'not_found', task: null }
        if (!ACTIONABLE_STAGES.includes(task.stage)) {
          return { claimed: false, reason: `terminal:${task.stage}`, task }
        }
        // 自己已经持有的租约：续租而不是拒绝。
        // 编排循环会先领取再调用各阶段命令，命令内部还会再领一次；如果这里把
        // 「自己持有」也当成冲突，链路在第一步就会失败。
        if (task.lease_expires_at && task.lease_expires_at > at && task.claimed_by !== workerId) {
          return { claimed: false, reason: 'leased', task }
        }
        if (task.next_attempt_at && task.next_attempt_at > at) {
          return { claimed: false, reason: 'backoff', task }
        }
        const result = statements.claim.run(workerId, leaseUntil, at, at, task.id, at, workerId)
        if (result.changes === 0) return { claimed: false, reason: 'leased', task }
        return { claimed: true, reason: 'claimed', task: this.getTask(key) }
      })
    },

    /**
     * 把一个停下不动的任务放回可领取状态。
     *
     * 用于 needs_attention 之后的人工恢复：光把阶段改成 needs_attention 而没有办法
     * 把它弄回来，等于把课次永久钉死——那比继续重试更糟。
     */
    resetTask({ replayKey, stage = '', now } = {}) {
      const key = String(replayKey || '').trim()
      if (!key) throw new Error('resetTask 需要 replayKey')
      const at = nowIso(now)
      return transaction(() => {
        const current = statements.findByReplayKey.get(key)
        if (!current) throw new Error(`任务不存在：${key}`)
        const target = stage || current.stage
        assertStage(target)
        statements.resetTask.run(target, at, current.id)
        statements.insertEvent.run(current.id, at, target, '人工重置：清空失败计数，等待重新领取', '{}')
        return this.getTask(key)
      })
    },

    heartbeat({ id, workerId, leaseSeconds = 900, now } = {}) {
      const at = nowIso(now)
      const leaseUntil = new Date(new Date(at).getTime() + leaseSeconds * 1000).toISOString()
      const result = statements.heartbeat.run(leaseUntil, at, at, id, workerId)
      return result.changes > 0
    },

    /**
     * 记录阶段推进。lease 在这一步释放，下一次领取从新阶段继续。
     *
     * **成功即清零 attempts**：这个计数器的语义是"当前阶段连续失败了几次"，
     * 而不是"这个课次一生失败过几次"。不这样做会出真事：一节在欠费期失败 6 次、
     * 之后正常转录成功的课，attempts 仍停在 6，于是"连续失败到上限就停下"的闸门
     * 会立刻把它误判成"停下等你"——明明已经跑过去了。
     */
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
        // 成功即清零：attempts 的语义是"当前阶段连续失败次数"（见上面的说明）
        if (!error) statements.resetAttempts.run(id)
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

    countDeliveries() {
      return Object.fromEntries(statements.countDeliveries.all().map(row => [row.status, row.n]))
    },

    listDeliveries({ status = null, limit = 50 } = {}) {
      return statements.listDeliveries.all(status, status, Number(limit || 50)).map(hydrateDelivery)
    },

    /** 按幂等键取一条投递（管理台与排障用；找不到返回 null）。 */
    findDelivery(dedupeKey) {
      return hydrateDelivery(statements.findDelivery.get(String(dedupeKey))) || null
    },

    /** 把发失败的通知放回队列重发（人工决定，不自动循环骚扰）。 */
    reviveFailedDeliveries({ now } = {}) {
      const at = nowIso(now)
      const result = statements.reviveFailedDeliveries.run(at, at)
      return { revived: result.changes }
    },

    /**
     * 领取一条待发送的投递。
     *
     * leaseSeconds 默认 10 分钟：正常一次发送是秒级，超时只可能是进程出了问题；
     * 过期后这条投递会被重新领取（见 selectDelivery 的说明），attempts 也会继续累加，
     * 因此"崩一次"不会变成无限重发。
     */
    claimDelivery({ workerId, leaseSeconds = 600, now } = {}) {
      const at = nowIso(now)
      const leaseUntil = new Date(new Date(at).getTime() + leaseSeconds * 1000).toISOString()
      return transaction(() => {
        const candidate = statements.selectDelivery.get(at, at)
        if (!candidate) return null
        const result = statements.claimDelivery.run(at, String(workerId || ''), leaseUntil, at, candidate.id, at)
        if (result.changes === 0) return null
        return statements.findDelivery.get(candidate.dedupe_key)
      })
    },

    /** 卡住的投递（claimed 且租约已过期）：管理台用它回答"是不是有通知发丢了"。 */
    countStuckDeliveries({ now } = {}) {
      return Number(statements.countStuckDeliveries.get(nowIso(now))?.n || 0)
    },

    ackDelivery({ id, status, externalId = '', error = '', now } = {}) {
      const at = nowIso(now)
      const sentAt = status === 'sent' ? at : null
      const result = statements.ackDelivery.run(String(status), String(externalId), String(error), sentAt, at, id)
      return result.changes > 0
    },

    /** 把失败的投递放回队列并推迟重试时间（退避）。次数上限由调用方判断。 */
    retryDelivery({ id, error = '', nextAttemptAt = null, now } = {}) {
      const at = nowIso(now)
      const result = statements.retryDelivery.run(String(error || ''), nextAttemptAt, at, id)
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
