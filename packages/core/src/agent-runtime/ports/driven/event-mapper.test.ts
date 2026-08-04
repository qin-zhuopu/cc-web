// agent-runtime/ports/driven/event-mapper.test.ts
// C2 · AgentRuntime —— EventMapper 契约 + 未知原生事件降级不崩测试（c2-3-2）。
// 对齐 architecture §3.5、§5.1；PRD FR-4.2/4.3、AC-8。
//
// 用一个最小内联 fakeMapper 实现 EventMapper 契约，断言：
//   1. 已识别原始事件 → 对应 AgentStreamEvent（结构、type、字段忠实）。
//   2. 未识别原始事件（{type:'weird'} / null / 非对象 / 缺 type）→ 返回 null 不抛（AC-8 降级不崩）。
//   3. 不伪造已识别事件、不静默改变已识别事件语义。
//   4. 契约层降级骨架 dropUnknownEvent() 恒返回 null（未来若扩 raw 载体只改此单点）。

import { describe, expect, it } from 'vitest';
import type { EventMapper } from './event-mapper.js';
import { dropUnknownEvent } from './event-mapper.js';
import type { AgentStreamEvent } from '../../domain/event/agent-stream-event.js';

/**
 * fakeMapper —— 最小内联 EventMapper 实现，模拟一个外部 Runtime 的原始事件形状。
 * 只识别少数几类原始事件，其余一律走降级收口（dropUnknownEvent），验证契约与降级语义。
 * 归一分支穷尽后调 dropUnknownEvent() 返回 null，绝不抛、绝不伪造。
 */
const fakeMapper: EventMapper = {
  mapEvent(raw: unknown): AgentStreamEvent | null {
    // 非对象 / null → 降级（AC-8：不崩）。
    if (typeof raw !== 'object' || raw === null) {
      return dropUnknownEvent();
    }
    const evt = raw as Record<string, unknown>;
    switch (evt['kind']) {
      case 'fake_text':
        // 忠实归一为 text，不改变语义（累积后的全文由适配器口径决定，此处原样承载）。
        return { type: 'text', text: String(evt['content'] ?? '') };
      case 'fake_done':
        // 忠实归一为 result；该 Runtime 未上报 token → 不填 tokenUsage（AC-9 精神：不造 0）。
        return { type: 'result' };
      default:
        // 未识别原始事件（含 {kind:'weird'} / 缺 kind）→ 降级收口，返回 null。
        return dropUnknownEvent();
    }
  },
};

describe('EventMapper 契约：已识别原始事件归一为对应 AgentStreamEvent', () => {
  it('fake_text → text 事件，字段忠实、不改变语义', () => {
    const out = fakeMapper.mapEvent({ kind: 'fake_text', content: '你好' });
    expect(out).not.toBeNull();
    expect(out).toEqual({ type: 'text', text: '你好' });
  });

  it('fake_done → result 事件；未上报 token 时不伪造 tokenUsage（不填 0）', () => {
    const out = fakeMapper.mapEvent({ kind: 'fake_done' });
    expect(out).toEqual({ type: 'result' });
    // 反假数据：不得凭空造 tokenUsage 键。
    expect(out && 'tokenUsage' in out).toBe(false);
  });
});

describe('EventMapper 降级：未识别原始事件返回 null 不抛（AC-8 降级不崩）', () => {
  it('未知判别值 {kind:"weird"} → null，不抛', () => {
    expect(() => fakeMapper.mapEvent({ kind: 'weird' })).not.toThrow();
    expect(fakeMapper.mapEvent({ kind: 'weird' })).toBeNull();
  });

  it('缺判别字段的对象 → null，不抛', () => {
    expect(() => fakeMapper.mapEvent({ foo: 1 })).not.toThrow();
    expect(fakeMapper.mapEvent({ foo: 1 })).toBeNull();
  });

  it('null / undefined / 非对象输入 → null，不抛', () => {
    expect(() => fakeMapper.mapEvent(null)).not.toThrow();
    expect(fakeMapper.mapEvent(null)).toBeNull();
    expect(fakeMapper.mapEvent(undefined)).toBeNull();
    expect(fakeMapper.mapEvent(42)).toBeNull();
    expect(fakeMapper.mapEvent('weird')).toBeNull();
    expect(fakeMapper.mapEvent(true)).toBeNull();
    expect(fakeMapper.mapEvent([])).toBeNull();
  });
});

describe('EventMapper 降级：不伪造、不静默改变已识别语义', () => {
  it('降级路径绝不返回已识别事件（不伪造 text/result/error 等）', () => {
    // 未识别输入的归一结果必须是 null，而非任何被伪造的已识别事件。
    const forged = fakeMapper.mapEvent({ kind: 'weird', text: '看似文本但不该被归一' });
    expect(forged).toBeNull();
  });

  it('已识别事件按其本义归一，不张冠李戴（text 不被归一成 result）', () => {
    const out = fakeMapper.mapEvent({ kind: 'fake_text', content: 'abc' });
    expect(out?.type).toBe('text');
    expect(out?.type).not.toBe('result');
  });
});

describe('契约层降级骨架 dropUnknownEvent（AC-8 单点收口）', () => {
  it('恒返回 null（未来扩 raw 载体属 correct-course，仅改此单点）', () => {
    expect(dropUnknownEvent()).toBeNull();
    expect(() => dropUnknownEvent()).not.toThrow();
  });
});
