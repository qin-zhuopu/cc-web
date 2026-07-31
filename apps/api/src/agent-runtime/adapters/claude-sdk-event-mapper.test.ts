// apps/api/src/agent-runtime/adapters/claude-sdk-event-mapper.test.ts
// ClaudeSdkEventMapper 表驱动单测（c2-6-1a）。用内联录制的 SDK message 样本，无真实网络。
// 覆盖：assistant 消息展开 text/thinking/tool_use/tool_result；Kimi reasoning_content→thinking；
// result usage 有上报才带 / 无则省略（AC-9）；未识别/非对象→降级（空/null，AC-8）。

import { describe, it, expect } from 'vitest';
import { ClaudeSdkEventMapper } from './claude-sdk-event-mapper.js';

const mapper = new ClaudeSdkEventMapper();

/** 构造最小 assistant SDK 消息（只填本 mapper 关心的字段）。 */
function assistantMsg(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: { content },
    parent_tool_use_id: null,
    uuid: 'u-1',
    session_id: 's-1',
    ...extra,
  };
}

describe('ClaudeSdkEventMapper.mapMessage —— assistant 内容块归一', () => {
  it('text 块 → text 事件（全文语义）', () => {
    const events = mapper.mapMessage(assistantMsg([{ type: 'text', text: '你好世界' }]));
    expect(events).toEqual([{ type: 'text', text: '你好世界' }]);
  });

  it('thinking 块 → thinking 事件（delta 载全文）', () => {
    const events = mapper.mapMessage(
      assistantMsg([{ type: 'thinking', thinking: '让我想想' }]),
    );
    expect(events).toEqual([{ type: 'thinking', delta: '让我想想' }]);
  });

  it('redacted_thinking 块 → 跳过（不伪造明文）', () => {
    const events = mapper.mapMessage(
      assistantMsg([{ type: 'redacted_thinking', data: 'xxx' }]),
    );
    expect(events).toEqual([]);
  });

  it('tool_use 块 → tool_use 事件（id/name/input 归一）', () => {
    const events = mapper.mapMessage(
      assistantMsg([
        { type: 'tool_use', id: 't-1', name: 'read_file', input: { path: '/a.ts' } },
      ]),
    );
    expect(events).toEqual([
      { type: 'tool_use', tool: { id: 't-1', name: 'read_file', input: { path: '/a.ts' } } },
    ]);
  });

  it('tool_use input 缺失 → 归一为空对象（不臆造）', () => {
    const events = mapper.mapMessage(
      assistantMsg([{ type: 'tool_use', id: 't-2', name: 'noop' }]),
    );
    expect(events).toEqual([
      { type: 'tool_use', tool: { id: 't-2', name: 'noop', input: {} } },
    ]);
  });

  it('tool_result 块（字符串 content）→ tool_result 事件', () => {
    const events = mapper.mapMessage(
      assistantMsg([{ type: 'tool_result', tool_use_id: 't-1', content: '文件内容', is_error: false }]),
    );
    expect(events).toEqual([
      { type: 'tool_result', result: { toolUseId: 't-1', content: '文件内容', isError: false } },
    ]);
  });

  it('tool_result 块（结构化 content 数组）→ 拼接 text 块', () => {
    const events = mapper.mapMessage(
      assistantMsg([
        {
          type: 'tool_result',
          tool_use_id: 't-3',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'image', source: {} },
            { type: 'text', text: '第二段' },
          ],
          is_error: true,
        },
      ]),
    );
    expect(events).toEqual([
      { type: 'tool_result', result: { toolUseId: 't-3', content: '第一段第二段', isError: true } },
    ]);
  });

  it('多块混合（thinking + text + tool_use）→ 按序展开多个事件', () => {
    const events = mapper.mapMessage(
      assistantMsg([
        { type: 'thinking', thinking: '先分析' },
        { type: 'text', text: '这是答案' },
        { type: 'tool_use', id: 't-9', name: 'run', input: {} },
      ]),
    );
    expect(events).toEqual([
      { type: 'thinking', delta: '先分析' },
      { type: 'text', text: '这是答案' },
      { type: 'tool_use', tool: { id: 't-9', name: 'run', input: {} } },
    ]);
  });
});

describe('ClaudeSdkEventMapper —— Kimi reasoning_content 归一（litellm 特性）', () => {
  it('SDK 消息顶层 reasoning_content → thinking 事件（先于正文）', () => {
    const events = mapper.mapMessage(
      assistantMsg([{ type: 'text', text: '连通' }], { reasoning_content: '用户要我回复连通' }),
    );
    expect(events).toEqual([
      { type: 'thinking', delta: '用户要我回复连通' },
      { type: 'text', text: '连通' },
    ]);
  });

  it('message 内层 reasoning_content 也能提取', () => {
    const events = mapper.mapMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }], reasoning_content: '内层思考' },
      parent_tool_use_id: null,
      uuid: 'u',
      session_id: 's',
    });
    expect(events).toEqual([
      { type: 'thinking', delta: '内层思考' },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('空 reasoning_content 不产出 thinking 事件', () => {
    const events = mapper.mapMessage(
      assistantMsg([{ type: 'text', text: 'x' }], { reasoning_content: '' }),
    );
    expect(events).toEqual([{ type: 'text', text: 'x' }]);
  });
});

describe('ClaudeSdkEventMapper —— result 事件 token 投影（AC-9 反假数据）', () => {
  it('有 usage 上报 → result 带 tokenUsage（各计数如实投影）', () => {
    const events = mapper.mapMessage({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 13,
        output_tokens: 61,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    });
    expect(events).toEqual([
      {
        type: 'result',
        tokenUsage: {
          inputTokens: 13,
          outputTokens: 61,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 2,
        },
      },
    ]);
  });

  it('部分 usage（无缓存字段）→ 只带有值字段，不填 0', () => {
    const events = mapper.mapMessage({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(events).toEqual([
      { type: 'result', tokenUsage: { inputTokens: 10, outputTokens: 20 } },
    ]);
    const usage = (events[0] as { tokenUsage?: Record<string, unknown> }).tokenUsage!;
    expect('cacheReadInputTokens' in usage).toBe(false);
    expect('totalTokens' in usage).toBe(false);
  });

  it('无 usage 上报 → result 不带 tokenUsage（省略，绝不填 0，AC-9）', () => {
    const events = mapper.mapMessage({ type: 'result', subtype: 'success' });
    expect(events).toEqual([{ type: 'result' }]);
    expect('tokenUsage' in (events[0] as object)).toBe(false);
  });

  it('usage 缺 input/output（非有限数）→ 整体省略 tokenUsage（不填 0）', () => {
    const events = mapper.mapMessage({
      type: 'result',
      subtype: 'success',
      usage: { output_tokens: 20 }, // 缺 input_tokens
    });
    expect(events).toEqual([{ type: 'result' }]);
  });
});

describe('ClaudeSdkEventMapper —— 降级（AC-8）', () => {
  it('非对象输入 → 空数组', () => {
    expect(mapper.mapMessage(null)).toEqual([]);
    expect(mapper.mapMessage(undefined)).toEqual([]);
    expect(mapper.mapMessage('weird')).toEqual([]);
    expect(mapper.mapMessage(42)).toEqual([]);
  });

  it('未识别 type（system/user/stream_event）→ 空数组（不抛不伪造）', () => {
    expect(mapper.mapMessage({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(mapper.mapMessage({ type: 'user', message: {} })).toEqual([]);
    expect(mapper.mapMessage({ type: 'stream_event', event: {} })).toEqual([]);
    expect(mapper.mapMessage({ type: 'totally_unknown' })).toEqual([]);
  });

  it('assistant 但 content 非数组 → 空数组（不崩）', () => {
    expect(mapper.mapMessage({ type: 'assistant', message: { content: 'oops' } })).toEqual([]);
    expect(mapper.mapMessage({ type: 'assistant' })).toEqual([]);
  });
});

describe('ClaudeSdkEventMapper.mapEvent —— 核心 EventMapper 契约（1 进 0/1 出）', () => {
  it('恰好 1 个事件 → 返回该事件', () => {
    expect(mapper.mapEvent(assistantMsg([{ type: 'text', text: 'hi' }]))).toEqual({
      type: 'text',
      text: 'hi',
    });
  });

  it('未识别 → null（降级）', () => {
    expect(mapper.mapEvent(null)).toBeNull();
    expect(mapper.mapEvent({ type: 'system' })).toBeNull();
  });

  it('多事件（多块）→ null（多事件请走 mapMessage）', () => {
    expect(
      mapper.mapEvent(
        assistantMsg([
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ]),
      ),
    ).toBeNull();
  });
});
