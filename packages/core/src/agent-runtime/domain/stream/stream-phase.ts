// agent-runtime/domain/stream/stream-phase.ts
// C2 AgentRuntime 领域边界：实时相位状态机（领域不变量核心，对齐 architecture §3.1/§3.5）。
//
// 【边界纪律 · 铁律 NFR-2 / AC-15 · 务必分清】
// StreamPhase 是「实时内存相位」，回答「现在这一刻还在生成吗」，绝不落库。
// 它不是 C1 Conversation 的持久转录行生命周期 StreamStatus
// （streaming/completed/interrupted/error）——那是一条已落库消息行的最终事实。
// 本文件（及 C2 类型层）绝不 import、不建模 C1 的 StreamStatus 做实时判断；
// 回合终态时仅把 TerminalSubstate 映射为 StreamStatus，经
// C1.AppendMessageUseCase.updateStreamStatus 端口写回（见 architecture §6.4），不直写库、不传 phase 本身。
// 把 phase 落库、或把 C1 持久 StreamStatus 当实时相位读，正是现有 stop/abort 卡死根因，C2 在类型层面切断。
//
// 本文件只定义相位类型/枚举、纯函数判定与 StreamSessionId 值对象；
// 不实现 StreamSession 聚合根的相位迁移方法（markSettling/complete/abort/fail 属 epic-c2-2）。

/**
 * StreamPhaseKind：回合实时相位的三种大类。
 *
 * - active：回合进行中；canAccept()=false；isStreaming gate=on。
 * - settling：已请求中断 / 上游已发终止信号，产物收尾 + turn 关闭中（尚未落终态）。
 * - terminal：回合已结束，具体结果见 TerminalSubstate。
 */
export enum StreamPhaseKind {
  ACTIVE = 'active',
  SETTLING = 'settling',
  TERMINAL = 'terminal',
}

/**
 * TerminalSubstate：terminal 相位下的三种终结子态。
 *
 * - completed：正常完成。
 * - aborted：用户主动 abort / stop（归 ErrorCode.ABORTED，不显示成「出错了」）。
 * - errored：出错终止（归真实 ErrorCode，非 ABORTED）。
 */
export enum TerminalSubstate {
  COMPLETED = 'completed',
  ABORTED = 'aborted',
  ERRORED = 'errored',
}

/**
 * StreamPhase：相位的判别联合（discriminated union）。
 *
 * - active / settling 无子态。
 * - terminal 必带 substate，用于区分完成 / 中断 / 出错三种终结结果。
 *
 * 所有字段 readonly——相位值对象不可变，迁移只能产出新值（迁移方法属 c2-2）。
 */
export type StreamPhase =
  | { readonly kind: StreamPhaseKind.ACTIVE }
  | { readonly kind: StreamPhaseKind.SETTLING }
  | { readonly kind: StreamPhaseKind.TERMINAL; readonly substate: TerminalSubstate };

/**
 * isActive：判定相位是否处于 active（回合进行中）。纯函数。
 *
 * @param phase 待判定相位
 * @returns kind === ACTIVE 时返回 true
 */
export function isActive(phase: StreamPhase): boolean {
  return phase.kind === StreamPhaseKind.ACTIVE;
}

/**
 * isTerminal：判定相位是否已落终态（terminal）。纯函数。
 *
 * @param phase 待判定相位
 * @returns kind === TERMINAL 时返回 true
 */
export function isTerminal(phase: StreamPhase): boolean {
  return phase.kind === StreamPhaseKind.TERMINAL;
}

/**
 * StreamSessionId：一次回合（StreamSession）的标识值对象。
 *
 * 现阶段以类型别名建模为 string（对齐 architecture §3.2）。
 * 语义上它是「一次运行时回合」的 id，与 C1 会话 id（sessionId）不同层：
 * 一个 C1 会话可承载多次回合，每次回合有独立 StreamSessionId。
 * 若后续需在类型层面杜绝与裸 string / 其它 id 混用，可升级为品牌类型
 * （如 `string & { readonly __brand: 'StreamSessionId' }`），此处保持别名以免过度设计。
 */
export type StreamSessionId = string;
