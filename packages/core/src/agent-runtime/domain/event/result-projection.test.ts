// agent-runtime/domain/event/result-projection.test.ts
// C2 · AgentRuntime —— result 事件 token 投影测试（c2-3-3）。
// 覆盖 AC-9 反假数据：完整 usage 保留、缺字段留 undefined、完全无 usage 时 tokenUsage 为 undefined（不造 0）。
import { describe, expect, it } from 'vitest';

import type { AgentStreamEvent, TokenUsage } from './agent-stream-event.js';
import { projectResultTokenUsage } from './result-projection.js';
import type { RawTokenUsageReport } from './result-projection.js';

describe('projectResultTokenUsage —— 完整 usage 投影保留', () => {
  it('全字段上报时原样投影', () => {
    const raw: RawTokenUsageReport = {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      totalTokens: 370,
    };
    const usage = projectResultTokenUsage(raw);
    expect(usage).toEqual<TokenUsage>({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      totalTokens: 370,
    });
  });

  it('必填计数上报为真实 0 时保留（0 是真数据，非臆造）', () => {
    const usage = projectResultTokenUsage({ inputTokens: 0, outputTokens: 0 });
    expect(usage).toEqual<TokenUsage>({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('projectResultTokenUsage —— 缺字段留 undefined（不补 0，AC-9）', () => {
  it('只上报必填计数时，可选字段整体省略', () => {
    const usage = projectResultTokenUsage({ inputTokens: 12, outputTokens: 8 });
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.outputTokens).toBe(8);
    // 未上报的可选字段留 undefined，且键本身不存在（不补 0）
    expect(usage?.cacheReadInputTokens).toBeUndefined();
    expect(usage?.cacheCreationInputTokens).toBeUndefined();
    expect(usage?.totalTokens).toBeUndefined();
    expect('cacheReadInputTokens' in (usage as object)).toBe(false);
    expect('totalTokens' in (usage as object)).toBe(false);
  });

  it('部分可选字段上报时只并入已上报者', () => {
    const usage = projectResultTokenUsage({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: 3,
    });
    expect(usage).toEqual<TokenUsage>({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: 3,
    });
    expect('cacheCreationInputTokens' in (usage as object)).toBe(false);
    expect('totalTokens' in (usage as object)).toBe(false);
  });

  it('null 值的字段视为未上报，不投影', () => {
    const usage = projectResultTokenUsage({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: null,
      totalTokens: null,
    });
    expect(usage).toEqual<TokenUsage>({ inputTokens: 5, outputTokens: 7 });
  });

  it('NaN / Infinity 等非有限值视为未上报，不投影', () => {
    const usage = projectResultTokenUsage({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: Number.NaN,
      totalTokens: Number.POSITIVE_INFINITY,
    });
    expect(usage).toEqual<TokenUsage>({ inputTokens: 5, outputTokens: 7 });
  });
});

describe('projectResultTokenUsage —— 完全无 usage 时 tokenUsage 为 undefined（不造 0）', () => {
  it('raw 为 undefined 时返回 undefined', () => {
    expect(projectResultTokenUsage(undefined)).toBeUndefined();
  });

  it('raw 为 null 时返回 undefined', () => {
    expect(projectResultTokenUsage(null)).toBeUndefined();
  });

  it('空对象（无任何上报）时返回 undefined，不造 0', () => {
    expect(projectResultTokenUsage({})).toBeUndefined();
  });

  it('必填计数缺一（只上报 input）时整体留空，绝不填 0 凑齐', () => {
    const usage = projectResultTokenUsage({ inputTokens: 10 });
    expect(usage).toBeUndefined();
  });

  it('必填计数缺一（只上报 output）时整体留空，绝不填 0 凑齐', () => {
    const usage = projectResultTokenUsage({ outputTokens: 10 });
    expect(usage).toBeUndefined();
  });

  it('必填计数为 null 时整体留空（不因有可选字段而填 0）', () => {
    const usage = projectResultTokenUsage({
      inputTokens: null,
      outputTokens: null,
      totalTokens: 999,
    });
    expect(usage).toBeUndefined();
  });
});

describe('projectResultTokenUsage —— 用于构造 result 事件（反假数据端到端）', () => {
  it('无上报时 result.tokenUsage 省略，UI 据此隐藏不显假 0', () => {
    const event: AgentStreamEvent = {
      type: 'result',
      tokenUsage: projectResultTokenUsage(null),
    };
    if (event.type === 'result') {
      expect(event.tokenUsage).toBeUndefined();
    }
  });

  it('有上报时 result.tokenUsage 携带投影结果', () => {
    const event: AgentStreamEvent = {
      type: 'result',
      tokenUsage: projectResultTokenUsage({ inputTokens: 1, outputTokens: 2 }),
    };
    if (event.type === 'result') {
      expect(event.tokenUsage).toEqual<TokenUsage>({ inputTokens: 1, outputTokens: 2 });
    }
  });
});
