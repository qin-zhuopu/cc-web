// agent-runtime/ports/driven/force-abort-scheduler.ts
// C2 · AgentRuntime 出站端口：ForceAbortScheduler（force-abort 安全网的延时调度抽象）。
// 对齐 SPEC CAP-1、architecture §4.2（clock-based-timeout）、PRD FR-3.2 / AC-4。
//
// 【本故事（c2-5-1）范围】只给端口契约 + FORCE_ABORT_MS 常量，测试用手动触发假件。
// 生产实现（用 setTimeout 安排延时）属 epic-c2-7 接线，不在核心包内。
// 不实现 AbortStreamService 编排（属 c2-5-2 及后续）、不接 SDK / 进程 / HTTP / NestJS DI。
//
// 【核心零框架铁律 · NFR-1 / AC-14】packages/core 禁 import node:timers、禁直调
// setTimeout / setInterval（scripts/check-core-imports.mjs 守卫会拦）。core 里 force-abort
// 安全网需要「延时到期触发」的能力，且 AC-4 要求能 spy「安排先行」——故把「安排延时回调」
// 抽象成本可注入端口：生产由 c2-7 用 setTimeout 实现，测试用手动 fire 假件配合假 Clock。

/**
 * FORCE_ABORT_MS —— force-abort 安全网的默认到期延时（毫秒）。
 *
 * architecture §4.2 以 `clock-based-timeout(FORCE_ABORT_MS, ...)` 引用本常量但未给定具体数值，
 * 此处取合理默认 5000ms（优雅 interrupt 的兜底等待窗口）。实际接线时可由 AbortStreamService
 * 构造注入的延时值覆盖，本常量仅作缺省。
 */
export const FORCE_ABORT_MS = 5000;

/**
 * ForceAbortScheduler —— force-abort 安全网的延时调度抽象（C2 driven port）。
 *
 * 【#578 时序不变量的落点】AbortStreamService 经本端口「无条件先行」安排 force-abort 安全网
 * （早于且独立于 interrupt），到期若回合仍 active 则强制翻终态兜底。抽象成端口后：
 *  - 生产（c2-7）用 setTimeout 实现真实延时；
 *  - 测试用手动触发假件（记录被安排的 callback / delayMs、可手动 fire、可 spy「安排先行」于 interrupt）。
 */
export interface ForceAbortScheduler {
  /**
   * 安排一个延时回调：delayMs 后触发 callback。
   * @param callback 到期触发的回调（force-abort 兜底逻辑）。
   * @param delayMs 延时毫秒数。
   * @returns cancel 函数——调用即取消尚未到期的安排（已到期/已触发则 no-op）。
   */
  schedule(callback: () => void, delayMs: number): () => void;
}
