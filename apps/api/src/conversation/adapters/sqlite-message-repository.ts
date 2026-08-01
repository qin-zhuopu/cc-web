// apps/api/src/conversation/adapters/sqlite-message-repository.ts
// MessageRepository 出站端口的 SQLite 适配器（epic-c1-6 / c1-6-3）。
// 读写 messages 表；content 经 core encode/decodeContent、token_usage JSON、stream_status 字面量。
//
// 边界：本文件在 apps/api（适配器层），可 import better-sqlite3；packages/core 绝不出现。
// import 风格：核心契约 import type + 值函数（encode/decodeContent）普通 import；相对无（仅包导入）。
//
// 【编解码】
//   - content：TEXT 存 core.encodeContent(content) 的 JSON；读回 core.decodeContent（永不抛，脏输入降级）。
//   - token_usage：无值时列为 NULL，读回 undefined——严禁落假 0（AC-10 反假数据）。有值存 JSON.stringify。
//   - stream_status/role：字符串字面量，直存直读。
//   - is_heartbeat_ack：SQLite 无 bool，用 INTEGER 0/1 编解码。
// 【分页】listBySession 用 rowid 作稳定游标：beforeRowId 有值则只取更早行；limit 有值则限量。
//   端口约定「按 createdAt/rowid 升序」的最终排序由用例层保证，此处按 rowid DESC 取「最新一页」再由用例整理。
import type BetterSqlite3 from 'better-sqlite3';
import {
  encodeContent,
  decodeContent,
  type Message,
  type MessageId,
  type MessageRole,
  type MessageContent,
  type MessageRepository,
  type StreamStatus,
  type TokenUsage,
  type SessionId,
  type HistoryQuery,
} from '@codepilot/core';

/** messages 表的行形状（列名 snake_case，与 init-db.ts DDL 对齐）。 */
interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly role: string;
  readonly content: string;
  readonly created_at: number;
  readonly stream_status: string;
  readonly token_usage: string | null;
  readonly is_heartbeat_ack: number;
  readonly task_run_id: string | null;
}

/** 行 → 领域实体。token_usage NULL → undefined（不落假 0）；content 经 decodeContent 永不抛。 */
function rowToMessage(row: MessageRow): Message {
  const content: MessageContent = decodeContent(row.content);
  const base = {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content,
    createdAt: row.created_at,
    streamStatus: row.stream_status as StreamStatus,
    isHeartbeatAck: row.is_heartbeat_ack !== 0,
  };
  // 可选字段：仅在有值时挂上，保持「未记录 = undefined」语义。
  const tokenUsage =
    row.token_usage === null
      ? undefined
      : (JSON.parse(row.token_usage) as TokenUsage);
  const taskRunId = row.task_run_id === null ? undefined : row.task_run_id;
  return {
    ...base,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(taskRunId === undefined ? {} : { taskRunId }),
  };
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  async listBySession(query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    // rowid 游标分页：beforeRowId 限定更早行；limit 限量。默认取最新页（rowid DESC）。
    // 最终升序由用例层（GetSessionHistoryService.getHistory）排序保证；此处只负责取对的一页。
    const clauses: string[] = ['session_id = ?'];
    const params: Array<string | number> = [query.sessionId];
    if (query.beforeRowId !== undefined) {
      clauses.push('rowid < ?');
      params.push(query.beforeRowId);
    }
    const where = clauses.join(' AND ');
    const limitSql = query.limit !== undefined ? ' LIMIT ?' : '';
    if (query.limit !== undefined) {
      params.push(query.limit);
    }
    const rows = this.db
      .prepare(
        `SELECT rowid AS _rowid, * FROM messages WHERE ${where} ORDER BY rowid DESC${limitSql}`,
      )
      .all(...params) as MessageRow[];
    return rows.map(rowToMessage);
  }

  async getById(id: MessageId): Promise<Message | undefined> {
    const row = this.db
      .prepare('SELECT rowid AS _rowid, * FROM messages WHERE id = ?')
      .get(id) as MessageRow | undefined;
    return row === undefined ? undefined : rowToMessage(row);
  }

  async append(message: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, session_id, role, content, created_at, stream_status, token_usage, is_heartbeat_ack, task_run_id)
         VALUES (@id, @session_id, @role, @content, @created_at, @stream_status, @token_usage, @is_heartbeat_ack, @task_run_id)`,
      )
      .run({
        id: message.id,
        session_id: message.sessionId,
        role: message.role,
        content: encodeContent(message.content),
        created_at: message.createdAt,
        stream_status: message.streamStatus,
        // 无 tokenUsage → NULL（不落假 0）。
        token_usage:
          message.tokenUsage === undefined
            ? null
            : JSON.stringify(message.tokenUsage),
        is_heartbeat_ack: message.isHeartbeatAck ? 1 : 0,
        task_run_id: message.taskRunId ?? null,
      });
  }

  async updateStreamStatus(
    id: MessageId,
    status: StreamStatus,
    tokenUsage?: TokenUsage,
  ): Promise<void> {
    // tokenUsage 为收尾时可选投影：缺省则不更新用量列（不落假 0）。缺失 id：UPDATE 0 行幂等 no-op。
    if (tokenUsage === undefined) {
      this.db
        .prepare('UPDATE messages SET stream_status = ? WHERE id = ?')
        .run(status, id);
      return;
    }
    this.db
      .prepare('UPDATE messages SET stream_status = ?, token_usage = ? WHERE id = ?')
      .run(status, JSON.stringify(tokenUsage), id);
  }

  async deleteBySession(sessionId: SessionId): Promise<number> {
    const info = this.db
      .prepare('DELETE FROM messages WHERE session_id = ?')
      .run(sessionId);
    return info.changes;
  }
}
