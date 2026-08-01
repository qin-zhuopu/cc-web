// agent-runtime/domain/stream/stream-session.test.ts
// C2 · AgentRuntime —— StreamSession 聚合根壳 + snapshot 单测（对齐 architecture §3.2，故事 c2-2-1）。
// 覆盖：构造聚合根、初始 phase=active、startedAt 经注入 Clock 取时、
// snapshot 反映当前内存态且为只读投影。迁移方法 / canAccept / apply 属后续故事，不在此测。

import { describe, it, expect } from 'vitest';
import type { Clock } from '../../../ports/clock.js';
import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import { ErrorCode } from '../../../domain/error/error-code.js';
import { StreamSession, type StreamSessionInit } from './stream-session.js';
import { StreamPhaseKind, TerminalSubstate } from './stream-phase.js';
import {
  TerminalReasonCode,
  isUserAbort,
  isErrorReason,
  expectedErrorCode,
} from './terminal-reason.js';
import { RuntimeKind } from '../runtime/runtime-kind.js';
import type {
  AgentStreamEvent,
  ToolUseInfo,
  ToolResultInfo,
  TokenUsage,
  ContextUsage,
} from '../event/agent-stream-event.js';
import { buildFinalContent } from './turn-artifacts.js';

/** FrozenClock —— 恒返回注入固定时刻的假 Clock（确定性测试）。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

/** MutableClock —— 可推进时刻的假 Clock，便于断言取时来源与推进无关性。 */
class MutableClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }
}

const init: StreamSessionInit = {
  id: 'stream-1',
  sessionId: 'c1-session-1',
  runtimeKind: RuntimeKind.CLAUDE_SDK,
};

describe('StreamSession 聚合根壳 + snapshot（c2-2-1）', () => {
  it('构造后初始 phase = active（新回合开始）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
  });

  it('startedAt 取自注入的 Clock.now()，不直调系统时钟', () => {
    const session = new StreamSession(init, new FrozenClock(1_753_970_000_000));
    expect(session.snapshot().startedAt).toBe(1_753_970_000_000);
  });

  it('startedAt 在构造时一次性锁定，Clock 后续推进不改变已落定的 startedAt', () => {
    const clock = new MutableClock(500);
    const session = new StreamSession(init, clock);
    clock.advance(10_000);
    expect(session.snapshot().startedAt).toBe(500);
  });

  it('snapshot 反映构造时注入的 id / sessionId / runtimeKind', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    const snap = session.snapshot();
    expect(snap.id).toBe('stream-1');
    expect(snap.sessionId).toBe('c1-session-1');
    expect(snap.runtimeKind).toBe(RuntimeKind.CLAUDE_SDK);
  });

  it('新回合累积产物初始为空（text/thinking 空串、tool 序列空）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    expect(session.snapshot().artifacts).toEqual({
      text: '',
      thinking: '',
      toolUses: [],
      toolResults: [],
    });
  });

  it('未落终态时 tokenUsage/contextUsage/error/terminalReason/settledAt 均省略（AC-9 不造假）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    const snap = session.snapshot();
    expect(snap.tokenUsage).toBeUndefined();
    expect(snap.contextUsage).toBeUndefined();
    expect(snap.error).toBeUndefined();
    expect(snap.terminalReason).toBeUndefined();
    expect(snap.settledAt).toBeUndefined();
  });

  it('snapshot 为快照投影：改动返回对象不回写聚合根内部态', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    const snap = session.snapshot() as { phase: unknown };
    // 运行时改写快照字段（绕过 readonly 编译约束）不应影响下一次 snapshot。
    snap.phase = { kind: StreamPhaseKind.TERMINAL };
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
  });
});

/** 构造一个 ABORTED 类分类结果假替身（不引入真实 ErrorClassifier）。 */
const abortedError: ClassifiedError = {
  code: ErrorCode.ABORTED,
  messageKey: 'c2.stream.aborted',
  retryable: false,
};

/** 构造一个真实错误类分类结果假替身。 */
const runtimeError: ClassifiedError = {
  code: ErrorCode.SERVER,
  messageKey: 'c2.stream.server_error',
  retryable: false,
};

describe('StreamSession 四迁移方法（c2-2-2 / AC-1）', () => {
  it('active → settling 合法迁移：phase 翻 settling，非终态不落 settledAt', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.markSettling();
    const snap = session.snapshot();
    expect(snap.phase).toEqual({ kind: StreamPhaseKind.SETTLING });
    expect(snap.settledAt).toBeUndefined();
  });

  it('active → settling → terminal(completed) 合法链路可达', () => {
    const session = new StreamSession(init, new FrozenClock(2_000));
    session.markSettling();
    session.complete();
    expect(session.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
  });

  it('complete() 达 terminal(completed)：记 settledAt（经注入 Clock）与归因 COMPLETED', () => {
    const session = new StreamSession(init, new FrozenClock(5_000));
    session.complete();
    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    expect(snap.settledAt).toBe(5_000);
    expect(snap.terminalReason?.code).toBe(TerminalReasonCode.COMPLETED);
    // 正常完成无错误，不造假 ClassifiedError（AC-9）
    expect(snap.terminalReason?.classified).toBeUndefined();
    expect(snap.error).toBeUndefined();
  });

  it('abort(reason) 达 terminal(aborted)：落 error 与归因 USER_ABORTED', () => {
    const session = new StreamSession(init, new FrozenClock(6_000));
    session.abort(abortedError);
    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(snap.error).toBe(abortedError);
    expect(snap.terminalReason?.code).toBe(TerminalReasonCode.USER_ABORTED);
    expect(snap.terminalReason?.classified).toBe(abortedError);
    expect(snap.settledAt).toBe(6_000);
  });

  it('fail(error) 达 terminal(errored)：落 error 与归因 RUNTIME_ERROR', () => {
    const session = new StreamSession(init, new FrozenClock(7_000));
    session.fail(runtimeError);
    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ERRORED,
    });
    expect(snap.error).toBe(runtimeError);
    expect(snap.terminalReason?.code).toBe(TerminalReasonCode.RUNTIME_ERROR);
    expect(snap.terminalReason?.classified).toBe(runtimeError);
    expect(snap.settledAt).toBe(7_000);
  });

  it('markSettling 幂等：settling 后再调 markSettling 为 no-op（phase 不变、不抛）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.markSettling();
    expect(() => session.markSettling()).not.toThrow();
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.SETTLING });
  });

  it('终态后再调 complete/abort/fail/markSettling 幂等 no-op（phase 与终态字段不变、不抛）', () => {
    const clock = new MutableClock(3_000);
    const session = new StreamSession(init, clock);
    session.complete();
    const settledAt = session.snapshot().settledAt;

    // 时钟推进后再调各迁移方法，均应 no-op：phase 停在 completed、settledAt 不被覆盖
    clock.advance(10_000);
    expect(() => session.complete()).not.toThrow();
    expect(() => session.abort(abortedError)).not.toThrow();
    expect(() => session.fail(runtimeError)).not.toThrow();
    expect(() => session.markSettling()).not.toThrow();

    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    expect(snap.settledAt).toBe(settledAt);
    expect(snap.error).toBeUndefined();
    expect(snap.terminalReason?.code).toBe(TerminalReasonCode.COMPLETED);
  });

  it('非法迁移被拒：terminal → active/settling 无路径（无公开方法可回退，且再调终态迁移 no-op）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.abort(abortedError);
    // 终态吸收：任何迁移方法都不能让 phase 迁出 terminal(aborted)
    session.markSettling();
    session.complete();
    session.fail(runtimeError);
    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    // 首次 abort 的归因/错误保持不变，未被后续 fail 污染
    expect(snap.terminalReason?.code).toBe(TerminalReasonCode.USER_ABORTED);
    expect(snap.error).toBe(abortedError);
  });

  it('active 直接 complete/abort/fail：无需先 settling 亦可落终态（* → terminal）', () => {
    const c = new StreamSession(init, new FrozenClock(1));
    c.complete();
    expect(c.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });

    const a = new StreamSession(init, new FrozenClock(1));
    a.abort(abortedError);
    expect(a.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });

    const f = new StreamSession(init, new FrozenClock(1));
    f.fail(runtimeError);
    expect(f.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ERRORED,
    });
  });
});

describe('StreamSession.canAccept —— isStreaming gate 唯一判据（c2-2-4 / FR-1.6 / AC-3）', () => {
  // 语义（§3.2 / AC-3）：canAccept() ≡ phase.kind !== ACTIVE。
  // active 进行中 → false（composer 不可发送）；settling / 任一 terminal 子态 → true（gate 已开）。

  it('active 进行中：canAccept() === false（回合生成中，composer 不可发送）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
    expect(session.canAccept()).toBe(false);
  });

  it('settling 收尾中：canAccept() === true（已离开 active，gate 已开）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.markSettling();
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.SETTLING });
    expect(session.canAccept()).toBe(true);
  });

  it('terminal(completed)：canAccept() === true（回合已结束，输入恢复可用）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.complete();
    expect(session.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    expect(session.canAccept()).toBe(true);
  });

  it('terminal(aborted)：abort 到 terminal 后 canAccept() === true（#578 招牌，输入立即恢复不卡死）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    // 前置：active 态 gate 关闭。
    expect(session.canAccept()).toBe(false);
    session.abort(abortedError);
    expect(session.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(session.canAccept()).toBe(true);
  });

  it('terminal(errored)：canAccept() === true（出错终止后输入亦恢复可用）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.fail(runtimeError);
    expect(session.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ERRORED,
    });
    expect(session.canAccept()).toBe(true);
  });

  it('全态判据自检：canAccept() ⇔ phase.kind !== ACTIVE（active 唯一 false，其余皆 true）', () => {
    // active → false
    const active = new StreamSession(init, new FrozenClock(1_000));
    expect(active.canAccept()).toBe(active.snapshot().phase.kind !== StreamPhaseKind.ACTIVE);
    expect(active.canAccept()).toBe(false);

    // settling → true
    const settling = new StreamSession(init, new FrozenClock(1_000));
    settling.markSettling();
    expect(settling.canAccept()).toBe(settling.snapshot().phase.kind !== StreamPhaseKind.ACTIVE);
    expect(settling.canAccept()).toBe(true);

    // terminal(aborted) → true
    const terminal = new StreamSession(init, new FrozenClock(1_000));
    terminal.abort(abortedError);
    expect(terminal.canAccept()).toBe(terminal.snapshot().phase.kind !== StreamPhaseKind.ACTIVE);
    expect(terminal.canAccept()).toBe(true);
  });

  it('active → settling gate 翻转：同一 session 生命周期内 canAccept 由 false 翻 true 一次到位', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    expect(session.canAccept()).toBe(false);
    session.markSettling();
    expect(session.canAccept()).toBe(true);
    session.complete();
    expect(session.canAccept()).toBe(true);
  });
});

/**
 * HangingInterruptRuntime —— 可注入「interrupt 永不 resolve」的假 AgentRuntimePort。
 *
 * 复现 GitHub #578 的病态运行时：优雅 interrupt 返回一个永挂 Promise（既不 resolve 也不 reject）。
 * 若聚合根的 abort 相位翻转被排在该 interrupt 的 then/finally 里，phase 将永远卡在 active、
 * canAccept() 永远 false、composer 永久锁死。本假替身用于证明：聚合根 abort() 的 force-abort
 * 相位翻转独立于且先行于 interrupt，永挂也不卡死。
 */
class HangingInterruptRuntime {
  /** 记录 interrupt 是否被调用过——证明它可以「压根没触发」abort 也已生效。 */
  interruptCalled = false;

  interrupt(_turnRef: unknown): Promise<string | null> {
    this.interruptCalled = true;
    // 永挂：既不 resolve 也不 reject（模拟卡死的上游中断）。
    return new Promise<string | null>(() => {
      /* 故意永不 settle */
    });
  }
}

describe('#578 反例回归：force-abort 无条件先行、interrupt 永挂不卡死（c2-2-3 / AC-2/AC-4/AC-5）', () => {
  it('interrupt 永不 resolve 时，abort 命令一到 phase 立即无条件翻 terminal(aborted)、canAccept()=true', () => {
    const session = new StreamSession(init, new FrozenClock(9_000));
    // 前置：active 态、gate 关闭（不可发送）。
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
    expect(session.canAccept()).toBe(false);

    // 病态运行时：interrupt 永挂。即便订阅它也永远拿不到结果。
    const runtime = new HangingInterruptRuntime();
    const hanging = runtime.interrupt({ streamId: init.id });
    let interruptSettled = false;
    void hanging.then(
      () => {
        interruptSettled = true;
      },
      () => {
        interruptSettled = true;
      },
    );

    // 关键：abort() 无条件先行——不 await、不依赖 hanging 的 then/finally。
    session.abort(abortedError);

    // 断言：即便没有任何 interrupt resolve，phase 已同步落 terminal(aborted)。
    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    // composer 立即解锁，不卡死（#578 招牌观测点）。
    expect(session.canAccept()).toBe(true);
    // 证据：interrupt 确实被触发过，但其永挂状态完全不影响 phase 翻转。
    expect(runtime.interruptCalled).toBe(true);
    expect(interruptSettled).toBe(false);
  });

  it('abort 归因为 USER_ABORTED → ErrorCode.ABORTED，绝不显示成"出错了"（AC-5）', () => {
    const session = new StreamSession(init, new FrozenClock(9_000));
    session.abort(abortedError);
    const snap = session.snapshot();

    // 归因码是「我停的」，不是错误终止。
    expect(snap.terminalReason?.code).toBe(TerminalReasonCode.USER_ABORTED);
    expect(isUserAbort(snap.terminalReason!.code)).toBe(true);
    expect(isErrorReason(snap.terminalReason!.code)).toBe(false);
    // 期望错误码映射为 ABORTED（独立类，非 SERVER/PROCESS 等真实错误）。
    expect(expectedErrorCode(TerminalReasonCode.USER_ABORTED)).toBe(ErrorCode.ABORTED);
    expect(snap.error?.code).toBe(ErrorCode.ABORTED);
    expect(snap.terminalReason?.classified?.code).toBe(ErrorCode.ABORTED);
    // 落 terminal(aborted) 子态，而非 errored——UI 据此区分「我停的」而非"出错了"。
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
  });

  it('settling 中途 interrupt 永挂时 abort 仍无条件收敛：settling → terminal(aborted)、canAccept()=true', () => {
    const clock = new MutableClock(1_000);
    const session = new StreamSession(init, clock);
    // 已请求中断，进入 settling（此时若等 interrupt resolve 才翻终态，永挂就会卡死）。
    session.markSettling();
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.SETTLING });
    expect(session.canAccept()).toBe(true); // settling 已非 active，gate 已开

    const runtime = new HangingInterruptRuntime();
    void runtime.interrupt({ streamId: init.id }); // 永挂

    // force-abort 安全网到期（用假 Clock 手动推进模拟超时），无条件 abort。
    clock.advance(5_000);
    session.abort(abortedError);

    const snap = session.snapshot();
    expect(snap.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(snap.settledAt).toBe(6_000); // 经注入 Clock 取时，非系统时钟
    expect(session.canAccept()).toBe(true);
    expect(runtime.interruptCalled).toBe(true);
  });
});

/** 构造 ToolUseInfo 假替身。 */
function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseInfo {
  return { id, name, input };
}

/** 构造 ToolResultInfo 假替身。 */
function toolResult(toolUseId: string, content: string, isError = false): ToolResultInfo {
  return { toolUseId, content, isError };
}

describe('StreamSession.apply —— 事件累积到 TurnArtifacts（c2-2-5 / §3.2/§3.5）', () => {
  it('text 事件是累积后的全文（非增量）：整体替换，不拼接', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: '你好' });
    session.apply({ type: 'text', text: '你好，世界' }); // 全文覆盖，非追加
    expect(session.snapshot().artifacts.text).toBe('你好，世界');
  });

  it('thinking 事件是增量 delta：多次 apply 依序追加', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'thinking', delta: '先想一' });
    session.apply({ type: 'thinking', delta: '想再答' });
    expect(session.snapshot().artifacts.thinking).toBe('先想一想再答');
  });

  it('tool_use / tool_result 按产出顺序收集进各自序列', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    const u1 = toolUse('t1', 'read_file', { path: '/a' });
    const u2 = toolUse('t2', 'grep', { pattern: 'foo' });
    const r1 = toolResult('t1', 'file body');
    session.apply({ type: 'tool_use', tool: u1 });
    session.apply({ type: 'tool_use', tool: u2 });
    session.apply({ type: 'tool_result', result: r1 });
    const { toolUses, toolResults } = session.snapshot().artifacts;
    expect(toolUses).toEqual([u1, u2]);
    expect(toolResults).toEqual([r1]);
  });

  it('多类事件混合累积后 snapshot.artifacts 正确反映各累积态', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: '答案' });
    session.apply({ type: 'thinking', delta: '思考' });
    session.apply({ type: 'tool_use', tool: toolUse('t1', 'ls') });
    session.apply({ type: 'tool_result', result: toolResult('t1', 'ok') });
    expect(session.snapshot().artifacts).toEqual({
      text: '答案',
      thinking: '思考',
      toolUses: [toolUse('t1', 'ls')],
      toolResults: [toolResult('t1', 'ok')],
    });
  });

  it('result 事件：Runtime 上报 tokenUsage 时存投影；未上报则字段省略（AC-9 不填 0）', () => {
    const withUsage = new StreamSession(init, new FrozenClock(1_000));
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 20 };
    withUsage.apply({ type: 'result', tokenUsage: usage });
    expect(withUsage.snapshot().tokenUsage).toBe(usage);

    const noUsage = new StreamSession(init, new FrozenClock(1_000));
    noUsage.apply({ type: 'result' }); // 未上报 tokenUsage
    expect(noUsage.snapshot().tokenUsage).toBeUndefined(); // 不造假 0
  });

  it('context_usage 事件：存 ContextUsage 投影', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    const ctx: ContextUsage = { usedTokens: 1_000, maxTokens: 200_000 };
    session.apply({ type: 'context_usage', usage: ctx });
    expect(session.snapshot().contextUsage).toBe(ctx);
  });

  it('旁路信号事件（tool_output/status/error/permission_*/rate_limit/file_changed/phase_changed）不改累积产物', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    const bypass: AgentStreamEvent[] = [
      { type: 'tool_output', data: 'stdout' },
      { type: 'status', text: '运行中' },
      {
        type: 'error',
        error: { code: ErrorCode.SERVER, messageKey: 'c2.stream.server_error', retryable: false },
      },
      {
        type: 'permission_request',
        request: { id: 'p1', toolName: 'bash', input: {} },
      },
      { type: 'permission_resolved', permissionRequestId: 'p1', status: 'allow' },
      { type: 'rate_limit', info: { scope: 'requests' } },
      { type: 'file_changed', paths: ['/a', '/b'] },
      { type: 'phase_changed', phase: { kind: StreamPhaseKind.SETTLING } },
    ];
    for (const e of bypass) {
      session.apply(e);
    }
    // 产物仍为空初值；旁路事件也不改 phase（apply 从不改相位）。
    expect(session.snapshot().artifacts).toEqual({
      text: '',
      thinking: '',
      toolUses: [],
      toolResults: [],
    });
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
  });

  it('apply 从不改 phase：active/settling 下累积后相位不变', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: 'x' });
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
    session.markSettling();
    session.apply({ type: 'text', text: 'y' }); // settling 下仍可累积
    expect(session.snapshot().artifacts.text).toBe('y');
    expect(session.snapshot().phase).toEqual({ kind: StreamPhaseKind.SETTLING });
  });

  it('终态后 apply 迟到事件被忽略（no-op、不抛、产物定格不被改写）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: '定格内容' });
    session.complete();
    // 终态后迟到事件：一律忽略，产物不被改写。
    expect(() => session.apply({ type: 'text', text: '迟到覆盖' })).not.toThrow();
    session.apply({ type: 'thinking', delta: '迟到思考' });
    session.apply({ type: 'tool_use', tool: toolUse('late', 'x') });
    expect(session.snapshot().artifacts).toEqual({
      text: '定格内容',
      thinking: '',
      toolUses: [],
      toolResults: [],
    });
  });

  it('complete 后 buildFinalContent(累积产物) 反映累积的纯文本内容', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: '这是最终回答' });
    session.complete();
    // 纯文本回合 → buildFinalContent 返回文本原文。
    expect(buildFinalContent(session.snapshot().artifacts)).toBe('这是最终回答');
  });

  it('complete 后 buildFinalContent 反映复合产物（含 thinking/tool → blocks JSON）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: '答' });
    session.apply({ type: 'thinking', delta: '想' });
    session.apply({ type: 'tool_use', tool: toolUse('t1', 'ls', { dir: '/' }) });
    session.apply({ type: 'tool_result', result: toolResult('t1', 'a\nb') });
    session.complete();
    const content = buildFinalContent(session.snapshot().artifacts);
    expect(content).not.toBeNull();
    // 复合回合序列化为有序 blocks[]（text → thinking → tool_use* → tool_result*）。
    expect(JSON.parse(content!)).toEqual([
      { type: 'text', text: '答' },
      { type: 'thinking', thinking: '想' },
      { type: 'tool_use', id: 't1', name: 'ls', input: { dir: '/' } },
      { type: 'tool_result', toolUseId: 't1', content: 'a\nb', isError: false },
    ]);
  });

  it('空回合（无任何 apply）complete → buildFinalContent 返回 null（空回合不落库 FR-2.6）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.complete();
    expect(buildFinalContent(session.snapshot().artifacts)).toBeNull();
    // 且 snapshot 亦不携带 finalContent（settleTerminal 只在非 null 才记）。
    expect(session.snapshot().finalContent).toBeUndefined();
  });

  it('仅旁路事件（无 text/thinking/tool 累积）complete → 视为空回合，buildFinalContent 返回 null', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'status', text: '运行中' });
    session.apply({ type: 'context_usage', usage: { usedTokens: 5, maxTokens: 100 } });
    session.complete();
    // 旁路事件不进 TurnArtifacts，产物仍全空 → 空回合。
    expect(buildFinalContent(session.snapshot().artifacts)).toBeNull();
    expect(session.snapshot().finalContent).toBeUndefined();
  });

  it('非空回合 complete → snapshot().finalContent 等于 buildFinalContent 投影结果（供 c2-4 落库读取）', () => {
    const session = new StreamSession(init, new FrozenClock(1_000));
    session.apply({ type: 'text', text: '你好世界' });
    session.complete();
    const snap = session.snapshot();
    const expected = buildFinalContent(snap.artifacts);
    // finalContent 必须被 snapshot 投影出来（非 undefined），且等于 buildFinalContent 结果——
    // 防止 StartStreamService 落库时读到 undefined 而空落库（FR-2.5/2.6）。
    expect(expected).not.toBeNull();
    expect(snap.finalContent).toBe(expected);
  });
});
