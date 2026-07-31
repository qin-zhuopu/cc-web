// conversation/ports/driving/append-message-usecase.ts
// C1 驱动端口：追加消息用例入口（仅签名骨架）。
// 对齐 architecture §4.3。零框架 import；实现属 c1-5。

import type { SessionId } from '../../domain/session/chat-session.js';
import type { Message, MessageId, MessageRole } from '../../domain/message/message.js';
import type { MessageContent } from '../../domain/message/message-content.js';
import type { StreamStatus } from '../../domain/message/stream-status.js';
import type { TokenUsage } from '../../domain/message/token-usage.js';

/**
 * 追加消息入参。
 * 【反假数据】可选字段无值保持 undefined（tokenUsage/taskRunId），用例不预填假 0/假空串。
 */
export interface AppendMessageInput {
  /** 目标会话 id。 */
  readonly sessionId: SessionId;
  /** 消息角色：user | assistant | system。 */
  readonly role: MessageRole;
  /** 消息内容值对象。 */
  readonly content: MessageContent;
  /** 持久生命周期初值。assistant 首次流式可传 'streaming'；非 assistant 恒 completed。 */
  readonly streamStatus?: StreamStatus;
  /** C2 提供的 token 用量投影，可缺省。 */
  readonly tokenUsage?: TokenUsage;
  /** 心跳应答渲染标记。缺省 false。 */
  readonly isHeartbeatAck?: boolean;
  /** 渲染侧 join 标记（关联 task run），不入 prompt 投影。 */
  readonly taskRunId?: string;
}

/**
 * AppendMessageUseCase：追加消息 + 推进持久生命周期驱动端口（对外提供）。
 *
 * 仅签名骨架，无实现体——追加并 touch 会话的编排逻辑落地属 c1-5。
 */
export interface AppendMessageUseCase {
  /**
   * 追加消息（id←IdGenerator、createdAt←Clock）并 touch 会话 updatedAt
   * （同一逻辑操作、同一 now，FR-4.1 / NFR-7 / AC-7）。
   */
  append(input: AppendMessageInput): Promise<Message>;
  /**
   * 推进 assistant 消息的持久生命周期：streaming → completed/interrupted/error（FR-4.2）。
   * tokenUsage 为收尾时的可选投影，缺省则不更新用量（不落假 0）。
   */
  updateStreamStatus(
    messageId: MessageId,
    status: StreamStatus,
    tokenUsage?: TokenUsage,
  ): Promise<void>;
}
