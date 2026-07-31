// agent-runtime/domain/stream/phase-transition.ts
// C2 AgentRuntime 领域边界：相位状态机的纯函数判定（对齐 architecture §3.5 / AC-1）。
//
// 本文件只定义两个纯函数——合法迁移谓词 canTransitionPhase 与中断收敛 reconcilePhase，
// 均无副作用、不直调时钟/随机、零框架 import。聚合根 StreamSession 的迁移方法
// （markSettling/complete/abort/fail）将在 epic-c2-2 内部复用 canTransitionPhase 校验，
// 本故事不实现聚合根。

import type { StreamPhase } from './stream-phase.js';
import { StreamPhaseKind, TerminalSubstate } from './stream-phase.js';

/**
 * canTransitionPhase：相位状态机的唯一合法迁移判据（纯函数，AC-1）。
 *
 * 合法迁移（返回 true）：
 *  - active   → settling
 *  - active   → terminal
 *  - settling → terminal
 *
 * 非法迁移（返回 false）：
 *  - 任意 terminal → *（终态不可迁出，terminal 落定即不可变）
 *  - 任意 *        → active（不可回退到 active，含 settling→active / terminal→active / active→active）
 *  - settling → settling（无自迁移；只有 active 能进入 settling）
 *
 * 这条不变量是 phase 状态机的核心：单向前进、终态吸收。
 *
 * @param from 迁移起始相位
 * @param to   迁移目标相位
 * @returns 迁移合法时返回 true，否则 false
 */
export function canTransitionPhase(from: StreamPhase, to: StreamPhase): boolean {
  // 终态不可迁出：任意 terminal → * 一律非法。
  if (from.kind === StreamPhaseKind.TERMINAL) {
    return false;
  }
  // 不可回退到 active：任意 * → active 一律非法。
  if (to.kind === StreamPhaseKind.ACTIVE) {
    return false;
  }
  switch (from.kind) {
    case StreamPhaseKind.ACTIVE:
      // active → settling / active → terminal 均合法（to=active 已在上方排除）。
      return (
        to.kind === StreamPhaseKind.SETTLING || to.kind === StreamPhaseKind.TERMINAL
      );
    case StreamPhaseKind.SETTLING:
      // settling 只能进入 terminal；settling → settling 无自迁移。
      return to.kind === StreamPhaseKind.TERMINAL;
  }
}

/**
 * reconcilePhase：中断响应携带的 Runtime 权威状态 → 目标相位纠正（纯函数，对齐 §3.5）。
 *
 * 仅用于 AbortStreamService 的 I4 收敛：best-effort interrupt 返回权威 runtimeStatus 后，
 * 据此决定是否把相位收敛到终态。
 *
 * 映射约定：
 *  - 'running' / null / 其它未知值 → null（不纠正，交由 force-abort 安全网兜底）
 *  - 'idle'        → terminal(completed)   （Runtime 已空闲，回合正常收束）
 *  - 'interrupted' → terminal(aborted)     （已被中断，「我停的」）
 *  - 'error'       → terminal(errored)     （上游报错终止）
 *
 * 返回 null 表示"不 reconcile"（force-abort 网兜底），这正是 GitHub #578 的结构化沉淀：
 * interrupt 挂起/返回 running 时不阻塞相位翻转，改由 force-abort 定时器无条件收敛。
 *
 * @param runtimeStatus Runtime 上报的权威状态字符串（可空）
 * @param current       当前相位（保留形参以对齐 §3.5 签名；纠正目标仅由 runtimeStatus 决定）
 * @returns 目标终态相位；running/unknown 时返回 null
 */
export function reconcilePhase(
  runtimeStatus: string | null,
  current: StreamPhase,
): StreamPhase | null {
  void current; // 当前实现纠正目标仅取决于 runtimeStatus；形参保留以对齐 §3.5 契约签名。
  switch (runtimeStatus) {
    case 'idle':
      return { kind: StreamPhaseKind.TERMINAL, substate: TerminalSubstate.COMPLETED };
    case 'interrupted':
      return { kind: StreamPhaseKind.TERMINAL, substate: TerminalSubstate.ABORTED };
    case 'error':
      return { kind: StreamPhaseKind.TERMINAL, substate: TerminalSubstate.ERRORED };
    default:
      // 'running' / null / 未知值：不纠正，force-abort 安全网兜底。
      return null;
  }
}
