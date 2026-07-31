// agent-runtime/usecases/start-stream.test.ts
// C2 · AgentRuntime —— StartStreamService.start 发起骨架单测（对齐 SPEC CAP-1 / AC-14，故事 c2-4-1）。
// 覆盖：streamId 来自注入的 IdGenerator、StreamSession phase=active 且注册进 registry、
// startedAt 来自注入 Clock、start 返回 { streamId, events }。
// 全部用假端口纯单元测试，无 dev server / 无真实 SDK-进程-网络。
// Runtime 选择 / 历史投影 / 单 active / 事件消费 / 落库属后续故事，不在此测。

import { describe, it, expect } from 'vitest';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { ErrorClassifier } from '../../ports/error-classifier.js';
import type { ClassifiedError } from '../../domain/error/classified-error.js';
import { ErrorCode } from '../../domain/error/error-code.js';
import { StreamPhaseKind, TerminalSubstate, isActive } from '../domain/stream/stream-phase.js';
import type { AgentStreamEvent, TokenUsage as RuntimeTokenUsage } from '../domain/event/agent-stream-event.js';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
  AbortSignalLike,
} from '../ports/driven/agent-runtime-port.js';
import type { RuntimeAvailability } from '../ports/runtime-kind.js';
import type {
  ProviderReadPort,
  ResolvedProviderView,
} from '../ports/driven/provider-read-port.js';
import type {
  AppendMessageUseCase,
  GetSessionHistoryUseCase,
  PromptMessage,
} from '../ports/driven/conversation-ports.js';
import type {
  AppendMessageInput,
} from '../../conversation/ports/driving/append-message-usecase.js';
import type { HistoryQuery } from '../../conversation/ports/driving/get-session-history-usecase.js';
import type { Message, MessageId } from '../../conversation/domain/message/message.js';
import type { StreamStatus } from '../../conversation/domain/message/stream-status.js';
import type { TokenUsage } from '../../conversation/domain/message/token-usage.js';
import type { StartStreamInput } from '../ports/driving/start-stream-usecase.js';
import type { ProviderProtocol } from '../ports/driven/provider-read-port.js';
import { RuntimeKind } from '../domain/runtime/runtime-kind.js';
import { StreamSessionRegistry } from './stream-session-registry.js';
import { StartStreamService, resolveRuntimeKind } from './start-stream.js';

/** FrozenClock —— 恒返回注入固定时刻的假 Clock（确定性断言 startedAt 来源）。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

/** SequentialIdGenerator —— 返回可预期序列 id（断言 streamId 来自注入生成器）。 */
class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = 'stream') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}

/**
 * 假 AgentRuntimePort：产可控（本故事无需真实事件）、记录 run 是否被调。
 * 骨架故事 start 不应触达 run（事件消费属 c2-4-5），此处仅提供最小实现供构造注入。
 */
class FakeAgentRuntimePort implements AgentRuntimePort {
  runCalls: RuntimeRunRequest[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async *run(request: RuntimeRunRequest): AsyncIterableIterator<AgentStreamEvent> {
    this.runCalls.push(request);
    return;
  }
  async interrupt(_turnRef: TurnRef): Promise<string | null> {
    return null;
  }
  forceKillTurn(_turnRef: TurnRef): void {}
  async availability(): Promise<RuntimeAvailability> {
    return { kind: 'unknown' };
  }
}

/** 假 ProviderReadPort：记录调用并回可控视图（本故事不解析，c2-4-2 起验证）。 */
class FakeProviderReadPort implements ProviderReadPort {
  resolveCalls: string[] = [];
  constructor(private readonly view: ResolvedProviderView) {}
  async resolve(providerId: string): Promise<ResolvedProviderView> {
    this.resolveCalls.push(providerId);
    return this.view;
  }
}

/** 假 GetSessionHistoryUseCase：记录调用（本故事不取历史，c2-4-3 起验证）。 */
class FakeGetSessionHistoryUseCase implements GetSessionHistoryUseCase {
  getHistoryCalls: HistoryQuery[] = [];
  getPromptViewCalls: HistoryQuery[] = [];
  async getHistory(query: HistoryQuery): Promise<ReadonlyArray<PromptMessage>> {
    this.getHistoryCalls.push(query);
    return [];
  }
  async getPromptView(query: HistoryQuery): Promise<ReadonlyArray<PromptMessage>> {
    this.getPromptViewCalls.push(query);
    return [];
  }
}

/** 假 AppendMessageUseCase：记录调用（本故事不落库，c2-4-6 起验证）。 */
class FakeAppendMessageUseCase implements AppendMessageUseCase {
  appendCalls: AppendMessageInput[] = [];
  updateStatusCalls: Array<{
    messageId: MessageId;
    status: StreamStatus;
    tokenUsage?: TokenUsage;
  }> = [];
  async append(input: AppendMessageInput): Promise<Message> {
    this.appendCalls.push(input);
    // 本故事不触达 append，返回值不被消费；以最小 Message 形状占位满足签名。
    return undefined as unknown as Message;
  }
  async updateStreamStatus(
    messageId: MessageId,
    status: StreamStatus,
    tokenUsage?: TokenUsage,
  ): Promise<void> {
    this.updateStatusCalls.push({ messageId, status, tokenUsage });
  }
}

/** 假 ErrorClassifier：把任意输入归 ABORTED（本故事不触达，c2-4-4/5 起用）。 */
class FakeErrorClassifier implements ErrorClassifier {
  classify(_error: unknown): ClassifiedError {
    return {
      code: ErrorCode.ABORTED,
      messageKey: 'sk.error.aborted',
      retryable: false,
    };
  }
}

const PROVIDER_VIEW: ResolvedProviderView = {
  protocol: 'anthropic',
  authStyle: 'api_key',
  hasCredentials: true,
  source: 'provider',
};

function makeService(overrides?: {
  registry?: StreamSessionRegistry;
  idGenerator?: IdGenerator;
  clock?: Clock;
}): {
  service: StartStreamService;
  registry: StreamSessionRegistry;
  runtime: FakeAgentRuntimePort;
} {
  const registry = overrides?.registry ?? new StreamSessionRegistry();
  const runtime = new FakeAgentRuntimePort();
  const service = new StartStreamService(
    registry,
    runtime,
    new FakeProviderReadPort(PROVIDER_VIEW),
    new FakeGetSessionHistoryUseCase(),
    new FakeAppendMessageUseCase(),
    overrides?.idGenerator ?? new SequentialIdGenerator(),
    overrides?.clock ?? new FrozenClock(1_753_970_000_000),
    new FakeErrorClassifier(),
  );
  return { service, registry, runtime };
}

const input: StartStreamInput = {
  sessionId: 'c1-session-1',
  content: '你好',
  mode: 'code',
  model: 'claude-sonnet',
  providerId: 'provider-1',
};

describe('StartStreamService.start 发起骨架（c2-4-1）', () => {
  it('streamId 来自注入的 IdGenerator', async () => {
    const { service } = makeService({ idGenerator: new SequentialIdGenerator('sid') });
    const result = await service.start(input);
    expect(result.streamId).toBe('sid-1');
  });

  it('创建的 StreamSession phase = active', async () => {
    const { service, registry } = makeService();
    const result = await service.start(input);
    const session = registry.get(result.streamId);
    expect(session).toBeDefined();
    expect(session!.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
    expect(isActive(session!.snapshot().phase)).toBe(true);
  });

  it('新回合已注册进 registry：getActiveBySession 拿得到', async () => {
    const { service, registry } = makeService();
    const result = await service.start(input);
    const active = registry.getActiveBySession('c1-session-1');
    expect(active).toBeDefined();
    expect(active!.snapshot().id).toBe(result.streamId);
  });

  it('startedAt 来自注入 Clock.now()', async () => {
    const fixed = 1_753_970_123_456;
    const { service, registry } = makeService({ clock: new FrozenClock(fixed) });
    const result = await service.start(input);
    const session = registry.get(result.streamId);
    expect(session!.snapshot().startedAt).toBe(fixed);
  });

  it('start 返回 { streamId, events }，events 为可迭代事件流（骨架期无事件）', async () => {
    const { service } = makeService();
    const result = await service.start(input);
    expect(typeof result.streamId).toBe('string');
    expect(result.events).toBeDefined();

    const collected: AgentStreamEvent[] = [];
    for await (const ev of result.events) {
      collected.push(ev);
    }
    // 骨架占位空流：无事件即结束（真实归一事件流属 c2-4-5）。
    expect(collected).toEqual([]);
  });

  it('registry 中该 session 的 active 回合恰为新回合快照 id', async () => {
    const { service, registry } = makeService({
      idGenerator: new SequentialIdGenerator('turn'),
    });
    const result = await service.start(input);
    expect(result.streamId).toBe('turn-1');
    expect(registry.getActiveBySession('c1-session-1')!.snapshot().id).toBe('turn-1');
  });
});

/** 便于 CAP-2 用不同 protocol 构造视图。 */
function viewWith(protocol: ProviderProtocol): ResolvedProviderView {
  return {
    protocol,
    authStyle: 'api_key',
    hasCredentials: true,
    source: 'provider',
  };
}

/** 用指定 ProviderReadPort 构造 service（CAP-2 专用，可拿到 provider 探针）。 */
function makeServiceWithProvider(view: ResolvedProviderView): {
  service: StartStreamService;
  registry: StreamSessionRegistry;
  provider: FakeProviderReadPort;
} {
  const registry = new StreamSessionRegistry();
  const provider = new FakeProviderReadPort(view);
  const service = new StartStreamService(
    registry,
    new FakeAgentRuntimePort(),
    provider,
    new FakeGetSessionHistoryUseCase(),
    new FakeAppendMessageUseCase(),
    new SequentialIdGenerator(),
    new FrozenClock(1_753_970_000_000),
    new FakeErrorClassifier(),
  );
  return { service, registry, provider };
}

describe('resolveRuntimeKind 纯映射（CAP-2 / FR-2.2）', () => {
  it('anthropic → CLAUDE_SDK', () => {
    expect(resolveRuntimeKind(viewWith('anthropic'))).toBe(RuntimeKind.CLAUDE_SDK);
  });

  it('HTTP 系协议 → NATIVE', () => {
    const httpProtocols: ProviderProtocol[] = [
      'openai-compatible',
      'xai',
      'openrouter',
      'bedrock',
      'vertex',
      'google',
    ];
    for (const protocol of httpProtocols) {
      expect(resolveRuntimeKind(viewWith(protocol))).toBe(RuntimeKind.NATIVE);
    }
  });

  it('非对话协议 / 无法判定 → null（不静默选错）', () => {
    expect(resolveRuntimeKind(viewWith('gemini-image'))).toBeNull();
    expect(resolveRuntimeKind(viewWith('openai-image'))).toBeNull();
    expect(resolveRuntimeKind(viewWith('unknown'))).toBeNull();
  });
});

describe('StartStreamService.start Runtime 选择与锁定（CAP-2 / FR-2.2）', () => {
  it('anthropic → 锁定 CLAUDE_SDK 进 StreamSession.snapshot().runtimeKind', async () => {
    const { service, registry } = makeServiceWithProvider(viewWith('anthropic'));
    const result = await service.start(input);
    const session = registry.get(result.streamId);
    expect(session!.snapshot().runtimeKind).toBe(RuntimeKind.CLAUDE_SDK);
  });

  it('openai-compatible → 锁定 NATIVE 进 StreamSession.snapshot().runtimeKind', async () => {
    const { service, registry } = makeServiceWithProvider(viewWith('openai-compatible'));
    const result = await service.start(input);
    const session = registry.get(result.streamId);
    expect(session!.snapshot().runtimeKind).toBe(RuntimeKind.NATIVE);
  });

  it('不同 protocol 路由到不同 RuntimeKind', async () => {
    const anthropic = makeServiceWithProvider(viewWith('anthropic'));
    const openai = makeServiceWithProvider(viewWith('openai-compatible'));
    const aRes = await anthropic.service.start(input);
    const oRes = await openai.service.start(input);
    const aKind = anthropic.registry.get(aRes.streamId)!.snapshot().runtimeKind;
    const oKind = openai.registry.get(oRes.streamId)!.snapshot().runtimeKind;
    expect(aKind).toBe(RuntimeKind.CLAUDE_SDK);
    expect(oKind).toBe(RuntimeKind.NATIVE);
    expect(aKind).not.toBe(oKind);
  });

  it('只经注入的 providerId 调 resolve，且只调 resolve（只读纪律，无写方法）', async () => {
    const { service, provider } = makeServiceWithProvider(viewWith('anthropic'));
    await service.start(input);
    // 只调了 resolve 一次，参数为注入 providerId；ProviderReadPort 契约无任何写方法（编译期即保证）。
    expect(provider.resolveCalls).toEqual(['provider-1']);
  });

  it('无法判定 / 非对话协议 → 归错抛出，不创建 active 回合', async () => {
    const { service, registry } = makeServiceWithProvider(viewWith('unknown'));
    await expect(service.start(input)).rejects.toBeInstanceOf(Error);
    // 不静默选错：既未锁定错误 Runtime，也未把回合登记进 registry。
    expect(registry.getActiveBySession('c1-session-1')).toBeUndefined();
  });
});

/** 造一条最小 PromptMessage（仅满足类型；投影语义归 C1，C2 只原样透传）。 */
function makePromptMessage(id: string): PromptMessage {
  return {
    id,
    sessionId: 'c1-session-1',
    role: 'user',
    content: undefined as unknown as Message['content'],
    createdAt: 1_753_970_000_000,
    streamStatus: 'completed' as unknown as StreamStatus,
    isHeartbeatAck: false,
  };
}

/**
 * 可注入投影的假 GetSessionHistoryUseCase：getPromptView 返回构造时给定的投影并记录调用，
 * getHistory 若被调用则记录（用于断言 start 绝不走 getHistory）。
 */
class RecordingHistoryUseCase implements GetSessionHistoryUseCase {
  getHistoryCalls: HistoryQuery[] = [];
  getPromptViewCalls: HistoryQuery[] = [];
  constructor(private readonly promptView: ReadonlyArray<PromptMessage>) {}
  async getHistory(query: HistoryQuery): Promise<ReadonlyArray<PromptMessage>> {
    this.getHistoryCalls.push(query);
    return [];
  }
  async getPromptView(query: HistoryQuery): Promise<ReadonlyArray<PromptMessage>> {
    this.getPromptViewCalls.push(query);
    return this.promptView;
  }
}

/** 用指定 history 用例构造 service（CAP-3 专用，可拿到 history / runtime 探针）。 */
function makeServiceWithHistory(history: RecordingHistoryUseCase): {
  service: StartStreamService;
  history: RecordingHistoryUseCase;
  runtime: FakeAgentRuntimePort;
} {
  const runtime = new FakeAgentRuntimePort();
  const service = new StartStreamService(
    new StreamSessionRegistry(),
    runtime,
    new FakeProviderReadPort(PROVIDER_VIEW),
    history,
    new FakeAppendMessageUseCase(),
    new SequentialIdGenerator(),
    new FrozenClock(1_753_970_000_000),
    new FakeErrorClassifier(),
  );
  return { service, history, runtime };
}

/** 驱动 result.events 迭代完毕，触发假 AgentRuntimePort.run 记录入参（其 body 迭代时才执行）。 */
async function drain(events: AsyncIterable<AgentStreamEvent>): Promise<void> {
  for await (const _ev of events) {
    void _ev;
  }
}

describe('StartStreamService.start 历史投影（CAP-3 / FR-2.3 / C1 AC-13）', () => {
  it('只经 getPromptView 取历史，绝不调 getHistory', async () => {
    const history = new RecordingHistoryUseCase([]);
    const { service } = makeServiceWithHistory(history);
    await service.start(input);
    expect(history.getPromptViewCalls).toHaveLength(1);
    expect(history.getHistoryCalls).toHaveLength(0);
  });

  it('传入 getPromptView 的 sessionId 为注入的 input.sessionId', async () => {
    const history = new RecordingHistoryUseCase([]);
    const { service } = makeServiceWithHistory(history);
    await service.start(input);
    expect(history.getPromptViewCalls[0]).toEqual({ sessionId: 'c1-session-1' });
  });

  it('getPromptView 的投影原样进 RuntimeRunRequest.promptView（经 run 捕获断言）', async () => {
    const projection: ReadonlyArray<PromptMessage> = [
      makePromptMessage('m-1'),
      makePromptMessage('m-2'),
    ];
    const history = new RecordingHistoryUseCase(projection);
    const { service, runtime } = makeServiceWithHistory(history);
    const result = await service.start(input);
    await drain(result.events);
    expect(runtime.runCalls).toHaveLength(1);
    // 原样透传：引用与内容均与 getPromptView 返回一致（C2 不重新加工 / 过滤）。
    expect(runtime.runCalls[0]!.promptView).toBe(projection);
    expect(runtime.runCalls[0]!.promptView).toEqual(projection);
  });

  it('RuntimeRunRequest 其余字段来自 input：content / options 归约正确', async () => {
    const richInput: StartStreamInput = {
      sessionId: 'c1-session-1',
      content: '实现一个功能',
      mode: 'plan',
      model: 'claude-opus',
      providerId: 'provider-1',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 2048 },
      context1m: true,
      selectedSkills: ['skill-a', 'skill-b'],
      systemPromptAppend: '追加提示',
    };
    const history = new RecordingHistoryUseCase([]);
    const { service, runtime } = makeServiceWithHistory(history);
    const result = await service.start(richInput);
    await drain(result.events);
    const req = runtime.runCalls[0]!;
    expect(req.content).toBe('实现一个功能');
    expect(req.options).toEqual({
      mode: 'plan',
      model: 'claude-opus',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 2048 },
      context1m: true,
      selectedSkills: ['skill-a', 'skill-b'],
      systemPromptAppend: '追加提示',
    });
  });
});

describe('StartStreamService.start 单 active 约束（CAP-4 / FR-2.4 / AC-11）', () => {
  it('同一 sessionId 连续两次 start：旧回合翻 terminal(aborted) 且 canAccept()=true', async () => {
    const { service, registry } = makeService();
    const first = await service.start(input);
    // 第二次 start 会同步 abort + 从 registry 摘除旧回合（防泄漏），故先捕获旧回合引用再发起。
    const oldSession = registry.get(first.streamId);
    await service.start(input);

    // 旧回合被聚合根层同步 abort：phase = terminal(aborted)，canAccept 立即为 true。
    expect(oldSession).toBeDefined();
    expect(oldSession!.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(oldSession!.canAccept()).toBe(true);
    // 旧终态回合已从 registry 摘除（防内存泄漏），不再可 get。
    expect(registry.get(first.streamId)).toBeUndefined();
  });

  it('第二次 start 的新回合 phase=active', async () => {
    const { service, registry } = makeService();
    await service.start(input);
    const second = await service.start(input);

    const newSession = registry.get(second.streamId);
    expect(newSession).toBeDefined();
    expect(newSession!.snapshot().phase).toEqual({ kind: StreamPhaseKind.ACTIVE });
    expect(isActive(newSession!.snapshot().phase)).toBe(true);
  });

  it('getActiveBySession 返回的恰是新回合（至多一个 active）', async () => {
    const { service, registry } = makeService({
      idGenerator: new SequentialIdGenerator('turn'),
    });
    const first = await service.start(input);
    const second = await service.start(input);
    expect(first.streamId).toBe('turn-1');
    expect(second.streamId).toBe('turn-2');

    const active = registry.getActiveBySession('c1-session-1');
    expect(active).toBeDefined();
    expect(active!.snapshot().id).toBe(second.streamId);
    // 旧回合已非 active，绝不会被 getActiveBySession 命中。
    expect(active!.snapshot().id).not.toBe(first.streamId);
  });

  it('旧回合 abort 的归因经 ErrorClassifier 归 ABORTED', async () => {
    const { service, registry } = makeService();
    const first = await service.start(input);
    // 第二次 start 摘除旧回合，先捕获引用（聚合根被 abort 后其快照仍可读）。
    const oldSession = registry.get(first.streamId);
    await service.start(input);

    const snapshot = oldSession!.snapshot();
    // 归因走 USER_ABORTED，携带的分类结果 code=ABORTED（FakeErrorClassifier 归 ABORTED；
    // 生产实现经 name='AbortError' 由 classifyByName 归 ABORTED）。
    expect(snapshot.error?.code).toBe(ErrorCode.ABORTED);
    expect(snapshot.terminalReason?.classified?.code).toBe(ErrorCode.ABORTED);
  });

  it('不同 sessionId 的 active 回合互不影响（只 abort 同会话旧回合）', async () => {
    const { service, registry } = makeService({
      idGenerator: new SequentialIdGenerator('turn'),
    });
    const other: StartStreamInput = { ...input, sessionId: 'c1-session-2' };
    const otherFirst = await service.start(other);
    const first = await service.start(input);
    // 第二次 start 摘除本会话旧回合，先捕获引用。
    const firstSession = registry.get(first.streamId);
    await service.start(input);

    // 另一会话的回合仍 active，未被 abort（也未被摘除）。
    const otherSession = registry.get(otherFirst.streamId);
    expect(isActive(otherSession!.snapshot().phase)).toBe(true);
    // 本会话旧回合被 abort（引用仍可读其终态快照）。
    expect(firstSession!.canAccept()).toBe(true);
  });
});

// ============================================================================
// CAP-5 · 事件消费与终态归因（FR-2.1 / FR-3.6 支撑，architecture §6.2）
// ============================================================================

/**
 * 可编排事件序列的假 AgentRuntimePort：run 产出注入的可控 AgentStreamEvent 序列，
 * 且把 request.abortSignal 暴露出来（供测试在消费中途 trigger），并可注入「每 yield 一个事件后的回调」
 * 以模拟 abortSignal 在流进行中触发。
 */
class ScriptedAgentRuntimePort implements AgentRuntimePort {
  runCalls: RuntimeRunRequest[] = [];
  lastAbortSignal?: AbortSignalLike;
  constructor(
    private readonly events: ReadonlyArray<AgentStreamEvent>,
    private readonly opts?: {
      /** 每 yield 一个事件后触发，收到本次 run 的 abortSignal（用于模拟消费中途置真）。 */
      afterEach?: (index: number, signal: AbortSignalLike) => void;
      /** 若为真，迭代到末尾抛出该错误（模拟适配器异常，非归一 error 事件）。 */
      throwAtEnd?: unknown;
    },
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async *run(request: RuntimeRunRequest): AsyncIterableIterator<AgentStreamEvent> {
    this.runCalls.push(request);
    this.lastAbortSignal = request.abortSignal;
    let i = 0;
    for (const event of this.events) {
      yield event;
      this.opts?.afterEach?.(i, request.abortSignal);
      i += 1;
    }
    if (this.opts?.throwAtEnd !== undefined) {
      throw this.opts.throwAtEnd;
    }
  }
  async interrupt(_turnRef: TurnRef): Promise<string | null> {
    return null;
  }
  forceKillTurn(_turnRef: TurnRef): void {}
  async availability(): Promise<RuntimeAvailability> {
    return { kind: 'unknown' };
  }
}

/**
 * 真实归一到 ErrorCode 的假 ErrorClassifier：AbortError.name → ABORTED（对齐生产 classifyByName），
 * 否则归 UNKNOWN。用于 CAP-5 断言 abort 路径的 code 确实经分类器得来，而非手工拼。
 */
class NameAwareErrorClassifier implements ErrorClassifier {
  classify(error: unknown): ClassifiedError {
    const name =
      typeof error === 'object' && error !== null
        ? (error as { name?: unknown }).name
        : undefined;
    if (name === 'AbortError') {
      return { code: ErrorCode.ABORTED, messageKey: 'sk.error.aborted', retryable: false, cause: error };
    }
    return { code: ErrorCode.UNKNOWN, messageKey: 'sk.error.unknown', retryable: false, cause: error };
  }
}

/** 用指定事件序列 + 可选中断信号/分类器构造 service（CAP-5 专用，暴露 runtime/registry 探针）。 */
function makeServiceWithRuntime(
  runtime: ScriptedAgentRuntimePort,
  overrides?: { errorClassifier?: ErrorClassifier },
): {
  service: StartStreamService;
  registry: StreamSessionRegistry;
  runtime: ScriptedAgentRuntimePort;
} {
  const registry = new StreamSessionRegistry();
  const service = new StartStreamService(
    registry,
    runtime,
    new FakeProviderReadPort(PROVIDER_VIEW),
    new FakeGetSessionHistoryUseCase(),
    new FakeAppendMessageUseCase(),
    new SequentialIdGenerator(),
    new FrozenClock(1_753_970_000_000),
    overrides?.errorClassifier ?? new FakeErrorClassifier(),
  );
  return { service, registry, runtime };
}

/** 收集事件流全部事件（触发消费与终态驱动）。 */
async function collect(
  events: AsyncIterable<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

describe('StartStreamService 事件消费与终态归因（CAP-5 / FR-2.1 / FR-3.6）', () => {
  it('正常序列（text → result 后耗尽）→ terminal(completed)，finalContent 反映累积，token 投影存入', async () => {
    const tokenUsage: RuntimeTokenUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '你好，世界' },
      { type: 'result', tokenUsage },
    ]);
    const { service, registry } = makeServiceWithRuntime(runtime);
    const result = await service.start(input);
    // 终态后 registry 会摘除该回合（防内存泄漏，CAP-6），故消费前先捕获 session 引用。
    const session = registry.get(result.streamId)!;
    await collect(result.events);

    const snapshot = session.snapshot();
    expect(snapshot.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    // 纯文本回合：finalContent 直接是累积后的全文。
    expect(snapshot.finalContent).toBe('你好，世界');
    // result 事件的 token 投影经 apply/complete 存入。
    expect(snapshot.tokenUsage).toEqual(tokenUsage);
  });

  it('无 token 上报（result 无 tokenUsage）→ 正常 complete 且 tokenUsage 省略（AC-9 不填 0）', async () => {
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '仅文本' },
      { type: 'result' },
    ]);
    const { service, registry } = makeServiceWithRuntime(runtime);
    const result = await service.start(input);
    const session = registry.get(result.streamId)!;
    await collect(result.events);

    const snapshot = session.snapshot();
    expect(snapshot.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    // AC-9：Runtime 未上报 → tokenUsage 保持 undefined，绝不填 0。
    expect(snapshot.tokenUsage).toBeUndefined();
  });

  it('含 error 事件 → terminal(errored)，snapshot().error 为事件里的分类结果', async () => {
    const classified: ClassifiedError = {
      code: ErrorCode.TIMEOUT,
      messageKey: 'sk.error.timeout',
      retryable: true,
    };
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '部分输出' },
      { type: 'error', error: classified },
    ]);
    const { service, registry } = makeServiceWithRuntime(runtime);
    const result = await service.start(input);
    const session = registry.get(result.streamId)!;
    await collect(result.events);

    const snapshot = session.snapshot();
    expect(snapshot.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ERRORED,
    });
    // error 为事件携带的已归一分类结果（idle/tool-timeout 亦经此路径以 code 携带归因）。
    expect(snapshot.error).toEqual(classified);
    expect(snapshot.error?.code).toBe(ErrorCode.TIMEOUT);
  });

  it('空源 + 无中断 → 正常 complete（空回合 finalContent 省略，对照边界）', async () => {
    const runtime = new ScriptedAgentRuntimePort([]);
    const { service, registry } = makeServiceWithRuntime(runtime);
    const result = await service.start(input);
    const session = registry.get(result.streamId)!;
    await collect(result.events);
    const snapshot = session.snapshot();
    // 空源 + 无中断 → 正常 complete（空回合 buildFinalContent 返回 null，finalContent 省略）。
    expect(snapshot.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    expect(snapshot.finalContent).toBeUndefined();
  });

  it('abortSignal 消费开始前已触发 → terminal(aborted)，不进入事件消费', async () => {
    // 用 afterEach 在「首个事件 yield 后立即置真」（经回调形参拿到本次 run 的 abortSignal，
    // 而非从外部捕获——run 是惰性生成器，start 返回时其 body 尚未执行，lastAbortSignal 还是 undefined）
    // + 断言仅消费到中断点即翻 aborted，并验证 abort 归因经 ErrorClassifier（AbortError → ABORTED）。
    const runtime = new ScriptedAgentRuntimePort(
      [
        { type: 'text', text: '首个事件' },
        { type: 'text', text: '中断后不应再影响终态' },
      ],
      {
        afterEach: (index, signal) => {
          if (index === 0) {
            (signal as { aborted: boolean }).aborted = true;
          }
        },
      },
    );
    const { service, registry } = makeServiceWithRuntime(runtime, {
      errorClassifier: new NameAwareErrorClassifier(),
    });
    const result = await service.start(input);
    const session = registry.get(result.streamId)!;
    await collect(result.events);
    const snapshot = session.snapshot();
    expect(snapshot.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(snapshot.error?.code).toBe(ErrorCode.ABORTED);
  });

  it('abortSignal 消费中触发 → terminal(aborted)，error 经 ErrorClassifier 归 ABORTED', async () => {
    // afterEach 在 yield 首个事件后把本次 run 的 abortSignal 置真（经回调形参拿，非外部捕获——
    // run 惰性，start 返回时 body 未执行），模拟消费进行中中断。
    const runtime = new ScriptedAgentRuntimePort(
      [
        { type: 'text', text: '进行中' },
        { type: 'text', text: '进行中的更多文本' },
      ],
      {
        afterEach: (_index, signal) => {
          // 把 run 请求里的 abortSignal 置为 aborted（该对象即 start 组装并传入的占位信号）。
          (signal as { aborted: boolean }).aborted = true;
        },
      },
    );
    const { service, registry } = makeServiceWithRuntime(runtime, {
      errorClassifier: new NameAwareErrorClassifier(),
    });
    const result = await service.start(input);
    const session = registry.get(result.streamId)!;
    await collect(result.events);

    const snapshot = session.snapshot();
    expect(snapshot.phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    // abort 归因经 ErrorClassifier（AbortError → ABORTED），非手工拼。
    expect(snapshot.error?.code).toBe(ErrorCode.ABORTED);
    expect(snapshot.terminalReason?.classified?.code).toBe(ErrorCode.ABORTED);
  });

  it('转发：上层从 events 拿到的序列与 apply 到 session 的一致', async () => {
    const events: AgentStreamEvent[] = [
      { type: 'text', text: '第一段' },
      { type: 'thinking', delta: '思考中' },
      { type: 'tool_use', tool: { id: 't1', name: 'read', input: {} } },
      { type: 'result', tokenUsage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const runtime = new ScriptedAgentRuntimePort(events);
    const { service } = makeServiceWithRuntime(runtime);
    const result = await service.start(input);
    const forwarded = await collect(result.events);
    // 上层拿到的转发序列与源事件逐一相等（一边 apply 一边 yield，不吞不改）。
    expect(forwarded).toEqual(events);
  });

  it('源迭代抛出（适配器异常，非归一 error 事件）→ 聚合根落终态（不停在 active）后向上层抛出', async () => {
    const boom = new Error('适配器炸了');
    const runtime = new ScriptedAgentRuntimePort(
      [{ type: 'text', text: '抛错前' }],
      { throwAtEnd: boom },
    );
    const { service, registry } = makeServiceWithRuntime(runtime);
    const result = await service.start(input);
    const session = registry.get(result.streamId)!;
    // 迭代到抛错处应把异常透出给上层消费者。
    await expect(collect(result.events)).rejects.toBe(boom);
    // 且聚合根绝不停在 active：非 ABORTED 归 fail（terminal errored）。
    const snapshot = session.snapshot();
    expect(snapshot.phase.kind).toBe(StreamPhaseKind.TERMINAL);
    expect(isActive(snapshot.phase)).toBe(false);
  });
});

// ============================================================================
// CAP-6 · 落 C1：终态非空且非 autoTrigger 才经用例 append（FR-2.5/2.6 / AC-12 / AC-9）
// ============================================================================

/**
 * 用指定事件序列 + 可注入分类器 + 探针 AppendMessageUseCase 构造 service（CAP-6 专用）。
 * 暴露 messages（断言 append 是否被调、入参形状）、registry（终态后回合已摘除）。
 */
function makeServiceForPersist(
  runtime: ScriptedAgentRuntimePort,
  overrides?: { errorClassifier?: ErrorClassifier },
): {
  service: StartStreamService;
  registry: StreamSessionRegistry;
  messages: FakeAppendMessageUseCase;
} {
  const registry = new StreamSessionRegistry();
  const messages = new FakeAppendMessageUseCase();
  const service = new StartStreamService(
    registry,
    runtime,
    new FakeProviderReadPort(PROVIDER_VIEW),
    new FakeGetSessionHistoryUseCase(),
    messages,
    new SequentialIdGenerator(),
    new FrozenClock(1_753_970_000_000),
    overrides?.errorClassifier ?? new FakeErrorClassifier(),
  );
  return { service, registry, messages };
}

describe('StartStreamService 落 C1（CAP-6 / FR-2.5/2.6 / AC-12 / AC-9）', () => {
  it('非空 completed 终态 → 恰调一次 append（role=assistant、content 来自 finalContent、streamStatus=completed、tokenUsage 投影）', async () => {
    const tokenUsage: RuntimeTokenUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '你好，世界' },
      { type: 'result', tokenUsage },
    ]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    expect(messages.appendCalls).toHaveLength(1);
    const call = messages.appendCalls[0]!;
    expect(call.sessionId).toBe('c1-session-1');
    expect(call.role).toBe('assistant');
    expect(call.streamStatus).toBe('completed');
    // content 来自 finalContent（纯文本回合经 C1 decodeContent 还原为单 text 块）。
    expect(call.content.toPlainText()).toBe('你好，世界');
    // tokenUsage 投影：Runtime 上报的 input/output/cache 系列逐字段搬运（totalTokens 不入 C1 持久投影）。
    expect(call.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('无 token 上报 → append 的 tokenUsage 省略（AC-9 不填 0）', async () => {
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '仅文本' },
      { type: 'result' },
    ]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    expect(messages.appendCalls).toHaveLength(1);
    // AC-9：Runtime 未上报 → 整个 tokenUsage 字段省略，绝不填 0。
    expect(messages.appendCalls[0]!.tokenUsage).toBeUndefined();
  });

  it('aborted 终态 → streamStatus 映射 interrupted', async () => {
    const runtime = new ScriptedAgentRuntimePort(
      [
        { type: 'text', text: '进行中' },
        { type: 'text', text: '更多' },
      ],
      {
        // 经回调形参拿本次 run 的 abortSignal 置真（run 惰性，不能从外部提前捕获）。
        afterEach: (_index, signal) => {
          (signal as { aborted: boolean }).aborted = true;
        },
      },
    );
    const { service, messages } = makeServiceForPersist(runtime, {
      errorClassifier: new NameAwareErrorClassifier(),
    });
    const result = await service.start(input);
    await collect(result.events);

    expect(messages.appendCalls).toHaveLength(1);
    // §6.4：terminal(aborted) → 'interrupted'（内容不完整但非错误）。
    expect(messages.appendCalls[0]!.streamStatus).toBe('interrupted');
  });

  it('errored 终态 → streamStatus 映射 error', async () => {
    const classified: ClassifiedError = {
      code: ErrorCode.TIMEOUT,
      messageKey: 'sk.error.timeout',
      retryable: true,
    };
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '部分输出' },
      { type: 'error', error: classified },
    ]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    expect(messages.appendCalls).toHaveLength(1);
    // §6.4：terminal(errored) → 'error'。
    expect(messages.appendCalls[0]!.streamStatus).toBe('error');
  });

  it('空回合（无产物）终态 → append 不被调用（FR-2.6 空回合不落库）', async () => {
    const runtime = new ScriptedAgentRuntimePort([{ type: 'result' }]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    // buildFinalContent 返回 null（无 text/thinking/tool 产物）→ 不落 assistant 消息。
    expect(messages.appendCalls).toHaveLength(0);
  });

  it('autoTrigger=true 回合 → 跳过落库（append 不被调，即便有非空产物）', async () => {
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '自动触发的产物' },
      { type: 'result' },
    ]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start({ ...input, autoTrigger: true });
    await collect(result.events);

    // autoTrigger 回合：assistant 自动触发，跳过落库（不留转录）。
    expect(messages.appendCalls).toHaveLength(0);
  });

  it('复合回合（text + thinking + tool_use）→ append content 经 C1 blocks 还原（不臆造结构）', async () => {
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '正文' },
      { type: 'thinking', delta: '思考' },
      { type: 'tool_use', tool: { id: 't1', name: 'read', input: { path: 'a.ts' } } },
      { type: 'result' },
    ]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    expect(messages.appendCalls).toHaveLength(1);
    const blocks = messages.appendCalls[0]!.content.blocks;
    // 经 buildFinalContent → C1 decodeContent 还原为有序块（text → thinking → tool_use）。
    expect(blocks.map((b) => b.type)).toEqual(['text', 'thinking', 'tool_use']);
  });

  it('只经 AppendMessageUseCase 写：不触达 updateStreamStatus（无直写库路径）', async () => {
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '内容' },
      { type: 'result' },
    ]);
    const { service, messages } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    // 落库唯一路径是 append（终态一次性带 streamStatus）；本用例不调 updateStreamStatus。
    expect(messages.appendCalls).toHaveLength(1);
    expect(messages.updateStatusCalls).toHaveLength(0);
  });

  it('终态后从 registry 摘除该回合（防内存泄漏，registry 仍非持久层）', async () => {
    const runtime = new ScriptedAgentRuntimePort([
      { type: 'text', text: '内容' },
      { type: 'result' },
    ]);
    const { service, registry } = makeServiceForPersist(runtime);
    const result = await service.start(input);
    await collect(result.events);

    // 终态后回合已摘除：get 取不到、getActiveBySession 亦无。
    expect(registry.get(result.streamId)).toBeUndefined();
    expect(registry.getActiveBySession('c1-session-1')).toBeUndefined();
  });
});
