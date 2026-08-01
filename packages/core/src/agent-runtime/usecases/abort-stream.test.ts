// agent-runtime/usecases/abort-stream.test.ts
// C2 · AgentRuntime —— AbortStreamService 幂等门 + force-abort 无条件先行 + markSettling 单测
//（对齐 SPEC CAP-2、architecture §4.2、PRD FR-3.1/3.2/1.5 / AC-4，故事 c2-5-2）。
//
// 覆盖：
//   - 非 active 回合（本就 terminal / 先 abort 掉）→ abort 为 no-op（schedule/markSettling/interrupt 均未调）。
//   - active 回合 abort：schedule 调用序列【早于】任何 interrupt（AC-4，用共享调用序列数组断言）；
//     markSettling 被调、phase=settling。
// interrupt 抛错时 force-abort 仍已安排的断言先立骨架（c2-5-3 interrupt 接入后补全完整时序）。
// 全部用假端口 + 假 Clock 纯单元测试，无 dev server / 无真实 SDK-进程-网络。

import { describe, it, expect } from 'vitest';
import type { Clock } from '../../ports/clock.js';
import { defaultErrorClassifier } from '../../ports/error-classifier.js';
import { ErrorCode } from '../../domain/error/error-code.js';
import { StreamPhaseKind, TerminalSubstate, isActive } from '../domain/stream/stream-phase.js';
import { TerminalReasonCode } from '../domain/stream/terminal-reason.js';
import { StreamSession } from '../domain/stream/stream-session.js';
import { RuntimeKind } from '../domain/runtime/runtime-kind.js';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
} from '../ports/driven/agent-runtime-port.js';
import type { AgentStreamEvent } from '../domain/event/agent-stream-event.js';
import type { RuntimeAvailability } from '../ports/runtime-kind.js';
import type { ForceAbortScheduler } from '../ports/driven/force-abort-scheduler.js';
import { StreamSessionRegistry } from './stream-session-registry.js';
import { AbortStreamService } from './abort-stream.js';

/** FrozenClock —— 恒返回注入固定时刻的假 Clock（确定性构造 StreamSession.startedAt）。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number = 1_000) {}
  now(): number {
    return this.fixed;
  }
}

/**
 * MutableClock —— now() 每次返回 current 当前值，可在测试中推进。
 * 用于坐实 settledAt「收敛后不被兜底回调二次写」的真断言（推进时钟后若误再翻终态，
 * settledAt 会变，断言即失败）。
 */
class MutableClock implements Clock {
  constructor(public current: number = 1_000) {}
  now(): number {
    return this.current;
  }
}

/**
 * 共享调用序列记录 —— 断言 schedule 与 interrupt 的调用先后（AC-4）。
 * 假件把各自调用名 push 进同一数组，据下标先后断言时序。
 */
type CallTag = 'schedule' | 'interrupt' | 'forceKillTurn';

/**
 * FakeForceAbortScheduler —— 记录被安排的 callback/delayMs，可手动 fire、可 spy cancel（AC-4）。
 * schedule 被调时向共享序列 push 'schedule'（用于断言先行）。
 */
class FakeForceAbortScheduler implements ForceAbortScheduler {
  scheduled: { callback: () => void; delayMs: number } | undefined;
  scheduleCount = 0;
  cancelCount = 0;

  constructor(private readonly sequence: CallTag[]) {}

  schedule(callback: () => void, delayMs: number): () => void {
    this.scheduleCount += 1;
    this.scheduled = { callback, delayMs };
    this.sequence.push('schedule');
    return () => {
      this.cancelCount += 1;
    };
  }

  /** 手动触发已安排的到期回调（模拟定时器 fire）。 */
  fire(): void {
    this.scheduled?.callback();
  }
}

/**
 * FakeAgentRuntimePort —— spy interrupt / forceKillTurn 调用（记录 turnRef、向共享序列 push）。
 * interrupt 默认返回永不 resolve 的 Promise（模拟 #578 挂起场景，c2-5-3 补全断言用）。
 */
class FakeAgentRuntimePort implements AgentRuntimePort {
  interruptCalls: TurnRef[] = [];
  forceKillCalls: TurnRef[] = [];

  constructor(
    private readonly sequence: CallTag[],
    private readonly interruptImpl: (turnRef: TurnRef) => Promise<string | null> = () =>
      new Promise<string | null>(() => {}),
  ) {}

  run(_request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent> {
    throw new Error('run 不应被 AbortStreamService 调用');
  }

  interrupt(turnRef: TurnRef): Promise<string | null> {
    this.interruptCalls.push(turnRef);
    this.sequence.push('interrupt');
    return this.interruptImpl(turnRef);
  }

  forceKillTurn(turnRef: TurnRef): void {
    this.forceKillCalls.push(turnRef);
    this.sequence.push('forceKillTurn');
  }

  availability(): Promise<RuntimeAvailability> {
    return Promise.resolve({ kind: 'unknown' });
  }

  resolvePermission(): void {
    // AbortStreamService 不触达权限决议，占位满足接口（c2-7 端口扩展）。
  }
}

/** 构造一个已注册的 active StreamSession + registry。 */
function makeActiveSession(streamId = 'stream-1'): {
  registry: StreamSessionRegistry;
  session: StreamSession;
} {
  const registry = new StreamSessionRegistry();
  const session = new StreamSession(
    { id: streamId, sessionId: 'c1-session-1', runtimeKind: RuntimeKind.CLAUDE_SDK },
    new FrozenClock(),
  );
  registry.register(session);
  return { registry, session };
}

/**
 * 组装被测服务 + 假件。
 * @param registry 已注册回合的 registry。
 * @param interruptImpl 可选：注入 interrupt 行为（默认永不 resolve，模拟 #578 挂起）。
 */
function makeService(
  registry: StreamSessionRegistry,
  interruptImpl?: (turnRef: TurnRef) => Promise<string | null>,
) {
  const sequence: CallTag[] = [];
  const scheduler = new FakeForceAbortScheduler(sequence);
  const runtime = new FakeAgentRuntimePort(sequence, interruptImpl);
  const service = new AbortStreamService(
    runtime,
    registry,
    scheduler,
    defaultErrorClassifier,
    new FrozenClock(),
  );
  return { service, scheduler, runtime, sequence };
}

/** 让所有已排入的微任务跑完（fire-and-forget 的 interrupt.then 收敛在微任务队列里完成）。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AbortStreamService.abort —— 幂等门 + force-abort 无条件先行 + markSettling（c2-5-2）', () => {
  it('无 session（registry 取不到）→ 幂等 no-op：schedule / interrupt 均未调（FR-3.1）', async () => {
    const registry = new StreamSessionRegistry();
    const { service, scheduler, runtime } = makeService(registry);

    await service.abort('missing-stream');

    expect(scheduler.scheduleCount).toBe(0);
    expect(runtime.interruptCalls).toHaveLength(0);
  });

  it('回合已 terminal（非 active）→ 幂等 no-op：schedule / markSettling / interrupt 均未调（FR-3.1）', async () => {
    const { registry, session } = makeActiveSession();
    // 先把回合翻 terminal(aborted)，使其非 active。
    session.abort(defaultErrorClassifier.classify(Object.assign(new Error('x'), { name: 'AbortError' })));
    expect(isActive(session.snapshot().phase)).toBe(false);

    const { service, scheduler, runtime } = makeService(registry);
    await service.abort('stream-1');

    expect(scheduler.scheduleCount).toBe(0);
    expect(runtime.interruptCalls).toHaveLength(0);
    // phase 未被本次 abort 改动（仍是先前的 terminal(aborted)）。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.TERMINAL);
  });

  it('active 回合 abort：force-abort 安全网被安排、markSettling 被调、phase=settling（FR-3.2/1.5）', async () => {
    const { registry, session } = makeActiveSession();
    const { service, scheduler } = makeService(registry);

    await service.abort('stream-1');

    // 安全网被安排一次，延时为 FORCE_ABORT_MS 默认（>0）。
    expect(scheduler.scheduleCount).toBe(1);
    expect(scheduler.scheduled?.delayMs).toBeGreaterThan(0);
    // markSettling 生效：phase = settling。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.SETTLING);
  });

  it('active 回合 abort：schedule 调用序列【早于】任何 interrupt（AC-4，#578 时序铁律）', async () => {
    const { registry } = makeActiveSession();
    const { service, sequence } = makeService(registry);

    await service.abort('stream-1');

    // 安全网必须已安排。
    expect(sequence).toContain('schedule');
    // 若本故事/后续故事发出了 interrupt，schedule 的下标必须严格早于首个 interrupt（force-abort 无条件先行）。
    const scheduleIdx = sequence.indexOf('schedule');
    const interruptIdx = sequence.indexOf('interrupt');
    if (interruptIdx !== -1) {
      expect(scheduleIdx).toBeLessThan(interruptIdx);
    }
    // 且 schedule 是整条序列的第一个动作（早于且独立于 interrupt）。
    expect(sequence[0]).toBe('schedule');
  });

  it('force-abort 到期回调：回合已被外部翻 terminal → 回调 no-op（幂等，不二次翻/不 forceKill）', async () => {
    const { registry, session } = makeActiveSession();
    const { service, scheduler, runtime } = makeService(registry);

    await service.abort('stream-1');
    // 模拟 interrupt 已让回合收敛（外部翻 terminal）。
    session.abort(defaultErrorClassifier.classify(Object.assign(new Error('x'), { name: 'AbortError' })));
    const phaseBefore = session.snapshot().phase;

    // 到期 fire：回合已 terminal → 回调 no-op（不二次翻、不 forceKill）。
    scheduler.fire();

    expect(session.snapshot().phase).toBe(phaseBefore);
    // 已收敛回合不再 forceKill（到期回调 !isTerminal 守卫拦截）。
    expect(runtime.forceKillCalls).toHaveLength(0);
  });
});

describe('AbortStreamService.abort —— best-effort interrupt + reconcilePhase 收敛（c2-5-3 / FR-3.3）', () => {
  it("interrupt 返回 'interrupted' → reconcile 翻 terminal(aborted)、canAccept()=true", async () => {
    const { registry, session } = makeActiveSession();
    const { service } = makeService(registry, () => Promise.resolve('interrupted'));

    await service.abort('stream-1');
    await flushMicrotasks();

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ABORTED,
    );
    expect(session.canAccept()).toBe(true);
    // 归因经 ErrorClassifier 归 ABORTED（AC-5，与真实错误 code 不同）。
    expect(session.snapshot().error?.code).toBe(ErrorCode.ABORTED);
  });

  it("interrupt 返回 'idle' → reconcile 翻 terminal(completed)、canAccept()=true", async () => {
    const { registry, session } = makeActiveSession();
    const { service } = makeService(registry, () => Promise.resolve('idle'));

    await service.abort('stream-1');
    await flushMicrotasks();

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.COMPLETED,
    );
    expect(session.canAccept()).toBe(true);
  });

  it("interrupt 返回 'error' → reconcile 翻 terminal(errored)、归因非 ABORTED", async () => {
    const { registry, session } = makeActiveSession();
    const { service } = makeService(registry, () => Promise.resolve('error'));

    await service.abort('stream-1');
    await flushMicrotasks();

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ERRORED,
    );
    expect(session.canAccept()).toBe(true);
    // errored 归因不是 ABORTED（AC-5 区分「我停的」vs「出错了」）。
    expect(session.snapshot().error?.code).not.toBe(ErrorCode.ABORTED);
  });

  it("interrupt 返回 'running' → 不纠正：phase 仍 settling，等安全网兜底", async () => {
    const { registry, session } = makeActiveSession();
    const { service } = makeService(registry, () => Promise.resolve('running'));

    await service.abort('stream-1');
    await flushMicrotasks();

    // running/未知 reconcile 返回 null → 不纠正，phase 仍停 settling。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.SETTLING);
  });

  it('interrupt 返回 null → 不纠正：phase 仍 settling，等安全网兜底', async () => {
    const { registry, session } = makeActiveSession();
    const { service } = makeService(registry, () => Promise.resolve(null));

    await service.abort('stream-1');
    await flushMicrotasks();

    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.SETTLING);
  });

  it('reconcile 收敛后 cancel 未到期的安全网（避免多余触发）', async () => {
    const { registry } = makeActiveSession();
    const { service, scheduler } = makeService(registry, () => Promise.resolve('interrupted'));

    await service.abort('stream-1');
    await flushMicrotasks();

    // 收敛成功后取消安全网。
    expect(scheduler.cancelCount).toBe(1);
  });
});

describe('AbortStreamService.abort —— #578 招牌回归：interrupt 永挂仍被安全网兜底翻终态（AC-2）', () => {
  it('假 interrupt 永不 resolve + 手动 fire force-abort 定时器 → phase=terminal(aborted)、canAccept()=true', async () => {
    const { registry, session } = makeActiveSession();
    // 默认 interruptImpl 即永不 resolve 的 Promise（模拟 Runtime 无响应）。
    const { service, scheduler, runtime } = makeService(registry);

    await service.abort('stream-1');
    await flushMicrotasks();

    // interrupt 永挂 → reconcile 从未执行 → phase 仍停 settling（尚未翻终态）。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.SETTLING);
    // 但 abort 编排已走完返回（未被永挂的 interrupt 阻塞），且安全网已安排。
    expect(scheduler.scheduleCount).toBe(1);
    expect(runtime.interruptCalls).toHaveLength(1);

    // 手动 fire force-abort 定时器（模拟到期）→ 安全网无条件兜底翻终态。
    scheduler.fire();

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ABORTED,
    );
    // #578 用户可见症状解除：composer 立即解锁。
    expect(session.canAccept()).toBe(true);
    // 归因经 ErrorClassifier 归 ABORTED（FR-3.4）。
    expect(session.snapshot().error?.code).toBe(ErrorCode.ABORTED);
    // 兜底路径关句柄：forceKillTurn 被调、turnRef.streamId 正确（AC-6）。
    expect(runtime.forceKillCalls).toHaveLength(1);
    expect(runtime.forceKillCalls[0]?.streamId).toBe('stream-1');
  });

  it('interrupt 抛错（reject）→ 不影响：安全网仍已安排、phase 不被翻回 active', async () => {
    const { registry, session } = makeActiveSession();
    const { service, scheduler } = makeService(registry, () =>
      Promise.reject(new Error('interrupt failed')),
    );

    await service.abort('stream-1');
    await flushMicrotasks();

    // .catch 只吞错：phase 未被翻回 active（仍 settling，等安全网）。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.SETTLING);
    // 安全网仍已安排（独立于 interrupt 成败）。
    expect(scheduler.scheduleCount).toBe(1);

    // 安全网到期兜底照常翻终态。
    scheduler.fire();
    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ABORTED,
    );
    expect(session.canAccept()).toBe(true);
  });
});

describe('AbortStreamService.abort —— force-abort 到期兜底：仍 active 则 abort(ABORTED)+forceKillTurn（c2-5-4 / CAP-4 / FR-3.2/3.4/3.5 / AC-5/AC-6）', () => {
  /**
   * 组装被测服务 + 假件，但用可推进的 MutableClock 构造 StreamSession，
   * 以坐实「收敛后兜底回调 no-op、settledAt 不被二次写」的真断言。
   */
  function makeServiceWithMutableClock(
    interruptImpl?: (turnRef: TurnRef) => Promise<string | null>,
  ) {
    const registry = new StreamSessionRegistry();
    const clock = new MutableClock(1_000);
    const session = new StreamSession(
      { id: 'stream-1', sessionId: 'c1-session-1', runtimeKind: RuntimeKind.CLAUDE_SDK },
      clock,
    );
    registry.register(session);
    const sequence: CallTag[] = [];
    const scheduler = new FakeForceAbortScheduler(sequence);
    const runtime = new FakeAgentRuntimePort(sequence, interruptImpl);
    const service = new AbortStreamService(
      runtime,
      registry,
      scheduler,
      defaultErrorClassifier,
      clock,
    );
    return { service, scheduler, runtime, session, clock };
  }

  it('interrupt 永挂 → fire 定时器 → session.abort(ABORTED)（phase=terminal(aborted)、canAccept()=true）+ forceKillTurn 被调、turnRef.streamId 正确（AC-6）', async () => {
    const { registry, session } = makeActiveSession();
    // 默认 interruptImpl 即永不 resolve（模拟 Runtime 无响应）。
    const { service, scheduler, runtime } = makeService(registry);

    await service.abort('stream-1');
    await flushMicrotasks();

    // interrupt 永挂 → 尚未收敛 → phase 仍 settling。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.SETTLING);

    // 手动 fire 到期定时器 → 仍未终态 → 无条件翻 terminal(aborted)。
    scheduler.fire();

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ABORTED,
    );
    // #578 用户可见症状解除：composer 立即解锁（这坐实 c2-5-3 招牌回归为真断言）。
    expect(session.canAccept()).toBe(true);
    // 兜底关句柄（FR-3.5）：forceKillTurn 被调一次、turnRef.streamId 正确（AC-6）。
    expect(runtime.forceKillCalls).toHaveLength(1);
    expect(runtime.forceKillCalls[0]?.streamId).toBe('stream-1');
  });

  it("interrupt 已让回合 terminal（返回 'interrupted'）→ fire 定时器 → 回调 no-op（幂等：phase/settledAt 不变、不 forceKill）", async () => {
    const { service, scheduler, runtime, session, clock } = makeServiceWithMutableClock(() =>
      Promise.resolve('interrupted'),
    );

    await service.abort('stream-1');
    await flushMicrotasks();

    // interrupt 已收敛 → terminal(aborted)，记下当时快照与 settledAt。
    const phaseBefore = session.snapshot().phase;
    const settledAtBefore = session.snapshot().settledAt;
    expect(phaseBefore.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(settledAtBefore).toBe(1_000);

    // 推进时钟：若兜底回调误再翻终态，settledAt 会被写成新值，断言即失败。
    clock.current = 9_999;
    // 即便收敛后已 cancel，此处仍手动 fire 一次，坐实到期回调本身的 !isTerminal 幂等守卫。
    scheduler.fire();

    // 回调 no-op：phase 引用不变、settledAt 不变、不二次 forceKill。
    expect(session.snapshot().phase).toBe(phaseBefore);
    expect(session.snapshot().settledAt).toBe(settledAtBefore);
    expect(runtime.forceKillCalls).toHaveLength(0);
  });

  it('兜底 abort 归因 ClassifiedError.code === ABORTED（AC-5，与真实错误 code 不同）', async () => {
    const { registry, session } = makeActiveSession();
    const { service, scheduler } = makeService(registry);

    await service.abort('stream-1');
    await flushMicrotasks();
    scheduler.fire();

    // 兜底归因经 SK.ErrorClassifier 归 ABORTED——不是 errored 的真实错误 code（区分「我停的」vs「出错了」）。
    expect(session.snapshot().error?.code).toBe(ErrorCode.ABORTED);
    expect(session.snapshot().error?.code).not.toBe(ErrorCode.UNKNOWN);
  });

  it("收敛路径下 cancel 被调（安全网不多余触发）——interrupt 返回 'interrupted'", async () => {
    const { registry } = makeActiveSession();
    const { service, scheduler } = makeService(registry, () => Promise.resolve('interrupted'));

    await service.abort('stream-1');
    await flushMicrotasks();

    // 收敛成功后取消未到期的安全网（cancel + 聚合根幂等，两层防线）。
    expect(scheduler.cancelCount).toBe(1);
  });
});

describe('AbortStreamService.abort —— 关 turn/句柄通知契约（c2-5-5 / CAP-5 / FR-3.5 / AC-6）', () => {
  it('优雅收敛路径 → interrupt 被调、传入 turnRef.streamId 正确', async () => {
    const { registry } = makeActiveSession();
    const { service, runtime } = makeService(registry, () => Promise.resolve('interrupted'));

    await service.abort('stream-1');
    await flushMicrotasks();

    // 优雅路径：interrupt 被调一次，turnRef.streamId 正确（AC-6）。
    expect(runtime.interruptCalls).toHaveLength(1);
    expect(runtime.interruptCalls[0]?.streamId).toBe('stream-1');
  });

  it('兜底路径（interrupt 永挂 + fire 定时器）→ forceKillTurn 被调、传入 turnRef.streamId 正确', async () => {
    const { registry } = makeActiveSession();
    // 默认 interruptImpl 即永不 resolve（模拟 Runtime 无响应，走兜底路径）。
    const { service, scheduler, runtime } = makeService(registry);

    await service.abort('stream-1');
    await flushMicrotasks();
    scheduler.fire();

    // 兜底路径：forceKillTurn 被调一次，turnRef.streamId 正确（AC-6）。
    expect(runtime.forceKillCalls).toHaveLength(1);
    expect(runtime.forceKillCalls[0]?.streamId).toBe('stream-1');
  });

  it('核心不消费 TurnRef.handle —— 传入端口的 turnRef 仅设 streamId（handle 恒 undefined，结构归适配器 c2-6 解析）', async () => {
    const { registry } = makeActiveSession();
    // 优雅路径与兜底路径都触发：interrupt 永挂后 fire 定时器，收集两条 turnRef。
    const { service, scheduler, runtime } = makeService(registry);

    await service.abort('stream-1');
    await flushMicrotasks();
    scheduler.fire();

    // 优雅路径 interrupt 与兜底路径 forceKillTurn 传入的 turnRef 均只含 streamId、不含 handle 句柄。
    // 核心侧【绝不】构造/触碰 handle；late-unregister no-op 语义归适配器 c2-6，不在核心断言。
    const allRefs: TurnRef[] = [...runtime.interruptCalls, ...runtime.forceKillCalls];
    expect(allRefs).toHaveLength(2);
    for (const ref of allRefs) {
      expect(ref.streamId).toBe('stream-1');
      expect(ref.handle).toBeUndefined();
      // turnRef 仅有 streamId 一个 own key（核心未附加/未解释任何 handle 结构）。
      expect(Object.keys(ref)).toEqual(['streamId']);
    }
  });

  it('只含 streamId 的 turnRef 即可正常工作 —— 核心不依赖 handle 存在（假适配器 spy）', async () => {
    const { registry, session } = makeActiveSession();
    // 假适配器全程只读 turnRef.streamId、从不读 handle，编排仍正常翻终态。
    const { service, scheduler } = makeService(registry);

    await service.abort('stream-1');
    await flushMicrotasks();
    scheduler.fire();

    // 编排在不含 handle 的 turnRef 下照常收敛，证明核心不依赖 handle。
    expect(session.snapshot().phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(session.canAccept()).toBe(true);
  });
});

describe('AbortStreamService.settleTimeout —— idle-timeout / tool-timeout 归因区分（c2-5-6 / CAP-6 / FR-3.6 / AC-5）', () => {
  it('user-abort → ABORTED、idle-timeout → TIMEOUT、tool-timeout → PROCESS 三路 code 互不相同（AC-5）', async () => {
    // 三条独立回合，分别走 user-abort / idle-timeout / tool-timeout 三路归因。
    const userAbort = makeActiveSession('stream-user');
    const idleTimeout = makeActiveSession('stream-idle');
    const toolTimeout = makeActiveSession('stream-tool');

    // user-abort：走 abort 编排（默认 interrupt 永挂）+ fire 安全网兜底 → 归 ABORTED。
    const svcUser = makeService(userAbort.registry);
    await svcUser.service.abort('stream-user');
    await flushMicrotasks();
    svcUser.scheduler.fire();

    // idle-timeout：给定 idle 超时信号 → 归 TIMEOUT。
    const svcIdle = makeService(idleTimeout.registry);
    svcIdle.service.settleTimeout('stream-idle', TerminalReasonCode.IDLE_TIMEOUT);

    // tool-timeout：给定 tool 超时信号 → 归 PROCESS。
    const svcTool = makeService(toolTimeout.registry);
    svcTool.service.settleTimeout('stream-tool', TerminalReasonCode.TOOL_TIMEOUT);

    const userCode = userAbort.session.snapshot().error?.code;
    const idleCode = idleTimeout.session.snapshot().error?.code;
    const toolCode = toolTimeout.session.snapshot().error?.code;

    // 三路归因经 SK.ErrorClassifier 归到各自权威 code（对齐 terminal-reason expectedErrorCode）。
    expect(userCode).toBe(ErrorCode.ABORTED);
    expect(idleCode).toBe(ErrorCode.TIMEOUT);
    expect(toolCode).toBe(ErrorCode.PROCESS);

    // 三路 ClassifiedError.code 互不相同（AC-5 核心反例：UI 据此区分「我停的」/「超时」/「工具挂了」）。
    expect(new Set([userCode, idleCode, toolCode]).size).toBe(3);
  });

  it('idle-timeout → 翻 terminal(aborted)、canAccept()=true，归因 TIMEOUT', () => {
    const { registry, session } = makeActiveSession('stream-idle');
    const { service } = makeService(registry);

    service.settleTimeout('stream-idle', TerminalReasonCode.IDLE_TIMEOUT);

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ABORTED,
    );
    expect(session.canAccept()).toBe(true);
    expect(session.snapshot().error?.code).toBe(ErrorCode.TIMEOUT);
  });

  it('tool-timeout → 翻 terminal(aborted)、canAccept()=true，归因 PROCESS（非 TIMEOUT，避免被超时分支抢先）', () => {
    const { registry, session } = makeActiveSession('stream-tool');
    const { service } = makeService(registry);

    service.settleTimeout('stream-tool', TerminalReasonCode.TOOL_TIMEOUT);

    const phase = session.snapshot().phase;
    expect(phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(phase.kind === StreamPhaseKind.TERMINAL && phase.substate).toBe(
      TerminalSubstate.ABORTED,
    );
    expect(session.canAccept()).toBe(true);
    // 务必真归到 PROCESS——若构造的错误消息误含 timeout 语义会被 classifyByKeyword 超时分支抢先归 TIMEOUT。
    expect(session.snapshot().error?.code).toBe(ErrorCode.PROCESS);
    expect(session.snapshot().error?.code).not.toBe(ErrorCode.TIMEOUT);
  });

  it('归因经 SK.ErrorClassifier 非手拼：ClassifiedError 携带 messageKey 与 retryable（idle-timeout）', () => {
    const { registry, session } = makeActiveSession('stream-idle');
    const { service } = makeService(registry);

    service.settleTimeout('stream-idle', TerminalReasonCode.IDLE_TIMEOUT);

    // classify 产物含 messageKey（sk.error.*）且 TIMEOUT 可重试——证明归因走了 SK.ErrorClassifier，非手拼假 code。
    const error = session.snapshot().error;
    expect(error?.messageKey).toBeDefined();
    expect(error?.retryable).toBe(true);
  });

  it('回合已 terminal → settleTimeout 幂等 no-op（不二次翻、归因不被覆盖）', () => {
    const { registry, session } = makeActiveSession('stream-idle');
    const { service } = makeService(registry);

    // 先经 idle-timeout 翻 TIMEOUT 终态。
    service.settleTimeout('stream-idle', TerminalReasonCode.IDLE_TIMEOUT);
    expect(session.snapshot().error?.code).toBe(ErrorCode.TIMEOUT);

    // 再以 tool-timeout 触发：已 terminal → no-op，归因不被 PROCESS 覆盖（聚合根 abort 幂等）。
    service.settleTimeout('stream-idle', TerminalReasonCode.TOOL_TIMEOUT);
    expect(session.snapshot().error?.code).toBe(ErrorCode.TIMEOUT);
  });

  it('无 session（registry 取不到）→ settleTimeout 幂等 no-op（不抛）', () => {
    const registry = new StreamSessionRegistry();
    const { service } = makeService(registry);

    // 取不到回合不应抛错。
    expect(() => service.settleTimeout('missing', TerminalReasonCode.IDLE_TIMEOUT)).not.toThrow();
  });
});
