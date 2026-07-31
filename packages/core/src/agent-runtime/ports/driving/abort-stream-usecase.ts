// agent-runtime/ports/driving/abort-stream-usecase.ts
// C2 · AgentRuntime 驱动端口：AbortStreamUseCase（中断一次回合）。
// 对齐 architecture §4.2。零框架 import；仅接口签名骨架。
//
// 【本故事（c2-1-6）范围】只给端口签名，不实现 AbortStreamService（force-abort 无条件先行 +
// markSettling + best-effort interrupt + reconcilePhase 收敛，属 epic-c2-2）、不接 SDK、不接 NestJS DI。
//
// 【铁律】核心零框架：不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / codex；类型-only import 用 import type + .js 扩展名。

import type { StreamSessionId } from '../../domain/stream/stream-phase.js';

/**
 * AbortStreamUseCase —— 中断一次回合的驱动端口（对外提供，FR-3）。
 *
 * 仅签名骨架，无实现体——编排逻辑落地属 epic-c2-2，见 architecture §4.2 / §6.3：
 *  这是 GitHub #578「stop/abort 卡死」的结构化沉淀——interrupt 挂起时 phase 仍经
 *  force-abort 安全网翻终态，canAccept() 立刻 true。
 */
export interface AbortStreamUseCase {
  /**
   * 中断一次回合（FR-3）。若 phase 非 active → 幂等返回（FR-3.1）。
   * 否则：
   *  1. **无条件先行**安排 force-abort 安全网（FR-3.2 / AC-4）——绝不排在 interrupt 之后。
   *  2. session.markSettling()。
   *  3. best-effort 优雅 interrupt（经 AgentRuntimePort.interrupt，关闭 turn/thread/Query，FR-3.5）。
   *  4. interrupt 返回权威 runtimeStatus → reconcilePhase 收敛（FR-3.3）。
   *  5. force-abort 到期若仍 active → session.abort(ABORTED)（FR-1.4）。
   */
  abort(streamId: StreamSessionId): Promise<void>;
}
