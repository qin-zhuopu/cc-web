// agent-runtime/ports/driven/conversation-ports.ts
// C2 · AgentRuntime 出站端口：C1 用例端口的本地 import type 别名。
// 对齐 architecture §5.2。零框架 import；仅类型转出，无实现。
//
// 【依赖纪律 · 单向 import type · 务必分清】
// - 契约来源：C1「对外提供端口」；引用图 C1 会话用例 ← C2（C2 是 C1 用例的消费者）。
// - C2 **只经 C1 用例**读写会话 / 消息（读历史投影、追加消息、推进持久 StreamStatus），
//   **不持有 Repository 直写路径**（对齐 C1 AC-13）。
// - C2 只 import type 引用 C1 用例端口**类型**，绝不 import C1 运行实现。实现由 C1 的
//   ConversationModule 提供并经 NestJS DI 注入；C1↔C2 环在 Module 层用 forwardRef 解（本 epic 不碰）。
//
// 【铁律】核心零框架：不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process；类型-only import 用 import type + .js 扩展名。
//
// 【本故事（c2-1-6）范围】只转出 C1 用例端口类型 + 给 PromptMessage 投影形状，不接 DI、不实现用例。

import type { AppendMessageUseCase } from '../../../conversation/ports/driving/append-message-usecase.js';
import type { GetSessionHistoryUseCase } from '../../../conversation/ports/driving/get-session-history-usecase.js';
import type { Message } from '../../../conversation/domain/message/message.js';

// C2 仅引用 C1 定义的用例端口类型；实现由 C1 Module 提供并注入（forwardRef 解环）。
export type { AppendMessageUseCase, GetSessionHistoryUseCase };

/**
 * PromptMessage —— 喂给模型的历史投影消息（C2 侧本地别名）。
 *
 * C1.GetSessionHistoryUseCase.getPromptView 产出「真正进入上下文的消息」（已剔除
 * isHeartbeatAck / taskRunId 关联的 render-only 标记）。C2 把该投影作为 RuntimeRunRequest.promptView
 * 传给适配器。此处别名到 C1 的 Message 领域实体类型（只 import type，不引用 C1 实现），
 * 以保持与 getPromptView 返回元素类型一致。
 */
export type PromptMessage = Message;
