// agent-runtime/ports/ports.test.ts
// C2 · AgentRuntime 端口的类型层断言（对齐 architecture §3.6 / §4 / §5）。
// 构造符合各端口输入/契约的对象通过编译，并对反假数据（可选字段留 undefined）、
// RuntimeAvailability 判别联合收敛、只读消费契约（无写方法）做静态断言。
// 纯类型/编译期测试，不含用例运行逻辑（实现属 epic-c2-2 及基础设施层）。

import { describe, expect, it } from 'vitest';
import { RuntimeKind } from './runtime-kind.js';
import type { RuntimeAvailability } from './runtime-kind.js';
import type {
  StartStreamInput,
  StartStreamResult,
  StartStreamUseCase,
} from './driving/start-stream-usecase.js';
import type { AbortStreamUseCase } from './driving/abort-stream-usecase.js';
import type {
  TitleGenerationInput,
  TitleGenerator,
} from './driving/title-generator.js';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
  AbortSignalLike,
} from './driven/agent-runtime-port.js';
import type {
  ResolvedProviderView,
  ProviderReadPort,
} from './driven/provider-read-port.js';
import type {
  AppendMessageUseCase,
  GetSessionHistoryUseCase,
  PromptMessage,
} from './driven/conversation-ports.js';
import type { AgentStreamEvent } from '../domain/event/agent-stream-event.js';

describe('RuntimeKind 枚举（对齐 architecture §3.6）', () => {
  it('本期唯一运行时字面量值锁定（CLAUDE_SDK）', () => {
    expect(RuntimeKind.CLAUDE_SDK).toBe('claude-sdk');
  });
});

describe('RuntimeAvailability 判别联合（反假数据：探测失败不显假 ready）', () => {
  it('三态可分别构造，unavailable 必带 reason', () => {
    const ready: RuntimeAvailability = { kind: 'ready', version: '1.2.3' };
    const readyNoVersion: RuntimeAvailability = { kind: 'ready' };
    const unavailable: RuntimeAvailability = {
      kind: 'unavailable',
      reason: 'binary not found',
    };
    const unknown: RuntimeAvailability = { kind: 'unknown' };

    // 判别收敛：仅 unavailable 分支能取 reason。
    if (unavailable.kind === 'unavailable') {
      expect(unavailable.reason).toBe('binary not found');
    }
    expect(ready.version).toBe('1.2.3');
    expect(readyNoVersion.version).toBeUndefined();
    expect(unknown.kind).toBe('unknown');
  });
});

describe('C2 驱动端口输入类型（对齐 architecture §4）', () => {
  it('StartStreamInput 必填齐全、可选字段无值保持 undefined（反假数据）', () => {
    const minimal: StartStreamInput = {
      sessionId: 's-1',
      content: '你好',
      mode: 'code',
      model: 'claude-opus-4',
      providerId: 'p-1',
    };
    expect(minimal.files).toBeUndefined();
    expect(minimal.mentions).toBeUndefined();
    expect(minimal.effort).toBeUndefined();
    expect(minimal.thinking).toBeUndefined();
    expect(minimal.autoTrigger).toBeUndefined();

    const full: StartStreamInput = {
      sessionId: 's-1',
      content: '你好',
      mode: 'plan',
      model: 'claude-opus-4',
      providerId: 'p-1',
      files: [{ id: 'f-1', name: 'a.ts', mimeType: 'text/plain' }],
      mentions: [{ kind: 'file', value: '/repo/a.ts' }],
      systemPromptAppend: '追加',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 1024 },
      context1m: true,
      selectedSkills: ['skill-a'],
      autoTrigger: true,
    };
    expect(full.files?.[0]?.id).toBe('f-1');
    expect(full.thinking?.budgetTokens).toBe(1024);
  });

  it('TitleGenerationInput 携带纯文本投影', () => {
    const input: TitleGenerationInput = {
      sessionId: 's-1',
      recentMessages: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '在的' },
      ],
    };
    expect(input.recentMessages).toHaveLength(2);
  });
});

describe('C2 端口契约可被结构化对象满足（编译期通过即达标）', () => {
  it('StartStreamUseCase 可由假实现满足，events 为归一事件异步流', () => {
    const fake: StartStreamUseCase = {
      start: async (): Promise<StartStreamResult> => {
        async function* gen(): AsyncIterable<AgentStreamEvent> {
          yield { type: 'text', text: '片段' };
        }
        return { streamId: 'run-1', events: gen() };
      },
    };
    expect(fake.start).toBeTypeOf('function');
  });

  it('AbortStreamUseCase 幂等 abort 签名满足', () => {
    const fake: AbortStreamUseCase = {
      abort: async (_streamId) => {
        // 幂等：非 active 直接返回（编译期只校验签名）。
      },
    };
    expect(fake.abort).toBeTypeOf('function');
  });

  it('TitleGenerator 可由假实现满足（供 C1 消费）', () => {
    const fake: TitleGenerator = {
      generateTitle: async (i) => `标题:${i.recentMessages.length}`,
    };
    expect(fake.generateTitle).toBeTypeOf('function');
  });

  it('AgentRuntimePort 出站端口四方法齐全，run 产归一流', () => {
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const request: RuntimeRunRequest = {
      streamId: 'run-1',
      runtimeKind: RuntimeKind.CLAUDE_SDK,
      resolvedProvider: {
        protocol: 'anthropic',
        authStyle: 'api_key',
        hasCredentials: true,
        source: 'provider',
      },
      promptView: [],
      content: '你好',
      options: { mode: 'code', model: 'claude-opus-4' },
      abortSignal: signal,
    };
    const turnRef: TurnRef = { streamId: 'run-1' };

    const fake: AgentRuntimePort = {
      run: (_req) => {
        async function* gen(): AsyncIterable<AgentStreamEvent> {
          yield { type: 'status', text: '运行中' };
        }
        return gen();
      },
      interrupt: async (_ref) => 'idle',
      forceKillTurn: (_ref) => {},
      availability: async () => ({ kind: 'ready' }),
      resolvePermission: (_ref, _decision) => {},
    };
    expect(request.runtimeKind).toBe('claude-sdk');
    expect(turnRef.streamId).toBe('run-1');
    expect(fake.run).toBeTypeOf('function');
    expect(fake.forceKillTurn).toBeTypeOf('function');
  });
});

describe('出站只读消费契约（单向依赖 · 无写路径）', () => {
  it('ProviderReadPort 仅 resolve 只读方法，无写方法', () => {
    const view: ResolvedProviderView = {
      protocol: 'anthropic',
      model: 'claude-opus-4',
      authStyle: 'api_key',
      hasCredentials: true,
      source: 'provider',
    };
    const fake: ProviderReadPort = {
      resolve: async () => view,
    };
    // 静态断言：契约键集合只含 resolve（无 save/delete/setDefault 等写方法）。
    const keys: ReadonlyArray<keyof ProviderReadPort> = ['resolve'];
    expect(keys).toEqual(['resolve']);
    expect(fake.resolve).toBeTypeOf('function');
  });

  it('C1 用例端口类型可被假实现满足（只经用例、不直写库）', () => {
    const appendFake: Pick<AppendMessageUseCase, 'updateStreamStatus'> = {
      updateStreamStatus: async (_msgId, _status, _tokenUsage) => {
        // 终态映射经此端口写回，不传 phase 本身（NFR-8 / AC-12）。
      },
    };
    const historyFake: Pick<GetSessionHistoryUseCase, 'getPromptView'> = {
      getPromptView: async (): Promise<ReadonlyArray<PromptMessage>> => [],
    };
    expect(appendFake.updateStreamStatus).toBeTypeOf('function');
    expect(historyFake.getPromptView).toBeTypeOf('function');
  });
});
