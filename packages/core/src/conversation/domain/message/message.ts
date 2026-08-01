// conversation/domain/message/message.ts
// C1 Conversation 领域边界：Message 实体 + MessageRole + MessageId。
// 对齐 architecture §3.3。零框架 import，不可变领域模型（字段全 readonly）。

import type { StreamStatus } from './stream-status.js';
import type { MessageContent } from './message-content.js';
import type { TokenUsage } from './token-usage.js';
import type { SessionId } from '../session/chat-session.js';

/**
 * 消息标识。由 SK.IdGenerator 生成，C1 领域不自造 id。
 */
export type MessageId = string;

/**
 * 消息角色。对齐 architecture §3.3（权威定义仅 user | assistant）。
 *
 * 与波次1 的 StreamStatus / TitleOrigin 一致，采用字符串字面量联合而非 TS enum：
 * 核心包铁律偏好零运行时负担的纯类型，且字面量在持久化/序列化边界更直接。
 *
 * - user：用户发出的消息。
 * - assistant：AI 助手生成的消息。
 */
export type MessageRole = 'user' | 'assistant';

/**
 * Message：一条持久转录消息行（不可变领域实体）。
 *
 * 【投影字段纪律】
 * - tokenUsage：C2 落库时提供的只读投影，无值 = 未记录，一律 undefined，严禁落假 0（AC-10）。
 * - isHeartbeatAck / taskRunId：纯渲染侧标记，不入 prompt 投影。
 * - streamStatus：持久生命周期（见 stream-status.ts），非 assistant 恒 completed；
 *   它绝非 C2 的实时流式相位，C1 只记持久事实。
 */
export interface Message {
  /** 消息标识，来自 SK.IdGenerator。 */
  readonly id: MessageId;
  /** 所属会话标识（会话归属 FK）。对齐 architecture §3.3。 */
  readonly sessionId: SessionId;
  /** 消息角色：user | assistant。 */
  readonly role: MessageRole;
  /** 消息内容（占位类型，编解码属 c1-2）。 */
  readonly content: MessageContent;
  /** 创建时刻，epoch 毫秒，来自 SK.Clock。 */
  readonly createdAt: number;
  /** 持久生命周期状态；非 assistant 恒 completed。 */
  readonly streamStatus: StreamStatus;
  /** Token 用量投影；无值=未记录，不显 0（AC-10）。 */
  readonly tokenUsage?: TokenUsage;
  /** 心跳应答渲染标记，不入 prompt 投影。 */
  readonly isHeartbeatAck: boolean;
  /** 渲染侧 join 标记（关联 task run），不入 prompt 投影；无值 undefined。 */
  readonly taskRunId?: string;
}
