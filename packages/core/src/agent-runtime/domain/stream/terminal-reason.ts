// domain/stream/terminal-reason.ts
// C2 · AgentRuntime —— 终态归因值对象与到 SK.ErrorClassifier 的映射约定。
// 对齐 architecture §3.5、PRD AC-5。零框架 import；仅类型/枚举/纯函数判定，
// 不实现 classify 本身（分类逻辑属 SK.ErrorClassifier），不实现 abort 用例（属 c2-2）。
import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import { ErrorCode } from '../../../domain/error/error-code.js';

/**
 * 回合终态的 6 类归因码。回答"这一回合为什么结束"，
 * 供 UI 据此区分「我停的」/「超时」/「出错」/「正常完成」。
 */
export enum TerminalReasonCode {
  COMPLETED = 'completed', // 正常完成 —— 无错误
  USER_ABORTED = 'user_aborted', // 用户点停止 → ErrorCode.ABORTED
  IDLE_TIMEOUT = 'idle_timeout', // 长时间无事件 → ErrorCode.TIMEOUT
  TOOL_TIMEOUT = 'tool_timeout', // 工具超时 → ErrorCode.PROCESS / TIMEOUT
  RUNTIME_ERROR = 'runtime_error', // Runtime 上游错误 → 由 ErrorClassifier 分类
  PROCESS_DIED = 'process_died', // Codex app-server 僵死/退出 → ErrorCode.PROCESS
}

/**
 * TerminalReason —— 终态归因值对象（只读）。
 * - code：6 类归因码之一。
 * - classified：可选的 SK 分类结果。COMPLETED 无错误时省略；
 *   其余归因码在终态落定时携带经 SK.ErrorClassifier 归一的 ClassifiedError
 *   （含 ABORTED 独立类）。此处只引用 SK 类型，不重定义、不实现分类。
 */
export interface TerminalReason {
  readonly code: TerminalReasonCode;
  readonly classified?: ClassifiedError;
}

/**
 * 归因码 → 期望 ErrorCode 的映射约定（纯函数，不实现 classify 本身）。
 *
 * 语义约定（对齐 §3.5 反例 / AC-5）：
 *  - USER_ABORTED  → ABORTED      （「我停的」，绝不显示成"出错了"，见下方 isUserAbort）
 *  - IDLE_TIMEOUT  → TIMEOUT      （长时间无事件）
 *  - TOOL_TIMEOUT  → PROCESS      （工具超时，归进程类；亦可 TIMEOUT，取 PROCESS 为默认约定）
 *  - PROCESS_DIED  → PROCESS      （子进程僵死/退出）
 *  - RUNTIME_ERROR → null         （不预判，交由 SK.ErrorClassifier 依原始异常分类）
 *  - COMPLETED     → null         （正常完成，无错误码）
 *
 * 返回 null 表示"该归因不预设 ErrorCode"：
 *  RUNTIME_ERROR 的真实错误码由 ErrorClassifier 依 cause 决定；
 *  COMPLETED 本就无错误。调用方据此决定是否落 classified。
 */
export function expectedErrorCode(code: TerminalReasonCode): ErrorCode | null {
  switch (code) {
    case TerminalReasonCode.USER_ABORTED:
      return ErrorCode.ABORTED;
    case TerminalReasonCode.IDLE_TIMEOUT:
      return ErrorCode.TIMEOUT;
    case TerminalReasonCode.TOOL_TIMEOUT:
      return ErrorCode.PROCESS;
    case TerminalReasonCode.PROCESS_DIED:
      return ErrorCode.PROCESS;
    case TerminalReasonCode.RUNTIME_ERROR:
      return null; // 交由 ErrorClassifier 依原始异常分类
    case TerminalReasonCode.COMPLETED:
      return null; // 正常完成，无错误
  }
}

/**
 * 该归因码是否代表用户主动中断（AC-5 反例核心）。
 * UI 据此把「我停的」与真实错误区分开——ABORTED 语义绝不渲染成"出错了"。
 */
export function isUserAbort(code: TerminalReasonCode): boolean {
  return code === TerminalReasonCode.USER_ABORTED;
}

/**
 * 该归因码是否代表"出错终止"（会落 terminal(errored)）。
 * COMPLETED（正常完成）与 USER_ABORTED（用户中断，落 terminal(aborted)）均非错误终态。
 */
export function isErrorReason(code: TerminalReasonCode): boolean {
  return (
    code !== TerminalReasonCode.COMPLETED && code !== TerminalReasonCode.USER_ABORTED
  );
}
