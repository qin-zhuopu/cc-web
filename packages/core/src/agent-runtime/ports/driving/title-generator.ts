// agent-runtime/ports/driving/title-generator.ts
// C2 · AgentRuntime 驱动端口：TitleGenerator（供 C1 消费）。
// 对齐 architecture §4.3。零框架 import；仅接口签名骨架。
//
// 【权威归属与依赖纪律 · 务必分清】
// - 本端口的「权威定义与实现」在 C2（AgentRuntime）。C1 侧另有一份最小消费契约
//   （conversation/ports/driven/title-generator-port.ts），二者形状对齐；C1 只 import type 其本地契约，
//   绝不 import C2 运行实现。接线在 NestJS Module 层用 forwardRef 打破 C1↔C2 环。
// - 契约来源：边界契约「C2 对外提供端口：TitleGenerator（供 C1）」，引用图 C2.TitleGenerator ← C1。
//
// 【本故事（c2-1-6）范围】只给端口签名，不实现 GenerateTitleService（属 epic-c2-2）、不接 SDK、不接 NestJS DI。
//
// 【铁律】核心零框架：不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process；字段全 readonly。

/**
 * TitleGenerationInput —— 标题生成入参（对齐 architecture §4.3）。
 *
 * recentMessages 是 C1 从历史投影出的纯文本片段（C1 只喂投影文本，不暴露富内容块，
 * 也不承担提示词拼装）。
 */
export interface TitleGenerationInput {
  /** 目标会话 id。 */
  readonly sessionId: string;
  /** 近期消息的纯文本投影。 */
  readonly recentMessages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly text: string;
  }>;
}

/**
 * TitleGenerator —— 非流式一次性标题生成驱动端口（供 C1 消费，FR-6）。
 *
 * 仅签名骨架，无实现体——GenerateTitleService 落地属 epic-c2-2，见 architecture §6.5：
 *  用轻量非流式 Runtime 调用生成标题字符串；不创建用户可见 StreamSession、
 *  不进 registry、不影响 composer gate（FR-6.3 / AC-13）；失败可抛，由 C1 用例降级。
 */
export interface TitleGenerator {
  /** 非流式一次性生成标题字符串。失败可抛，由 C1 用例降级（C1 FR-2.4）。 */
  generateTitle(input: TitleGenerationInput): Promise<string>;
}
