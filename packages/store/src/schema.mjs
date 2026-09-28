/**
 * 账本 schema 与阶段定义。
 *
 * 阶段名沿用旧系统的语义，便于对照与迁移；新增的发布、推送阶段是旧系统里
 * 散落在 message_deliveries 与 content 表的部分。
 */
export const STAGES = [
  'discovered',
  'queued',
  'downloading',
  'downloaded',
  'transcribing',
  'transcript_ready',
  'writing',
  'notes_ready',
  'publishing',
  'published',
  'notifying',
  'completed',
  'failed',
  'needs_attention'
]

/**
 * 需要 worker 动手的阶段。
 *
 * 注意 `published` 与 `notifying` **不在**这里：发布完成后任务本身就没有后续工序了，
 * 通知走的是独立的 deliveries 队列（已发送/待重试由它自己记账）。
 * 把它们算作可领取会让 worker 反复领到同一条已完成的任务而空转。
 */
export const ACTIONABLE_STAGES = [
  'discovered',
  'queued',
  'downloading',
  'downloaded',
  'transcribing',
  'transcript_ready',
  'building_textpack',
  'writing',
  'notes_ready',
  'publishing'
]

export const TERMINAL_STAGES = ['completed', 'failed', 'needs_attention']

export const DELIVERY_STATUSES = ['pending', 'claimed', 'sent', 'failed', 'cancelled']

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_key       TEXT    NOT NULL UNIQUE,
  course_key       TEXT    NOT NULL,
  course_name      TEXT    NOT NULL DEFAULT '',
  title            TEXT    NOT NULL DEFAULT '',
  starts_at_text   TEXT    NOT NULL DEFAULT '',
  teacher          TEXT    NOT NULL DEFAULT '',
  stage            TEXT    NOT NULL DEFAULT 'discovered',
  attempts         INTEGER NOT NULL DEFAULT 0,
  artifacts        TEXT    NOT NULL DEFAULT '{}',
  runtime          TEXT    NOT NULL DEFAULT '{}',
  last_error       TEXT    NOT NULL DEFAULT '',
  next_attempt_at  TEXT,
  claimed_by       TEXT    NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  heartbeat_at     TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_actionable
  ON tasks (stage, next_attempt_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS task_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at       TEXT    NOT NULL,
  stage    TEXT    NOT NULL,
  message  TEXT    NOT NULL DEFAULT '',
  data     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, id);

CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT    NOT NULL UNIQUE,
  purpose       TEXT    NOT NULL,
  body_text     TEXT    NOT NULL,
  object_url    TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  external_id   TEXT    NOT NULL DEFAULT '',
  last_error    TEXT    NOT NULL DEFAULT '',
  scheduled_for TEXT    NOT NULL,
  claimed_at    TEXT,
  claimed_by    TEXT    NOT NULL DEFAULT '',
  -- 投递也有租约：发送进程崩了、整机重启了，这条投递不能永远卡在 claimed 状态
  --（那等于通知静默消失）。过期之后可以被重新领取。
  lease_expires_at TEXT,
  sent_at       TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_pending
  ON deliveries (status, scheduled_for);
`
// 注意：不要在这里建 idx_deliveries_lease——老库还没有 lease_expires_at 这一列，
// CREATE INDEX 会先于迁移执行并报 "no such column"。这个索引放在迁移里建，
// 新库与老库都会走到同一步。

/**
 * 迁移：老账本只有 CREATE TABLE IF NOT EXISTS，新增列不会自己出现。
 *
 * 用 SQLite 自带的 PRAGMA user_version 记版本，按序补。每一步都在事务里做，
 * 失败就整体回滚——宁可停在一个已知的旧版本，也不要半个迁移。
 * 新建的库因为 SCHEMA_SQL 里已经带了这一列，同一步会检测到并跳过（幂等）。
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'deliveries.lease_expires_at（投递租约）',
    up: db => {
      const columns = db.prepare('PRAGMA table_info(deliveries)').all().map(row => row.name)
      if (!columns.includes('lease_expires_at')) db.exec('ALTER TABLE deliveries ADD COLUMN lease_expires_at TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS idx_deliveries_lease ON deliveries (status, lease_expires_at)')
    }
  }
]

export function migrate(db, log = () => {}) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0)
  const pending = MIGRATIONS.filter(migration => migration.version > current)
  if (!pending.length) return { from: current, to: current, applied: [] }
  const applied = []
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      // user_version 不接受参数绑定，只能拼字符串——版本号来自本文件的常量，不是外部输入
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`)
      db.exec('COMMIT')
      applied.push(migration.name)
      log(`账本迁移：${migration.version} · ${migration.name}`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`账本迁移失败（${migration.name}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { from: current, to: pending.at(-1).version, applied }
}

export function assertStage(stage) {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`)
  return stage
}
