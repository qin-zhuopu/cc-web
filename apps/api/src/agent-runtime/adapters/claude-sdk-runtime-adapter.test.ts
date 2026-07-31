// apps/api/src/agent-runtime/adapters/claude-sdk-runtime-adapter.test.ts
// ClaudeSdkRuntimeAdapter 单测（c2-6-1b）。用 mock query()（返回可控假 message 序列）+ 假 Query 句柄，
// 不打真网络。覆盖：run 注册句柄+产出归一流、options.env 注入、interrupt 组合 abort+Query.interrupt+返回权威状态、
// forceKillTurn 关句柄、late-unregister no-op（AC-6）、SDK 抛错归一成 error 事件、availability 反假数据。

import { describe, it, expect, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  RuntimeRunRequest,
  AgentStreamEvent,
  AbortSignalLike,
  ClassifiedError,
  ErrorClassifier,
} from '@codepilot/core';
import { RuntimeKind } from '@codepilot/core';
import { ClaudeSdkEventMapper } from './claude-sdk-event-mapper.js';
import {
  ClaudeSdkRuntimeAdapter,
  type ClaudeSdkQueryFn,
  type RuntimeEnvConfig,
} from './claude-sdk-runtime-adapter.js';

// —— 假件 ——

const ENV: RuntimeEnvConfig = {
  ANTHROPIC_BASE_URL: 'https://litellm.jereh.cn',
  ANTHROPIC_AUTH_TOKEN: 'sk-test-token',
  ANTHROPIC_MODEL: 'Jereh-Kimi-K2.6',
};

/** 简单 ErrorClassifier 替身：把任意错误归一为带 code 的 ClassifiedError。 */
const fakeClassifier: ErrorClassifier = {
  classify(error: unknown): ClassifiedError {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 'UNKNOWN' as ClassifiedError['code'], messageKey: 'sk.error.unknown', retryable: false, cause: error };
    void message;
  },
};

/** 最小 AbortSignalLike 替身（可手动触发 abort）。 */
function makeAbortSignal(): AbortSignalLike & { fire(): void } {
  const listeners: Array<() => void> = [];
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    addEventListener(_type: 'abort', listener: () => void) {
      listeners.push(listener);
    },
    removeEventListener(_type: 'abort', listener: () => void) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire() {
      aborted = true;
      listeners.forEach((l) => l());
    },
  };
}

function makeRequest(streamId: string, content = '你好'): RuntimeRunRequest {
  return {
    streamId,
    runtimeKind: RuntimeKind.CLAUDE_SDK,
    resolvedProvider: { protocol: 'anthropic', authStyle: 'auth_token', hasCredentials: true, source: 'env' },
    promptView: [],
    content,
    options: { mode: 'code', model: 'Jereh-Kimi-K2.6' },
    abortSignal: makeAbortSignal(),
  };
}

/** 构造一个假 Query：给定 message 序列，interrupt 为 spy。 */
function makeFakeQuery(messages: SDKMessage[], opts: { throwErr?: unknown } = {}): Query & {
  interruptSpy: ReturnType<typeof vi.fn>;
} {
  const interruptSpy = vi.fn(async () => undefined);
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for (const m of messages) {
      yield m;
    }
    if (opts.throwErr !== undefined) {
      throw opts.throwErr;
    }
  }
  const q = gen() as unknown as Query & { interruptSpy: ReturnType<typeof vi.fn> };
  q.interrupt = interruptSpy as unknown as Query['interrupt'];
  q.interruptSpy = interruptSpy;
  return q;
}

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

async function collect(stream: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function makeAdapter(queryFn: ClaudeSdkQueryFn) {
  return new ClaudeSdkRuntimeAdapter(new ClaudeSdkEventMapper(), ENV, fakeClassifier, queryFn);
}

describe('ClaudeSdkRuntimeAdapter.run —— 注册句柄 + 归一流 + env 注入', () => {
  it('run 产出经 mapper 归一的 AgentStreamEvent 流', async () => {
    const q = makeFakeQuery([assistantText('连通'), { type: 'result', subtype: 'success' } as unknown as SDKMessage]);
    const adapter = makeAdapter(() => q);
    const events = await collect(adapter.run(makeRequest('s-1')));
    expect(events).toEqual([{ type: 'text', text: '连通' }, { type: 'result' }]);
  });

  it('options.env 注入了 .env 配置（base url + token + model）', async () => {
    const queryFn = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      // 断言 env 被注入
      expect(params.options?.env?.ANTHROPIC_BASE_URL).toBe('https://litellm.jereh.cn');
      expect(params.options?.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-token');
      expect(params.options?.env?.ANTHROPIC_MODEL).toBe('Jereh-Kimi-K2.6');
      expect(params.options?.abortController).toBeInstanceOf(AbortController);
      return makeFakeQuery([]);
    });
    await collect(makeAdapter(queryFn as unknown as ClaudeSdkQueryFn).run(makeRequest('s-2')));
    expect(queryFn).toHaveBeenCalledOnce();
  });

  it('SDK 迭代抛错 → 归一成 error 事件（不静默吞、不停在成功）', async () => {
    const q = makeFakeQuery([assistantText('部分')], { throwErr: new Error('网络炸了') });
    const events = await collect(makeAdapter(() => q).run(makeRequest('s-3')));
    expect(events[0]).toEqual({ type: 'text', text: '部分' });
    expect(events[1]?.type).toBe('error');
  });
});

describe('ClaudeSdkRuntimeAdapter.interrupt —— 组合 abort + Query.interrupt', () => {
  it('interrupt 调 Query.interrupt 并返回权威状态 interrupted', async () => {
    const q = makeFakeQuery([assistantText('x')]);
    const adapter = makeAdapter(() => q);
    // run 但不消费完（保持句柄注册）——手动启动迭代器注册句柄
    const stream = adapter.run(makeRequest('s-4'));
    const iter = stream[Symbol.asyncIterator]();
    await iter.next(); // 拿第一个事件，句柄已注册
    const status = await adapter.interrupt({ streamId: 's-4' });
    expect(status).toBe('interrupted');
    expect(q.interruptSpy).toHaveBeenCalledOnce();
  });

  it('interrupt 不存在的 streamId → 幂等返回 null（no-op）', async () => {
    const adapter = makeAdapter(() => makeFakeQuery([]));
    expect(await adapter.interrupt({ streamId: 'never' })).toBeNull();
  });

  it('Query.interrupt 抛错 → 返回 null（交核心 force-abort 兜底，不抛）', async () => {
    const q = makeFakeQuery([assistantText('x')]);
    q.interrupt = vi.fn(async () => {
      throw new Error('interrupt 失败');
    }) as unknown as Query['interrupt'];
    const adapter = makeAdapter(() => q);
    const iter = adapter.run(makeRequest('s-5'))[Symbol.asyncIterator]();
    await iter.next();
    expect(await adapter.interrupt({ streamId: 's-5' })).toBeNull();
  });
});

describe('ClaudeSdkRuntimeAdapter.forceKillTurn + late-unregister no-op（AC-6）', () => {
  it('forceKillTurn 关句柄；不存在的 streamId → no-op 不抛', () => {
    const adapter = makeAdapter(() => makeFakeQuery([]));
    expect(() => adapter.forceKillTurn({ streamId: 'never' })).not.toThrow();
  });

  it('late-unregister no-op：旧 turn 收尾不 evict 复用同 streamId 的新句柄', async () => {
    // 两个不同 Query 句柄，但先后用同一 streamId（模拟 late teardown 竞态）。
    const qOld = makeFakeQuery([assistantText('old')]);
    const qNew = makeFakeQuery([assistantText('new')]);
    let call = 0;
    const adapter = makeAdapter(() => (call++ === 0 ? qOld : qNew));

    // 起旧 turn 并消费完（其 finally 会 unregister s-6）
    await collect(adapter.run(makeRequest('s-6')));
    // 起新 turn 复用 s-6，注册新句柄
    const newStream = adapter.run(makeRequest('s-6'));
    const iter = newStream[Symbol.asyncIterator]();
    await iter.next();

    // 新 turn 句柄应仍在（旧 turn 的 finally 已跑过，但 unregister 校验归属，未误删新句柄）
    // interrupt 新 turn 应命中（返回 interrupted），证明新句柄未被旧 turn 的 late-unregister evict
    expect(await adapter.interrupt({ streamId: 's-6' })).toBe('interrupted');
    expect(qNew.interruptSpy).toHaveBeenCalledOnce();
    expect(qOld.interruptSpy).not.toHaveBeenCalled();
  });
});

describe('ClaudeSdkRuntimeAdapter.availability —— 反假数据', () => {
  it('配置齐全 → ready', async () => {
    expect(await makeAdapter(() => makeFakeQuery([])).availability()).toEqual({ kind: 'ready' });
  });

  it('缺 token → unavailable + reason（不显假 ready）', async () => {
    const adapter = new ClaudeSdkRuntimeAdapter(
      new ClaudeSdkEventMapper(),
      { ANTHROPIC_BASE_URL: 'https://litellm.jereh.cn' },
      fakeClassifier,
      () => makeFakeQuery([]),
    );
    const av = await adapter.availability();
    expect(av.kind).toBe('unavailable');
    expect(av.kind === 'unavailable' && av.reason).toContain('ANTHROPIC_AUTH_TOKEN');
  });
});
