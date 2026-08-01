// conversation/domain/message/content-block.test.ts
// C1 Conversation 领域边界：ContentBlock 判别联合的类型层断言。
//
// 本文件以「构造合法字面量 + 断言收窄结果」的方式，在类型层验证 §3.4 的 5 类块定义。
// 这些用例的价值主要在编译期（tsc --build）——若字段形状 / 判别标签被改坏，编译即失败；
// 运行期断言仅作为对「构造确实成立」的最小佐证。

import { describe, expect, it } from 'vitest';
import type {
  CodeBlock,
  ContentBlock,
  ExternalSourceRef,
  MediaRef,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './content-block.js';

describe('ContentBlock 判别联合', () => {
  it('5 类块各能构造合法字面量并归入 ContentBlock', () => {
    const text: ContentBlock = { type: 'text', text: '你好' };
    const thinking: ContentBlock = { type: 'thinking', thinking: '思考中' };
    const toolUse: ContentBlock = {
      type: 'tool_use',
      id: 'tu-1',
      name: 'read_file',
      input: { path: '/tmp/a.txt' },
    };
    const toolResult: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'tu-1',
      content: '文件内容',
    };
    const code: ContentBlock = {
      type: 'code',
      language: 'ts',
      code: 'const x = 1;',
    };

    const blocks: ReadonlyArray<ContentBlock> = [
      text,
      thinking,
      toolUse,
      toolResult,
      code,
    ];
    expect(blocks).toHaveLength(5);
  });

  it('type 判别标签可将联合收窄到具体块类型', () => {
    // narrow 接收联合，按 type 收窄后访问各自专属字段——任一分支若访问了不属于该块的字段，编译即失败。
    function narrow(block: ContentBlock): string {
      switch (block.type) {
        case 'text': {
          const t: TextBlock = block;
          return t.text;
        }
        case 'thinking': {
          const t: ThinkingBlock = block;
          return t.thinking;
        }
        case 'tool_use': {
          const t: ToolUseBlock = block;
          return `${t.id}:${t.name}`;
        }
        case 'tool_result': {
          const t: ToolResultBlock = block;
          return `${t.toolUseId}:${t.content}`;
        }
        case 'code': {
          const t: CodeBlock = block;
          return `${t.language}:${t.code}`;
        }
        default: {
          // 穷尽性检查：若未来新增块类型而未在此处理，never 赋值将编译失败。
          const exhaustive: never = block;
          return exhaustive;
        }
      }
    }

    expect(narrow({ type: 'text', text: 'hi' })).toBe('hi');
    expect(narrow({ type: 'thinking', thinking: 'hmm' })).toBe('hmm');
    expect(
      narrow({ type: 'tool_use', id: 'i', name: 'n', input: null }),
    ).toBe('i:n');
    expect(
      narrow({ type: 'tool_result', toolUseId: 'u', content: 'c' }),
    ).toBe('u:c');
    expect(narrow({ type: 'code', language: 'ts', code: 'x' })).toBe('ts:x');
  });

  it('tool_use.input 接受任意 JSON 值', () => {
    // 对象 / 数组 / 字符串 / 数字 / 布尔 / null 均为合法 input——unknown 不对结构设限。
    const inputs: ReadonlyArray<unknown> = [
      { a: 1, nested: { b: [2, 3] } },
      [1, 2, 3],
      'plain string',
      42,
      true,
      null,
    ];
    const blocks: ReadonlyArray<ToolUseBlock> = inputs.map((input) => ({
      type: 'tool_use',
      id: 'tu',
      name: 'tool',
      input,
    }));
    expect(blocks).toHaveLength(inputs.length);
  });

  it('tool_result 的可选字段（isError/media/sources）可省略', () => {
    // 最小形态：仅必填字段。
    const minimal: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'u',
      content: 'c',
    };
    expect(minimal.isError).toBeUndefined();
    expect(minimal.media).toBeUndefined();
    expect(minimal.sources).toBeUndefined();

    // 完整形态：携带可选字段。
    const media: ReadonlyArray<MediaRef> = [{ id: 'm-1' }];
    const sources: ReadonlyArray<ExternalSourceRef> = [
      { uri: 'https://example.com', title: '示例' },
      { uri: 'https://example.org' }, // title 可省略
    ];
    const full: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'u',
      content: 'c',
      isError: true,
      media,
      sources,
    };
    expect(full.isError).toBe(true);
    expect(full.media).toHaveLength(1);
    expect(full.sources).toHaveLength(2);
  });
});
