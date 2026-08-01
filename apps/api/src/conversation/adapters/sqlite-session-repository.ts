// apps/api/src/conversation/adapters/sqlite-session-repository.ts
// SessionRepository 出站端口的 SQLite 适配器（epic-c1-6 / c1-6-3）。
// 读写 chat_sessions 的会话本体列；运行时/Provider 内部寄存列不由本适配器负责（字段归属铁律）。
//
// 边界：本文件在 apps/api（适配器层），可 import better-sqlite3；packages/core 绝不出现。
// import 风格：核心契约一律 import type（verbatimModuleSyntax）；相对 import 带 .js（NodeNext）。
//
// 【编解码】title_origin/status/mode/source 均为字符串字面量，直存直读；
//   时间列 INTEGER 存 epoch 毫秒，与 ChatSession.createdAt/updatedAt(number) 一一对应。
// 【listAll 契约】不 filter/sort/limit——过滤/排序/limit 的唯一权威在用例层
//   （ManageSessionService.list），适配器只取全量本体，否则双重处理会丢 top-N。
// 【幂等 no-op】touch/setTitle/setStatus/delete 缺失 id 时不抛，靠 UPDATE/DELETE 影响 0 行天然实现。
import type BetterSqlite3 from 'better-sqlite3';
import type {
  ChatSession,
  SessionId,
  SessionStatus,
  SessionMode,
  SessionSource,
  SessionRepository,
  TitleOrigin,
} from '@codepilot/core';

/** chat_sessions 表的行形状（列名 snake_case，与 init-db.ts 的 DDL 对齐）。 */
interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly title_origin: string;
  readonly status: string;
  readonly mode: string;
  readonly source: string;
  readonly working_directory: string;
  readonly project_name: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** 行 → 领域实体。字符串字面量列直接窄化（写入侧只可能写入合法字面量，读回即合法）。 */
function rowToSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    titleOrigin: row.title_origin as TitleOrigin,
    status: row.status as SessionStatus,
    mode: row.mode as SessionMode,
    source: row.source as SessionSource,
    workingDirectory: row.working_directory,
    projectName: row.project_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  async listAll(): Promise<ReadonlyArray<ChatSession>> {
    // 契约：取全量本体，不 filter/sort/limit（权威在用例层）。
    const rows = this.db
      .prepare('SELECT * FROM chat_sessions')
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  async getById(id: SessionId): Promise<ChatSession | undefined> {
    const row = this.db
      .prepare('SELECT * FROM chat_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row === undefined ? undefined : rowToSession(row);
  }

  async save(session: ChatSession): Promise<void> {
    // upsert 会话本体字段：主键冲突则整行覆盖本体列（不触碰寄存列——本表本 epic 也没建寄存列）。
    this.db
      .prepare(
        `INSERT INTO chat_sessions
           (id, title, title_origin, status, mode, source, working_directory, project_name, created_at, updated_at)
         VALUES (@id, @title, @title_origin, @status, @mode, @source, @working_directory, @project_name, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           title_origin = excluded.title_origin,
           status = excluded.status,
           mode = excluded.mode,
           source = excluded.source,
           working_directory = excluded.working_directory,
           project_name = excluded.project_name,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: session.id,
        title: session.title,
        title_origin: session.titleOrigin,
        status: session.status,
        mode: session.mode,
        source: session.source,
        working_directory: session.workingDirectory,
        project_name: session.projectName,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
      });
  }

  async touch(id: SessionId, updatedAt: number): Promise<void> {
    // 缺失 id：UPDATE 影响 0 行，天然幂等 no-op，不抛。
    this.db
      .prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?')
      .run(updatedAt, id);
  }

  async setTitle(id: SessionId, title: string, origin: TitleOrigin): Promise<void> {
    this.db
      .prepare('UPDATE chat_sessions SET title = ?, title_origin = ? WHERE id = ?')
      .run(title, origin, id);
  }

  async setStatus(id: SessionId, status: SessionStatus): Promise<void> {
    this.db
      .prepare('UPDATE chat_sessions SET status = ? WHERE id = ?')
      .run(status, id);
  }

  async delete(id: SessionId): Promise<void> {
    // 级联删消息由 messages 表的 FK ON DELETE CASCADE + PRAGMA foreign_keys=ON 保证。
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  }
}
