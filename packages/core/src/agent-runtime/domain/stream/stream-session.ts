// agent-runtime/domain/stream/stream-session.ts
// C2 · AgentRuntime —— 一次回合的聚合根 StreamSession（对齐 architecture §3.2）。
//
// 【本故事（c2-2-1）范围】只实现聚合根壳 + snapshot：构造注入 Clock、初始 phase=active、
// 持有累积产物与起始时刻等私有可变状态，snapshot() 返回只读快照。
// 相位迁移方法（markSettling/complete/abort/fail）、canAccept、apply 属后续故事（c2-2-2/…），
// 此处先留可编译占位，行为在后续故事补全。
//
// 【铁律 · 核心零框架】本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / uuid；不直调 Date . now() / new Date() / randomUUID——
// 取时一律经构造注入的 SK.Clock（now(): epoch 毫秒）。
//
// 【边界纪律 NFR-2 / AC-15】phase 是实时内存相位，绝不落库、绝不 import C1 的持久 StreamStatus
// 做实时判断。snapshot 只是内存态的只读投影，不是持久化模型。

import type { Clock } from '../../../ports/clock.js';
import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import type { AgentStreamEvent, TokenUsage, ContextUsage } from '../event/agent-stream-event.js';
import type { RuntimeKind } from '../runtime/runtime-kind.js';
import type { StreamPhase, StreamSessionId } from './stream-phase.js';
import { StreamPhaseKind, TerminalSubstate, isActive, isTerminal } from './stream-phase.js';
import { canTransitionPhase } from './phase-transition.js';
import type { TerminalReason } from './terminal-reason.js';
import { TerminalReasonCode } from './terminal-reason.js';
import type { TurnArtifacts } from './turn-artifacts.js';
import { buildFinalContent } from './turn-artifacts.js';

/**
 * StreamSessionSnapshot —— 聚合根的只读快照（对齐 architecture §3.2）。
 *
 * 仅为内存态的只读投影，绝不落库（NFR-2 / AC-15）。所有字段 readonly，
 * 消费方拿到的是当前时刻的不可变视图。
 *
 * - id：本次回合的 StreamSessionId（与 C1 会话 id 不同层）。
 * - sessionId：关联的 C1 会话 id（仅 id，不含 C1 实体）。
 * - runtimeKind：发起时锁定的运行时种类。
 * - phase：当前实时相位（active/settling/terminal）。
 * - artifacts：累积产物投影（见 §3.4）。
 * - tokenUsage：Runtime 上报的 token 用量投影；无值=未记录，UI 不显 0（AC-9）。
 * - contextUsage：Runtime 上报的上下文占用投影；无值=隐藏（AC-9）。
 * - error：终态 errored/aborted 时的 SK 分类结果。
 * - terminalReason：终态归因。
 * - startedAt：回合起始时刻（来自注入的 Clock）。
 * - settledAt：终态落定时刻（终态时才有值，来自注入的 Clock）。
 * - finalContent：终态时经 buildFinalContent 投影的最终内容；空回合（返回 null）
 *   或未落终态时省略（FR-2.6：空回合不落库）。
 */
export interface StreamSessionSnapshot {
  readonly id: StreamSessionId;
  readonly sessionId: string;
  readonly runtimeKind: RuntimeKind;
  readonly phase: StreamPhase;
  readonly artifacts: TurnArtifacts;
  readonly tokenUsage?: TokenUsage;
  readonly contextUsage?: ContextUsage;
  readonly error?: ClassifiedError;
  readonly terminalReason?: TerminalReason;
  readonly startedAt: number;
  readonly settledAt?: number;
  readonly finalContent?: string;
}

/**
 * StreamSessionInit —— 构造 StreamSession 所需的初始化参数（对齐 architecture §3.2）。
 *
 * - id：本次回合的 StreamSessionId（由用例层经 SK.IdGenerator 生成后传入，聚合根不自造 id）。
 * - sessionId：关联的 C1 会话 id。
 * - runtimeKind：发起时锁定的运行时种类。
 */
export interface StreamSessionInit {
  readonly id: StreamSessionId;
  readonly sessionId: string;
  readonly runtimeKind: RuntimeKind;
}

/** 空产物初值：新回合起始时累积产物为空（apply 累积行为属后续故事）。 */
const EMPTY_ARTIFACTS: TurnArtifacts = {
  text: '',
  thinking: '',
  toolUses: [],
  toolResults: [],
};

/**
 * StreamSession —— 一次回合的可变聚合根（内存态，对齐 architecture §3.2）。
 *
 * phase 只能经领域方法迁移，外部不得直接赋值（FR-1.2）；每个迁移方法内部先经
 * canTransitionPhase 校验（判据唯一权威在 phase-transition.ts，不在此重写），
 * 非法迁移抛错。abort/fail/complete 幂等：已 terminal 时 no-op（不回退、不二次翻）。
 *
 * 【abort 不变量 · #578 招牌（FR-1.4 / §3.2 / §4.2 / §6.3）】abort(reason) 是 force-abort 安全网
 * 在聚合根层面的落点：命令一到，只要当前非 terminal（active/settling 均可，经 canTransitionPhase 守卫），
 * phase 无条件、同步翻 terminal(aborted)，canAccept() 立即变 true——不依赖任何外部 interrupt 的
 * resolve/reject。真实优雅 interrupt 的调用与 reconcile 由 AbortStreamService（c2-5）编排，且必须把
 * 本方法的相位翻转独立于且早于 interrupt 的 then/finally：GitHub #578 的根因正是把 abort 排进
 * interrupt 的 .finally——interrupt 永挂则 .finally 永不执行，phase 卡在 active、composer 永久锁死。
 * 聚合根这一层保证「abort 命令一到即无条件落终态」，是切断该卡死的类型级安全网。
 *
 * 【本故事范围】构造 + snapshot + 四迁移方法 + canAccept + apply 均已实现，取时经注入 Clock。
 */
export class StreamSession {
  private readonly clock: Clock;

  private readonly id: StreamSessionId;
  private readonly sessionId: string;
  private readonly runtimeKind: RuntimeKind;
  private readonly startedAt: number;

  private phase: StreamPhase;
  private artifacts: TurnArtifacts;
  private tokenUsage?: TokenUsage;
  private contextUsage?: ContextUsage;
  private error?: ClassifiedError;
  private terminalReason?: TerminalReason;
  private settledAt?: number;
  private finalContent?: string;

  /**
   * 构造一次新回合的聚合根：phase 初始为 active（回合开始），startedAt 经注入 Clock 取时。
   *
   * @param init  回合初始化参数（id / sessionId / runtimeKind）
   * @param clock SK.Clock 端口，聚合根内部一切取时经它，绝不直调系统时钟
   */
  constructor(init: StreamSessionInit, clock: Clock) {
    this.clock = clock;
    this.id = init.id;
    this.sessionId = init.sessionId;
    this.runtimeKind = init.runtimeKind;
    this.startedAt = clock.now();
    this.phase = { kind: StreamPhaseKind.ACTIVE };
    this.artifacts = EMPTY_ARTIFACTS;
  }

  /**
   * 返回当前内存态的只读快照（对齐 architecture §3.2）。
   * 快照反映调用时刻的相位与累积产物；仅投影内存态，绝不落库（NFR-2 / AC-15）。
   */
  snapshot(): StreamSessionSnapshot {
    return {
      id: this.id,
      sessionId: this.sessionId,
      runtimeKind: this.runtimeKind,
      phase: this.phase,
      artifacts: this.artifacts,
      tokenUsage: this.tokenUsage,
      contextUsage: this.contextUsage,
      error: this.error,
      terminalReason: this.terminalReason,
      finalContent: this.finalContent,
      startedAt: this.startedAt,
      settledAt: this.settledAt,
    };
  }

  /**
   * canAccept —— isStreaming gate 的唯一判据（FR-1.6 / AC-3）。
   *
   * 语义：≡ phase.kind !== ACTIVE。回合进行中（active）时 composer 不可发送（false）；
   * 一旦相位离开 active（settling / 任一 terminal 子态）即返回 true。
   * composer「能否发送」只走本方法，不得散落 phase === 'active' 比较。
   *
   * 【#578 招牌观测点】abort() 无条件把 phase 从 active 翻 terminal(aborted) 后，
   * 本方法立即返回 true——即便外部 interrupt 永不 resolve，composer 也不会卡死。
   */
  canAccept(): boolean {
    return !isActive(this.phase);
  }

  /**
   * apply —— 把一个归一后的 AgentStreamEvent 累积进内部 TurnArtifacts（对齐 §3.2/§3.5）。
   *
   * 累积规则（严格对齐 §3.5 各事件字段语义）：
   *  - text：`text` 字段是「累积后的全文」（非增量），故整体替换 artifacts.text，不做拼接。
   *  - thinking：`delta` 是思考增量，追加到 artifacts.thinking 之后。
   *  - tool_use：把 ToolUseInfo 追加到 toolUses 序列（保持产出顺序）。
   *  - tool_result：把 ToolResultInfo 追加到 toolResults 序列（孤儿结果亦保留，配对由 buildFinalContent 处理）。
   *  - result：只把 Runtime 上报的 tokenUsage 投影存入（AC-9：未上报则字段省略，绝不填 0）。
   *  - context_usage：只把 Runtime 上报的 ContextUsage 投影存入（AC-9：未上报则不发此事件，不显假值）。
   *  - 其余事件（tool_output/status/error/permission_* 、rate_limit/file_changed/phase_changed）：
   *    不改累积产物——它们是实时旁路信号或由迁移方法/编排层处理，不进 TurnArtifacts。
   *
   * 【相位约束】apply 只在非终态（active/settling）累积产物；一旦落 terminal，
   * 回合产物已定格（settleTerminal 已投影 finalContent），迟到事件一律忽略（no-op，不抛）——
   * 避免终态后产物被改写导致落库内容与已定格快照不一致。
   *
   * apply 绝不改 phase（§3.2：累积不改相位）；取时不涉及，无需 Clock。
   */
  apply(event: AgentStreamEvent): void {
    // 终态后产物已定格：迟到事件忽略（no-op，不抛）。
    if (isTerminal(this.phase)) {
      return;
    }

    switch (event.type) {
      case 'text':
        // text 是累积后的全文（非增量），整体替换。
        this.artifacts = { ...this.artifacts, text: event.text };
        return;
      case 'thinking':
        // thinking 是增量 delta，追加。
        this.artifacts = {
          ...this.artifacts,
          thinking: this.artifacts.thinking + event.delta,
        };
        return;
      case 'tool_use':
        this.artifacts = {
          ...this.artifacts,
          toolUses: [...this.artifacts.toolUses, event.tool],
        };
        return;
      case 'tool_result':
        this.artifacts = {
          ...this.artifacts,
          toolResults: [...this.artifacts.toolResults, event.result],
        };
        return;
      case 'result':
        // AC-9：只存 Runtime 真实上报的投影，未上报则整体省略，绝不填 0。
        if (event.tokenUsage !== undefined) {
          this.tokenUsage = event.tokenUsage;
        }
        return;
      case 'context_usage':
        // AC-9：只存投影，未上报则不发此事件，不显假值。
        this.contextUsage = event.usage;
        return;
      default:
        // tool_output/status/error/permission_*/rate_limit/file_changed/phase_changed：
        // 实时旁路信号或由迁移方法/编排层处理，不累积进 TurnArtifacts。
        return;
    }
  }

  /**
   * active → settling：请求中断 / 收到上游终止信号，但产物收尾未完成（FR-1.5）。
   *
   * 迁移守卫经 canTransitionPhase（判据唯一权威在 phase-transition.ts，不在此重写）：
   * 仅 active→settling 合法；已 settling / 已 terminal 时守卫返回 false，方法静默 no-op
   * （幂等：不抛、不改 phase）。settling 非终态，不落 settledAt / finalContent。
   */
  markSettling(): void {
    const next: StreamPhase = { kind: StreamPhaseKind.SETTLING };
    if (!canTransitionPhase(this.phase, next)) {
      return;
    }
    this.phase = next;
  }

  /**
   * * → terminal(completed)：正常完成（FR-1.3）。
   *
   * 合法迁移（active/settling → terminal）时翻 terminal(completed)、记 settledAt 与终态产物；
   * 已 terminal 时 canTransitionPhase 返回 false，方法幂等 no-op（不回退、不二次翻、不抛）。
   *
   * @param tokenUsage Runtime 上报的 token 用量投影；无值=未记录，snapshot 省略（AC-9 不造假）。
   */
  complete(tokenUsage?: TokenUsage): void {
    const next: StreamPhase = {
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    };
    if (!canTransitionPhase(this.phase, next)) {
      return;
    }
    if (tokenUsage !== undefined) {
      this.tokenUsage = tokenUsage;
    }
    this.settleTerminal(next, { code: TerminalReasonCode.COMPLETED });
  }

  /**
   * * → terminal(aborted)：用户主动中断（FR-1.4 / §3.4）。
   *
   * 合法迁移时翻 terminal(aborted)、落 error（归 ErrorCode.ABORTED，由调用方分类传入）、
   * 记 settledAt 与终态产物、归因 USER_ABORTED；已 terminal 时幂等 no-op（不回退、不二次翻、不抛）。
   *
   * @param reason 经 SK.ErrorClassifier 归一的分类结果（应为 ABORTED 类），携入 terminalReason.classified。
   */
  abort(reason: ClassifiedError): void {
    const next: StreamPhase = {
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    };
    if (!canTransitionPhase(this.phase, next)) {
      return;
    }
    this.error = reason;
    this.settleTerminal(next, {
      code: TerminalReasonCode.USER_ABORTED,
      classified: reason,
    });
  }

  /**
   * * → terminal(errored)：真实错误终止（FR-1.4）。error 为分类结果（非 ABORTED）。
   *
   * 合法迁移时翻 terminal(errored)、落 error、记 settledAt 与终态产物、归因 RUNTIME_ERROR；
   * 已 terminal 时幂等 no-op（不回退、不二次翻、不抛）。
   *
   * @param error 经 SK.ErrorClassifier 归一的分类结果（真实错误码），携入 terminalReason.classified。
   */
  fail(error: ClassifiedError): void {
    const next: StreamPhase = {
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ERRORED,
    };
    if (!canTransitionPhase(this.phase, next)) {
      return;
    }
    this.error = error;
    this.settleTerminal(next, {
      code: TerminalReasonCode.RUNTIME_ERROR,
      classified: error,
    });
  }

  /**
   * 终态落定的公共收束：更新 phase、记 settledAt（经注入 Clock）、归因，
   * 并经 buildFinalContent 投影终态产物——非 null 才记入 finalContent（空回合不落库，FR-2.6）。
   * 仅由三个终态迁移方法在守卫通过后调用。
   */
  private settleTerminal(next: StreamPhase, reason: TerminalReason): void {
    this.phase = next;
    this.settledAt = this.clock.now();
    this.terminalReason = reason;
    const content = buildFinalContent(this.artifacts);
    if (content !== null) {
      this.finalContent = content;
    }
  }
}
