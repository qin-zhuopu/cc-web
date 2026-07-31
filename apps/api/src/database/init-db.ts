// apps/api/src/database/init-db.ts
// C1 建表逻辑（epic-c1-6）。只建 C1 会话本体列 + 消息列，不建 C2/C7/C5 寄存列
// （字段归属铁律见 packages/core/.../chat-session.ts §3.1；各领域边界自己 ALTER TABLE 补列）。
//
// 【时间列】统一用 INTEGER 存 epoch 毫秒，对齐 SK.Clock.now():number 与 ChatSession.createdAt/updatedAt。
//   绝不复刻被参考项目 CodePilot 的 `TEXT` 时间列（那会引入字符串↔number 的编解码歧义）。
// 【content / token_usage】用 TEXT 存 JSON：content 经 core 的 encode/decodeContent 编解码；
//   token_usage 无上报时为 NULL（读回 undefined），严禁落假 0（AC-10 反假数据）。
// 【级联】messages.session_id 外键 ON DELETE CASCADE，删会话级联删消息（SessionRepository.delete 契约）。
// 【PRAGMA】WAL 提升并发读写；foreign_keys=ON 让级联与外键约束生效（SQLite 默认关闭）。

import type BetterSqlite3 from 'better-sqlite3';

/** C1 会话本体表 + 消息表的建表 DDL（幂等：IF NOT EXISTS）。 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  title_origin      TEXT NOT NULL,
  status            TEXT NOT NULL,
  mode              TEXT NOT NULL,
  source            TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  project_name      TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  stream_status   TEXT NOT NULL,
  token_usage     TEXT,
  is_heartbeat_ack INTEGER NOT NULL DEFAULT 0,
  task_run_id     TEXT,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`;

/**
 * 初始化数据库连接：设置 PRAGMA 并建表（幂等）。
 *
 * @param db 已打开的 better-sqlite3 连接（`:memory:` 供测试 / 文件路径供运行）。
 * @returns 同一连接（便于链式绑定到 DI token）。
 */
export function initDatabase(db: BetterSqlite3.Database): BetterSqlite3.Database {
  // WAL：更好的并发；foreign_keys：让 ON DELETE CASCADE 与外键约束生效（SQLite 默认关闭，须显式开）。
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_DDL);
  return db;
}
