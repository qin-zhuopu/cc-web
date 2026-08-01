// agent-runtime/usecases/abort-stream.ts
// C2 · AgentRuntime —— 中断回合用例 AbortStreamService（实现 AbortStreamUseCase，
// 对齐 architecture §4.2 / §6.3、SPEC CAP-2/CAP-3、PRD FR-3.1/3.2/3.3/1.5 / AC-2/AC-4）。
//
// 【本 epic 存在的核心理由 · GitHub #578】「点 stop/abort 后 composer 永久卡死」的根因：
// 旧代码把「翻终态 abort」排进优雅 interrupt 的 .finally——interrupt 挂起（Runtime 无响应）→
// .finally 永不执行 → phase 永停 active → canAccept 永 false → 输入框永久锁死。
// 本用例在【编排层】切断它：force-abort 安全网【无条件先行】安排（早于且独立于 interrupt），
// interrupt 挂起/抛错绝不阻塞相位翻转。绝不把 session.abort 或安全网安排排进
// interrupt(...) 的 .then/.finally/.catch。
//
// 【本故事（c2-5-3）范围】best-effort 优雅 interrupt + reconcilePhase 收敛 + #578 端到端回归：
//   ④ markSettling 后经注入的 AgentRuntimePort.interrupt(turnRef) 发 best-effort 优雅中断
//      （turnRef 由核心以 { streamId } 构造，句柄由适配器按 streamId 内部解析，核心不碰 native）。
//   ⑤ interrupt 返回权威 runtimeStatus → 经 c2-1 reconcilePhase 收敛：terminal 相位据子态翻终态
//      （completed→complete / aborted→abort / errored→fail，归因经 SK.ErrorClassifier）；
//      null（running/unknown）→ 不纠正，交 force-abort 安全网兜底。
//   ⑥ 【#578 时序铁律】interrupt 挂起/抛错绝不阻塞相位翻转：不 await interrupt（fire-and-forget，
//      收敛在 .then 里异步完成），.catch 只吞错（TODO 经 RuntimeLog 记录），绝不在 .then/.finally/.catch
//      里把 phase 翻回 active、绝不把安全网安排挪到 interrupt 之后。
// 幂等门 + force-abort 无条件先行安排 + markSettling 于 c2-5-2 已落；本故事补 interrupt+reconcile，
// 并把 force-abort 到期兜底回调补全（仍未终态则 abort(ABORTED)+forceKillTurn），使 #578 招牌回归为真断言。
//
// 【铁律 · 核心零框架】本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / node:timers / codex / uuid；不直调 setTimeout / setInterval /
// 系统时钟——force-abort 延时经注入的 ForceAbortScheduler，取时经注入 SK.Clock。
// 归因一律经 SK.ErrorClassifier.classify，绝不手拼 ClassifiedError 造假 code。
// 类型-only import 用 import type + .js 扩展名（verbatimModuleSyntax），值 import 走普通 import。

import type { Clock } from '../../ports/clock.js';
import type { ErrorClassifier } from '../../ports/error-classifier.js';
import type { ClassifiedError } from '../../domain/error/classified-error.js';
import type { AbortStreamUseCase } from '../ports/driving/abort-stream-usecase.js';
import type { AgentRuntimePort, TurnRef } from '../ports/driven/agent-runtime-port.js';
import type { ForceAbortScheduler } from '../ports/driven/force-abort-scheduler.js';
import { FORCE_ABORT_MS } from '../ports/driven/force-abort-scheduler.js';
import type { StreamSessionId } from '../domain/stream/stream-phase.js';
import { StreamPhaseKind, TerminalSubstate, isActive, isTerminal } from '../domain/stream/stream-phase.js';
import { reconcilePhase } from '../domain/stream/phase-transition.js';
import { TerminalReasonCode } from '../domain/stream/terminal-reason.js';
import type { StreamSessionRegistry } from './stream-session-registry.js';

/**
 * classifyAbort —— 经注入的 SK.ErrorClassifier 把「用户主动中断」归一为 ABORTED 分类结果
 *（FR-3.4 / AC-5）。
 *
 * 构造 name='AbortError' 且不含 timeout 语义的错误交 classify，由 classifyByName 归
 * ErrorCode.ABORTED（用户主动中断语义，与真实错误 / 超时 code 不同）。归类唯一权威在
 * SK.ErrorClassifier——绝不在此手工拼 ClassifiedError（避免绕过分类器造假 code）。
 *
 * 用于 reconcile 收敛到 aborted、以及 force-abort 到期兜底（仍未终态时 session.abort(此结果)）。
 */
function classifyAbort(errorClassifier: ErrorClassifier): ClassifiedError {
  const abortError = new Error('force-abort');
  abortError.name = 'AbortError';
  return errorClassifier.classify(abortError);
}

/**
 * classifyRuntimeError —— reconcile 收敛到 errored 时，经 SK.ErrorClassifier 归一 Runtime 报错。
 *
 * interrupt 返回权威状态 'error' 表示上游报错终止，但未携带具体错误对象；构造一个描述性错误交
 * classify（不含 abort/cancel/timeout 语义，归 UNKNOWN 类），确保归类与 ABORTED 区分（AC-5）。
 * 归类唯一权威在 SK.ErrorClassifier——绝不在此手工拼 ClassifiedError 造假 code。
 */
function classifyRuntimeError(errorClassifier: ErrorClassifier): ClassifiedError {
  return errorClassifier.classify(new Error('runtime reported error status'));
}

/**
 * classifyIdleTimeout —— idle-timeout（回合长时间无事件）归因（FR-3.6 / AC-5，对齐
 * terminal-reason.ts expectedErrorCode(IDLE_TIMEOUT)=TIMEOUT）。
 *
 * 构造含 'timed out' 语义、且不含 abort/cancel/spawn/child process 语义的错误交 classify，
 * 由 classifyByKeyword 命中超时关键词归 ErrorCode.TIMEOUT。归类唯一权威在 SK.ErrorClassifier
 * ——绝不在此手拼 ClassifiedError 造假 code。与 user-abort(ABORTED)、tool-timeout(PROCESS) 区分。
 */
function classifyIdleTimeout(errorClassifier: ErrorClassifier): ClassifiedError {
  return errorClassifier.classify(new Error('stream idle timed out'));
}

/**
 * classifyToolTimeout —— tool-timeout（工具执行超时）归因（FR-3.6 / AC-5，对齐
 * terminal-reason.ts expectedErrorCode(TOOL_TIMEOUT)=PROCESS）。
 *
 * 构造含 'child process' 进程语义、且不含 timeout/abort 语义的错误交 classify，由
 * classifyByKeyword 命中进程关键词归 ErrorCode.PROCESS（工具跑在子进程里，超时视为进程类）。
 * 归类唯一权威在 SK.ErrorClassifier——绝不手拼 ClassifiedError。与 idle-timeout(TIMEOUT) 区分。
 *
 * 注：消息刻意不含 'timeout'/'timed out'，避免被 classifyByKeyword 的超时分支（早于进程分支）
 * 抢先归 TIMEOUT——务必让 classify 真归到 PROCESS（读 error-classifier.ts classifyByKeyword 确认）。
 */
function classifyToolTimeout(errorClassifier: ErrorClassifier): ClassifiedError {
  return errorClassifier.classify(new Error('tool child process unresponsive'));
}

/**
 * classifyTimeout —— 按超时归因码分派到对应的 SK 分类结果（FR-3.6 / AC-5）。
 * IDLE_TIMEOUT→TIMEOUT、TOOL_TIMEOUT→PROCESS，与 USER_ABORTED→ABORTED 三路 code 互不相同。
 * 归类全经 SK.ErrorClassifier，本函数只负责按语义构造正确的错误对象交由其分类，不预设 code。
 */
function classifyTimeout(
  errorClassifier: ErrorClassifier,
  reasonCode: TerminalReasonCode.IDLE_TIMEOUT | TerminalReasonCode.TOOL_TIMEOUT,
): ClassifiedError {
  return reasonCode === TerminalReasonCode.IDLE_TIMEOUT
    ? classifyIdleTimeout(errorClassifier)
    : classifyToolTimeout(errorClassifier);
}

/**
 * AbortStreamService —— 中断一次回合的用例编排（实现 AbortStreamUseCase，对齐 architecture §4.2）。
 *
 * 纯逻辑、零框架：依赖全部经构造注入的端口接口（AgentRuntimePort / StreamSessionRegistry /
 * ForceAbortScheduler / SK.ErrorClassifier / SK.Clock），可用假件做纯单元测试。
 *
 * 构造签名一次性把后续故事所需依赖全部注入，避免反复改构造签名。
 */
export class AbortStreamService implements AbortStreamUseCase {
  constructor(
    private readonly runtime: AgentRuntimePort,
    private readonly registry: StreamSessionRegistry,
    private readonly scheduler: ForceAbortScheduler,
    private readonly errorClassifier: ErrorClassifier,
    private readonly clock: Clock,
  ) {}

  /**
   * abort —— 中断编排入口（FR-3）。
   *
   * ① 幂等门（FR-3.1）：registry 取不到 session、或 phase 非 active → 幂等 return（no-op，
   *    不安排安全网、不 interrupt、不 markSettling）。
   * ② 【#578 时序铁律 · 最重要】force-abort 安全网【无条件先行】安排（FR-3.2 / AC-4）——
   *    早于且独立于任何 interrupt 调用，绝不把 session.abort 或本安排排进 interrupt 的
   *    .then/.finally/.catch。保存返回的 cancel 供收敛后取消未到期的安全网。
   * ③ markSettling（FR-1.5）：安排安全网后把回合标记 settling（此刻 canAccept() 立即 true，
   *    这正是 #578 用户可见症状——输入框锁死——被解开的一刻，不依赖 interrupt 是否 resolve）。
   * ④ best-effort 优雅 interrupt + reconcile 收敛（FR-3.3）：fire-and-forget，不 await——
   *    interrupt 永挂时方法照常返回，收敛在 .then 里异步完成，安全网仍兜底。
   *
   * 方法在安排安全网 + markSettling + 触发 interrupt 后即返回（不 await interrupt 的收敛），
   * 确保 interrupt 永挂时 abort 方法不挂起（#578 编排层时序不变量）。
   */
  async abort(streamId: StreamSessionId): Promise<void> {
    // ① 幂等门（FR-3.1）：无 session 或非 active → no-op。
    const session = this.registry.get(streamId);
    if (session === undefined || !isActive(session.snapshot().phase)) {
      return;
    }

    // turnRef 由核心以 { streamId } 构造：核心不持有/不解释 native 句柄（适配器按 streamId 内部解析）。
    // 【CAP-5 契约边界 · FR-3.5 / AC-6】abort 必通知适配器关句柄——优雅路径经 interrupt(turnRef)、
    //   兜底路径经 forceKillTurn(turnRef)，两者均传本 turnRef（streamId 正确、native 恒 undefined）。
    //   核心【绝不】触碰 TurnRef.native 结构（native 由适配器 c2-6 解析实际 Query/thread-turn 句柄）。
    //   「ClaudeCode late-unregister（旧 lockId 的 teardown 不 evict 新 turn 句柄）为 no-op」是
    //   【适配器侧（c2-6）】语义，本故事不在核心实现——核心侧只保证「abort 必调 interrupt 和/或
    //   forceKillTurn 通知适配器」这一契约。
    const turnRef: TurnRef = { streamId };

    // ② force-abort 安全网【无条件先行】安排（FR-3.2 / AC-4）——【必须早于且独立于】interrupt。
    //    此处刻意在 markSettling / interrupt 之前调 schedule，且不把 schedule 排进任何 Promise 回调，
    //    以在编排结构上锁死 #578 的时序不变量：即便 interrupt 挂起，安全网也已安排。
    const cancelForceAbort = this.scheduler.schedule(() => {
      // 到期兜底：回合仍未终态（interrupt 未能收敛，如永挂/返回 running）→ 无条件翻 terminal(aborted)
      // + 强关句柄兜底；已终态（interrupt 已收敛 / reader 已 settle）→ no-op（幂等，不二次翻）。
      // 用 !isTerminal 而非 isActive：markSettling 后 phase=settling（非 active），仍需被安全网兜底。
      if (!isTerminal(session.snapshot().phase)) {
        session.abort(classifyAbort(this.errorClassifier)); // → ErrorCode.ABORTED（FR-3.4）
        this.runtime.forceKillTurn(turnRef); // 兜底关 turn/thread/Query 句柄（FR-3.5）
      }
    }, FORCE_ABORT_MS);

    // ③ markSettling（FR-1.5）：安排安全网后标记回合收尾中。
    session.markSettling();

    // ④ best-effort 优雅 interrupt（FR-3.3）：经 interrupt 发优雅中断，拿权威 runtimeStatus 收敛。
    //    【#578 铁律】fire-and-forget（不 await）——interrupt 永挂时方法照常返回，安全网兜底；
    //    .catch 只吞错，绝不在此把 phase 翻回 active、绝不把安全网安排挪到此处之后。
    void Promise.resolve(this.runtime.interrupt(turnRef))
      .then((runtimeStatus) => {
        // 已终态（force-abort 已兜底 / reader 已收敛）→ 不重复收敛（聚合根幂等亦安全）。
        if (isTerminal(session.snapshot().phase)) {
          return;
        }
        const next = reconcilePhase(runtimeStatus, session.snapshot().phase);
        // running / null / 未知 → 不纠正（phase 仍 settling），交 force-abort 安全网兜底。
        if (next === null || next.kind !== StreamPhaseKind.TERMINAL) {
          return;
        }
        // reconcile 给出权威终态 → 据子态翻终态（迁移方法幂等，settling→terminal 合法）。
        switch (next.substate) {
          case TerminalSubstate.COMPLETED:
            session.complete();
            break;
          case TerminalSubstate.ABORTED:
            session.abort(classifyAbort(this.errorClassifier));
            break;
          case TerminalSubstate.ERRORED:
            session.fail(classifyRuntimeError(this.errorClassifier));
            break;
        }
        // 收敛成功 → 取消未到期的安全网（避免多余触发；未 cancel 亦安全，聚合根 abort 幂等）。
        cancelForceAbort();
      })
      .catch(() => {
        // interrupt 失败/超时 —— force-abort 安全网兜底（这正是 #578 的结构化切断）。
        // 【铁律】绝不在此把 phase 翻回 active、绝不把安全网安排挪到此处之后。
        // TODO(c2-7 接线)：经 SK.RuntimeLog 记录 interrupt 失败（脱敏），不影响相位翻转。
      });

    // 取时端口 clock 供后续故事使用（如收敛时刻记录）；本故事经 session 内部 Clock 记 settledAt，此处注入不直用。
    void this.clock;
  }

  /**
   * settleTimeout —— idle-timeout / tool-timeout 超时信号 → 正确归因翻终态（FR-3.6 / AC-5，故事 c2-5-6）。
   *
   * idle-timeout（回合空闲超时）与 tool-timeout（工具执行超时）都走 abort 路径翻 terminal(aborted)
   * 复用 c2-2 聚合根，但【归因不同】（对齐 architecture §6.2 / terminal-reason.ts expectedErrorCode）：
   *   - IDLE_TIMEOUT → ErrorCode.TIMEOUT （长时间无事件）
   *   - TOOL_TIMEOUT → ErrorCode.PROCESS （工具跑在子进程里，超时归进程类）
   * 与 user-abort（abort 路径归 ABORTED）三路 ClassifiedError.code 互不相同（AC-5）。
   *
   * 归因一律经注入的 SK.ErrorClassifier.classify（本函数只按语义构造正确错误对象），绝不手拼
   * ClassifiedError 造假 code。归类唯一权威在 SK.ErrorClassifier，本 epic 不重写。
   *
   * 【范围】本故事只落「给定超时信号 → 正确归因翻终态」的核心归类；真实 idle 计时 / tool 计时的
   * 触发机制依赖具体 Runtime，属 c2-6，本 epic 不造假定时器。
   *
   * 幂等：回合已 terminal（如已被 abort 收敛）→ no-op（聚合根 abort 幂等，不二次翻）。
   *
   * @param streamId 目标回合 id。
   * @param reasonCode 超时归因码：IDLE_TIMEOUT 或 TOOL_TIMEOUT。
   */
  settleTimeout(
    streamId: StreamSessionId,
    reasonCode: TerminalReasonCode.IDLE_TIMEOUT | TerminalReasonCode.TOOL_TIMEOUT,
  ): void {
    const session = this.registry.get(streamId);
    // 幂等门：无 session 或已 terminal → no-op（不二次翻）。
    if (session === undefined || isTerminal(session.snapshot().phase)) {
      return;
    }
    // 超时归因经 SK.ErrorClassifier 归一（IDLE→TIMEOUT / TOOL→PROCESS），走 abort 路径翻终态。
    session.abort(classifyTimeout(this.errorClassifier, reasonCode));
  }
}
