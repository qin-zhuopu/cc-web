// conversation/ports/driven/session-repository.ts
// C1 被驱动端口：会话本体持久化契约（出站端口，仅签名）。
// 对齐 architecture §5.1。零框架 import；实现（SqliteSessionRepository）在 apps/api 适配器层。
//
// 【字段归属纪律】本端口只投影会话本体（ChatSession 的 10 字段），
// 不为运行时/Provider/Codex 寄存列负责——那些读写归各自领域边界经其端口。

import type {
  ChatSession,
  SessionId,
  SessionStatus,
} from '../../domain/session/chat-session.js';
import type { TitleOrigin } from '../../domain/session/title-origin.js';
import type { ListSessionsQuery } from '../driving/manage-session-usecase.js';

/**
 * SessionRepository：会话本体出站持久化端口。
 *
 * 仅接口签名，无实现——由适配器实现。时间戳为 epoch 毫秒（来自 SK.Clock），
 * 与 ChatSession.createdAt/updatedAt 对齐。
 */
export interface SessionRepository {
  /**
   * 列出全部会话本体（不过滤、不排序、不 limit）。
   * 【契约】过滤/排序/limit 的唯一权威在用例层（ManageSessionService.list），
   * 适配器只负责取全量本体，不得自行 filter/sort/limit——否则与用例双重处理会丢 top-N。
   */
  listAll(): Promise<ReadonlyArray<ChatSession>>;
  /** 按 id 取会话本体；不存在返回 undefined。 */
  getById(id: SessionId): Promise<ChatSession | undefined>;
  /** upsert 会话本体字段。 */
  save(session: ChatSession): Promise<void>;
  /** 仅更新 updatedAt（epoch 毫秒）。缺失 id：幂等 no-op，不抛。 */
  touch(id: SessionId, updatedAt: number): Promise<void>;
  /** 写标题与来源（title_origin ↔ TitleOrigin）。缺失 id：幂等 no-op，不抛。 */
  setTitle(id: SessionId, title: string, origin: TitleOrigin): Promise<void>;
  /** 写会话状态。缺失 id：幂等 no-op，不抛。 */
  setStatus(id: SessionId, status: SessionStatus): Promise<void>;
  /** 删除会话（级联删消息由适配器/DB FK 保证）。缺失 id：幂等 no-op，不抛。 */
  delete(id: SessionId): Promise<void>;
}
