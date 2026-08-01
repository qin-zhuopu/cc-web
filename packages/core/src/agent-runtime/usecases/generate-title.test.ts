// agent-runtime/usecases/generate-title.test.ts
// GenerateTitleService 单测（SPEC CAP-1 / PRD FR-6 / AC-13）。
//
// 覆盖：
//  - 正常产出：假 AgentRuntimePort 产 text 事件 → generateTitle 返回拼好的标题（取最后一个累积全文）。
//  - AC-13 隔离铁律：全程 registry.register 零调用、无 new StreamSession（构造上根本不持有 registry，
//    此处仍以 spy registry 注入旁证断言其写方法零调用，并断言 run 请求的 streamId 非用户可见前缀）。
//  - 失败：Runtime 抛错 → generateTitle 抛出（供 C1 降级），不静默返回空串。
//  - 失败：协议无法映射对话 Runtime（unknown）→ 抛出，且未发起 run。
//
// 核心零框架；类型-only import 用 import type + .js；术语中文。

import { describe, it, expect, vi } from 'vitest';
import { GenerateTitleService } from './generate-title.js';
import { StreamSessionRegistry } from './stream-session-registry.js';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
} from '../ports/driven/agent-runtime-port.js';
import type { RuntimeAvailability } from '../ports/runtime-kind.js';
import type { ProviderReadPort, ResolvedProviderView } from '../ports/driven/provider-read-port.js';
import type { AgentStreamEvent } from '../domain/event/agent-stream-event.js';
import type { TitleGenerationInput } from '../ports/driving/title-generator.js';

/**
 * 假 ProviderReadPort：只读返回一个指定协议的解析视图；记录 resolve 调用。
 * 断言只读纪律用（无任何写方法可调）。
 */
function makeFakeProviders(view: ResolvedProviderView): ProviderReadPort & {
  readonly resolveCalls: () => number;
} {
  let calls = 0;
  return {
    async resolve(_providerId: string): Promise<ResolvedProviderView> {
      calls += 1;
      return view;
    },
    resolveCalls: () => calls,
  };
}

const ANTHROPIC_VIEW: ResolvedProviderView = {
  protocol: 'anthropic',
  model: 'claude-x',
  authStyle: 'auth_token',
  hasCredentials: true,
  source: 'provider',
};

const UNKNOWN_VIEW: ResolvedProviderView = {
  protocol: 'unknown',
  authStyle: 'ambiguous',
  hasCredentials: false,
  source: 'none',
};

/**
 * 假 AgentRuntimePort：run 产出给定归一事件序列；其余方法为断言用占位（不该被标题路径调用）。
 * 捕获最近一次 run 请求，供断言 streamId / promptView / options。
 */
function makeFakeRuntime(events: ReadonlyArray<AgentStreamEvent>): AgentRuntimePort & {
  readonly lastRequest: () => RuntimeRunRequest | undefined;
  readonly runCalls: () => number;
} {
  let last: RuntimeRunRequest | undefined;
  let calls = 0;
  return {
    run(request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent> {
      last = request;
      calls += 1;
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    },
    async interrupt(_turnRef: TurnRef): Promise<string | null> {
      throw new Error('标题路径不应调用 interrupt');
    },
    forceKillTurn(_turnRef: TurnRef): void {
      throw new Error('标题路径不应调用 forceKillTurn');
    },
    async availability(): Promise<RuntimeAvailability> {
      throw new Error('标题路径不应调用 availability');
    },
    resolvePermission(): void {
      throw new Error('标题路径不应调用 resolvePermission');
    },
    lastRequest: () => last,
    runCalls: () => calls,
  };
}

/** 假 AgentRuntimePort：run 迭代时抛错（模拟 Runtime 失败）。 */
function makeThrowingRuntime(reason: string): AgentRuntimePort {
  return {
    run(_request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent> {
      return (async function* () {
        throw new Error(reason);
        // eslint-disable-next-line no-unreachable
        yield undefined as never;
      })();
    },
    async interrupt(): Promise<string | null> {
      return null;
    },
    forceKillTurn(): void {},
    async availability(): Promise<RuntimeAvailability> {
      return { kind: 'unknown' };
    },
    resolvePermission(): void {},
  };
}

const INPUT: TitleGenerationInput = {
  sessionId: 's-1',
  recentMessages: [
    { role: 'user', text: '帮我把六边形架构讲清楚' },
    { role: 'assistant', text: '好的，核心是依赖倒置……' },
  ],
};

describe('GenerateTitleService', () => {
  it('正常产出：取最后一个 text 事件的累积全文作为标题返回', async () => {
    const runtime = makeFakeRuntime([
      { type: 'text', text: '六边形' },
      { type: 'text', text: '六边形架构讲解' },
      { type: 'result' },
    ]);
    const providers = makeFakeProviders(ANTHROPIC_VIEW);
    const service = new GenerateTitleService(runtime, providers);

    const title = await service.generateTitle(INPUT);

    expect(title).toBe('六边形架构讲解');
    expect(providers.resolveCalls()).toBe(1);
    expect(runtime.runCalls()).toBe(1);
  });

  it('返回值 trim：去除首尾空白', async () => {
    const runtime = makeFakeRuntime([
      { type: 'text', text: '  带空白的标题  ' },
      { type: 'result' },
    ]);
    const service = new GenerateTitleService(runtime, makeFakeProviders(ANTHROPIC_VIEW));

    expect(await service.generateTitle(INPUT)).toBe('带空白的标题');
  });

  it('AC-13：全程不 registry.register、不影响 canAccept（spy registry 写方法零调用）', async () => {
    const runtime = makeFakeRuntime([
      { type: 'text', text: '标题' },
      { type: 'result' },
    ]);
    const service = new GenerateTitleService(runtime, makeFakeProviders(ANTHROPIC_VIEW));

    // 旁证断言：即便有一个真实 registry 在侧，标题路径也绝不碰它（构造上本就不持有）。
    const registry = new StreamSessionRegistry();
    const registerSpy = vi.spyOn(registry, 'register');
    const deleteSpy = vi.spyOn(registry, 'delete');
    const getActiveSpy = vi.spyOn(registry, 'getActiveBySession');

    await service.generateTitle(INPUT);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(getActiveSpy).not.toHaveBeenCalled();
    // registry 全程无任何登记 → 该会话无 active 回合，canAccept 语义不受影响。
    expect(registry.getActiveBySession('s-1')).toBeUndefined();
  });

  it('AC-13：run 请求的 streamId 是非用户可见临时标记（非注册），不是 IdGenerator 造的 streamId', async () => {
    const runtime = makeFakeRuntime([
      { type: 'text', text: '标题' },
      { type: 'result' },
    ]);
    const service = new GenerateTitleService(runtime, makeFakeProviders(ANTHROPIC_VIEW));

    await service.generateTitle(INPUT);

    const request = runtime.lastRequest();
    expect(request).toBeDefined();
    // 非用户可见前缀 + sessionId；且 promptView 为空（近期消息全放进 content）。
    expect(request?.streamId).toBe('title-gen:s-1');
    expect(request?.promptView).toEqual([]);
    // 近期消息投影进入 content（提示词拼装归 C2，非 C1）。
    expect(request?.content).toContain('帮我把六边形架构讲清楚');
    expect(request?.content).toContain('好的，核心是依赖倒置……');
  });

  it('失败：Runtime 抛错 → generateTitle 抛出（供 C1 降级），不静默返回空串', async () => {
    const runtime = makeThrowingRuntime('SDK 连接失败');
    const service = new GenerateTitleService(runtime, makeFakeProviders(ANTHROPIC_VIEW));

    await expect(service.generateTitle(INPUT)).rejects.toThrow('SDK 连接失败');
  });

  it('失败：协议无法映射对话 Runtime（unknown）→ 抛出，且未发起 run', async () => {
    const runtime = makeFakeRuntime([{ type: 'text', text: '不该产出' }]);
    const service = new GenerateTitleService(runtime, makeFakeProviders(UNKNOWN_VIEW));

    await expect(service.generateTitle(INPUT)).rejects.toThrow(/无法为 provider 协议/);
    expect(runtime.runCalls()).toBe(0);
  });

  it('无 text 事件（Runtime 无产出）→ 返回空串，不抛（由 C1 空标题守卫降级）', async () => {
    const runtime = makeFakeRuntime([{ type: 'result' }]);
    const service = new GenerateTitleService(runtime, makeFakeProviders(ANTHROPIC_VIEW));

    expect(await service.generateTitle(INPUT)).toBe('');
  });
});
