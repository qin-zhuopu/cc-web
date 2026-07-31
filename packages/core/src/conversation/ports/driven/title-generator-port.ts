// conversation/ports/driven/title-generator-port.ts
// C1 被驱动端口：AI 标题生成端口（C1 消费视角的类型契约）。
// 对齐 architecture §5.3 / §8。零框架 import。
//
// 【权威归属与依赖纪律 · 务必分清】
// - 本端口的「权威定义与实现」在 C2（AgentRuntime）。此处仅是 C1 侧消费所需的
//   最小类型契约（C1 视角的形状），供 C1 用例 import type 引用。
// - C1 绝不 import C2 的任何运行实现，绝不反向依赖 C2，绝不自己拼 AI 标题提示词、
//   绝不直接调模型——生成能力锁在 C2.TitleGenerator 之后。
// - 接线（把 C2 的实现注入 C1 用例）在 NestJS Module 层用 forwardRef 完成；
//   核心包之间只单向 import type 接口，无实现级环。
// - C1 单测用假实现（FakeTitleGenerator）替身即可，不触碰 C2。

import type { SessionId } from '../../domain/session/chat-session.js';
import type { MessageRole } from '../../domain/message/message.js';

/**
 * 标题生成入参。recentMessages 由 C1 从历史投影出的纯文本片段
 * （C1 只喂投影文本，不暴露富内容块，也不承担提示词拼装）。
 */
export interface TitleGenerationInput {
  /** 目标会话 id。 */
  readonly sessionId: SessionId;
  /** 近期消息的纯文本投影（由 C1 从 prompt 视图投影）。 */
  readonly recentMessages: ReadonlyArray<{
    readonly role: MessageRole;
    readonly text: string;
  }>;
}

/**
 * TitleGeneratorPort：AI 标题生成端口（C1 消费视角）。
 *
 * 权威定义与实现在 C2；C1 仅按此形状 import type 引用。
 * generateTitle 失败可抛，由 C1 用例就地降级处理（保留原标题、不写库、不外抛，FR-2.4）。
 */
export interface TitleGeneratorPort {
  /** 返回 AI 生成的标题字符串。 */
  generateTitle(input: TitleGenerationInput): Promise<string>;
}
