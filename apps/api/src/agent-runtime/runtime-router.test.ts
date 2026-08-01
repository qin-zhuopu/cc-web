// apps/api/src/agent-runtime/runtime-router.test.ts
// RuntimeRouter 单测（c2-6-6）。用假适配器（spy）断言：CLAUDE_SDK 委派 + 入参透传；
// 未注册 Runtime（NATIVE/CODEX）fail-fast 归 error 事件（不静默）；availability 反假数据。

import { describe, it, expect, vi } from 'vitest';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
  AgentStreamEvent,
  ClassifiedError,
  ErrorClassifier,
  AbortSignalLike,
} from '@codepilot/core';
import { RuntimeKind } from '@codepilot/core';
import { RuntimeRouter } from './runtime-router.js';

const fakeClassifier: ErrorClassifier = {
  classify(error: unknown): ClassifiedError {
    return {
      code: 'UNAVAILABLE' as ClassifiedError['code'],
      messageKey: 'sk.error.unavailable',
      retryable: false,
      cause: error,
    };
  },
};

const noopSignal: AbortSignalLike = {
  aborted: false,
  addEventListener: () => {},
  removeEventListener: () => {},
};

function makeRequest(streamId: string, kind: RuntimeKind): RuntimeRunRequest {
  return {
    streamId,
    runtimeKind: kind,
    resolvedProvider: { protocol: 'anthropic', authStyle: 'auth_token', hasCredentials: true, source: 'env' },
    promptView: [],
    content: 'hi',
    options: { mode: 'code', model: 'm' },
    abortSignal: noopSignal,
  };
}

/** 假适配器：run 产出一个 text 事件，interrupt/forceKillTurn/availability 为 spy。 */
function makeFakeAdapter() {
  const runSpy = vi.fn();
  const interruptSpy = vi.fn(async () => 'interrupted');
  const forceKillSpy = vi.fn();
  const adapter: AgentRuntimePort = {
    run(request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent> {
      runSpy(request);
      async function* g(): AsyncIterableIterator<AgentStreamEvent> {
        yield { type: 'text', text: 'ok' };
      }
      return g();
    },
    interrupt: interruptSpy as unknown as AgentRuntimePort['interrupt'],
    forceKillTurn: forceKillSpy as unknown as AgentRuntimePort['forceKillTurn'],
    async availability() {
      return { kind: 'ready' as const };
    },
  };
  return { adapter, runSpy, interruptSpy, forceKillSpy };
}

async function collect(stream: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('RuntimeRouter —— CLAUDE_SDK 委派', () => {
  it('CLAUDE_SDK 请求委派到 ClaudeSdk 适配器，入参透传', async () => {
    const { adapter, runSpy } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    const req = makeRequest('s-1', RuntimeKind.CLAUDE_SDK);
    const events = await collect(router.run(req));
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
    expect(runSpy).toHaveBeenCalledWith(req);
  });

  it('interrupt 按 streamId 定位 runtimeKind 委派对应适配器', async () => {
    const { adapter, interruptSpy } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    // 先 run 建立 streamId → kind 映射（消费触发 run）
    const iter = router.run(makeRequest('s-2', RuntimeKind.CLAUDE_SDK))[Symbol.asyncIterator]();
    await iter.next();
    const status = await router.interrupt({ streamId: 's-2' });
    expect(status).toBe('interrupted');
    expect(interruptSpy).toHaveBeenCalledOnce();
  });

  it('forceKillTurn 按 streamId 委派对应适配器', async () => {
    const { adapter, forceKillSpy } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    const iter = router.run(makeRequest('s-3', RuntimeKind.CLAUDE_SDK))[Symbol.asyncIterator]();
    await iter.next();
    const ref: TurnRef = { streamId: 's-3' };
    router.forceKillTurn(ref);
    expect(forceKillSpy).toHaveBeenCalledWith(ref);
  });
});

describe('RuntimeRouter —— 未注册 Runtime fail-fast（NFR-4）', () => {
  it('NATIVE 未注册 → 产出归一 error 事件（不静默、不卡死）', async () => {
    const { adapter } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    const events = await collect(router.run(makeRequest('s-4', RuntimeKind.NATIVE)));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { error: ClassifiedError }).error.code).toBe('UNAVAILABLE');
  });

  it('CODEX 未注册 → 同样 fail-fast 归 error', async () => {
    const { adapter } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    const events = await collect(router.run(makeRequest('s-5', RuntimeKind.CODEX)));
    expect(events[0]?.type).toBe('error');
  });

  it('interrupt 未知 streamId → null（幂等，不抛）', async () => {
    const { adapter } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    expect(await router.interrupt({ streamId: 'never' })).toBeNull();
  });
});

describe('RuntimeRouter.availability —— 反假数据', () => {
  it('已注册 CLAUDE_SDK → 返回其可用性', async () => {
    const { adapter } = makeFakeAdapter();
    const router = new RuntimeRouter({ [RuntimeKind.CLAUDE_SDK]: adapter }, fakeClassifier);
    expect(await router.availability()).toEqual({ kind: 'ready' });
  });

  it('无任何已注册适配器 → unknown（不显假 ready）', async () => {
    const router = new RuntimeRouter({}, fakeClassifier);
    expect(await router.availability()).toEqual({ kind: 'unknown' });
  });
});
