// conversation/ports/driven/message-repository.ts
// C1 被驱动端口：消息持久化契约（出站端口，仅签名）。
// 对齐 architecture §5.2。零框架 import；实现（SqliteMessageRepository）在 apps/api 适配器层。

import type { SessionId } from '../../domain/session/chat-session.js';
import type { Message, MessageId } from '../../domain/message/message.js';
import type { StreamStatus } from '../../domain/message/stream-status.js';
import type { TokenUsage } from '../../domain/message/token-usage.js';
import type { HistoryQuery } from '../driving/get-session-history-usecase.js';

/**
 * MessageRepository：消息出站持久化端口。
 *
 * 仅接口签名，无实现——由适配器实现（content ↔ MessageContent 编解码、
 * token_usage JSON ↔ TokenUsage、stream_status ↔ StreamStatus、rowid 提供分页边界）。
 */
export interface MessageRepository {
  /** 按会话列消息（应用 HistoryQuery 的 limit/beforeRowId 分页）。 */
  listBySession(query: HistoryQuery): Promise<ReadonlyArray<Message>>;
  /**
   * 按 id 取单条消息；不存在返回 undefined。
   *
   * 供 updateStreamStatus 在推进前读回现值以经 canTransition 守卫
   * （AppendMessageUseCase.updateStreamStatus 仅接收 messageId，无 sessionId，
   * 故生命周期守卫需要一条按 id 的读回路径；对齐 c1-5 SPEC CAP-2「先读回消息现有 streamStatus」）。
   */
  getById(id: MessageId): Promise<Message | undefined>;
  /** 追加一条消息行。 */
  append(message: Message): Promise<void>;
  /**
   * 推进持久生命周期；tokenUsage 为收尾时可选投影，缺省则不更新用量（不落假 0）。
   */
  updateStreamStatus(
    id: MessageId,
    status: StreamStatus,
    tokenUsage?: TokenUsage,
  ): Promise<void>;
  /** 按会话删除全部消息，返回删除条数（供级联/清理）。 */
  deleteBySession(sessionId: SessionId): Promise<number>;
}
