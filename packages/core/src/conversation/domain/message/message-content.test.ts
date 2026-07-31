// conversation/domain/message/message-content.test.ts
// C1 Conversation 领域边界：MessageContent 编解码往返测试（合法路径）。
// 覆盖全 5 类内容块 encode∘decode 往返不丢字段、幂等。

import { describe, it, expect } from 'vitest';
import type { ContentBlock } from './content-block.js';
import {
  encodeContent,
  decodeContent,
  textContent,
} from './message-content.js';

/** 表驱动样例：覆盖全 5 类块及 tool_result 可选字段的存在/缺省组合。 */
const cases: ReadonlyArray<{ name: string; blocks: ReadonlyArray<ContentBlock> }> = [
  {
    name: 'text 块',
    blocks: [{ type: 'text', text: '你好，世界' }],
  },
  {
    name: 'thinking 块',
    blocks: [{ type: 'thinking', thinking: '让我想想……' }],
  },
  {
    name: 'tool_use 块（input 为对象）',
    blocks: [
      { type: 'tool_use', id: 'tu-1', name: 'search', input: { q: 'kiro', limit: 3 } },
    ],
  },
  {
    name: 'tool_use 块（input 为标量）',
    blocks: [{ type: 'tool_use', id: 'tu-2', name: 'echo', input: 42 }],
  },
  {
    name: 'tool_result 块（仅必需字段）',
    blocks: [{ type: 'tool_result', toolUseId: 'tu-1', content: '结果正文' }],
  },
  {
    name: 'tool_result 块（含 isError）',
    blocks: [
      { type: 'tool_result', toolUseId: 'tu-1', content: '出错了', isError: true },
    ],
  },
  {
    name: 'tool_result 块（含 media 与 sources）',
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: '带附件的结果',
        isError: false,
        media: [{ id: 'media-1' }, { id: 'media-2' }],
        sources: [
          { uri: 'https://example.com/a', title: '来源A' },
          { uri: 'https://example.com/b' },
        ],
      },
    ],
  },
  {
    name: 'code 块',
    blocks: [
      { type: 'code', language: 'typescript', code: 'const x = 1;' },
    ],
  },
  {
    name: '多块混合有序',
    blocks: [
      { type: 'text', text: '开头' },
      { type: 'thinking', thinking: '思考' },
      { type: 'tool_use', id: 'tu-9', name: 'run', input: null },
      { type: 'tool_result', toolUseId: 'tu-9', content: '完成' },
      { type: 'code', language: 'json', code: '{}' },
    ],
  },
];

describe('MessageContent 编解码往返（合法路径）', () => {
  it.each(cases)('$name：decode(encode(x)) 深等 x 的 blocks', ({ blocks }) => {
    const content = decodeContent(encodeContent({ blocks, toPlainText: () => '' }));
    expect(content.blocks).toEqual(blocks);
  });

  it.each(cases)('$name：二次 encode 结果稳定（幂等）', ({ blocks }) => {
    const once = encodeContent({ blocks, toPlainText: () => '' });
    const twice = encodeContent(decodeContent(once));
    expect(twice).toBe(once);
  });

  it.each(cases)('$name：decode∘encode 幂等（再往返 blocks 仍深等）', ({ blocks }) => {
    const first = decodeContent(encodeContent({ blocks, toPlainText: () => '' }));
    const second = decodeContent(encodeContent(first));
    expect(second.blocks).toEqual(first.blocks);
  });
});

describe('工具块输入保真（c1-2-4，AC-6）：tool_use.input 任意 JSON 原样保留', () => {
  /** 覆盖任意 JSON 形态：对象 / 数组 / 标量 / null / 布尔 / 字符串 / 深层嵌套。 */
  const inputs: ReadonlyArray<{ name: string; input: unknown }> = [
    { name: '空对象', input: {} },
    { name: '扁平对象', input: { q: 'kiro', limit: 3 } },
    { name: '数组', input: [1, 2, 3] },
    { name: '对象数组', input: [{ a: 1 }, { b: 2 }] },
    { name: '标量数字', input: 42 },
    { name: '标量浮点', input: 3.14 },
    { name: '标量字符串', input: '裸字符串入参' },
    { name: '布尔', input: true },
    { name: 'null', input: null },
    {
      name: '深层嵌套（对象套数组套对象）',
      input: {
        filters: { tags: ['a', 'b'], range: { min: 0, max: 10 } },
        options: [{ k: 'v', nested: { deep: [true, null, 'x'] } }],
        count: 7,
      },
    },
  ];

  it.each(inputs)(
    'tool_use.input=$name：往返后 input 深等',
    ({ input }) => {
      const blocks: ReadonlyArray<ContentBlock> = [
        { type: 'tool_use', id: 'tu-x', name: 'probe', input },
      ];
      const decoded = decodeContent(
        encodeContent({ blocks, toPlainText: () => '' }),
      );
      const block = decoded.blocks[0] as Extract<
        ContentBlock,
        { type: 'tool_use' }
      >;
      expect(block.type).toBe('tool_use');
      expect(block.input).toEqual(input);
    },
  );
});

describe('工具块可选字段保真（c1-2-4，AC-6）：tool_result 可选字段往返一致', () => {
  it('含全部可选字段（isError/media/sources）：往返后逐字段不丢', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: '完整结果',
        isError: true,
        media: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }],
        sources: [
          { uri: 'https://example.com/a', title: '来源A' },
          { uri: 'https://example.com/b' },
        ],
      },
    ];
    const decoded = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    expect(decoded.blocks).toEqual(blocks);
  });

  it('省略全部可选字段：往返后 isError/media/sources 均为 undefined，且不落键（不造假值）', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'tool_result', toolUseId: 'tu-1', content: '仅必需字段' },
    ];
    const decoded = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    const block = decoded.blocks[0] as Extract<
      ContentBlock,
      { type: 'tool_result' }
    >;
    expect(block.isError).toBeUndefined();
    expect(block.media).toBeUndefined();
    expect(block.sources).toBeUndefined();
    // 不落假值：省略的可选字段不应作为键存在（例如不落 isError:false / media:[]）。
    expect(block).not.toHaveProperty('isError');
    expect(block).not.toHaveProperty('media');
    expect(block).not.toHaveProperty('sources');
  });

  it.each([
    { name: 'isError:false 显式保留', isError: false },
    { name: 'isError:true 显式保留', isError: true },
  ])('$name：布尔值往返一致（不被归一化吞掉）', ({ isError }) => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'tool_result', toolUseId: 'tu-1', content: 'x', isError },
    ];
    const decoded = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    const block = decoded.blocks[0] as Extract<
      ContentBlock,
      { type: 'tool_result' }
    >;
    expect(block.isError).toBe(isError);
  });

  it('仅含 media（无 isError/sources）：只保留 media，其余不落键', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: '仅媒体',
        media: [{ id: 'm-only' }],
      },
    ];
    const decoded = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    const block = decoded.blocks[0] as Extract<
      ContentBlock,
      { type: 'tool_result' }
    >;
    expect(block.media).toEqual([{ id: 'm-only' }]);
    expect(block).not.toHaveProperty('isError');
    expect(block).not.toHaveProperty('sources');
  });

  it('sources 中 title 缺省项：往返后该项无 title 键', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: '混合来源',
        sources: [{ uri: 'https://example.com/no-title' }],
      },
    ];
    const decoded = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    const block = decoded.blocks[0] as Extract<
      ContentBlock,
      { type: 'tool_result' }
    >;
    expect(block.sources).toEqual([{ uri: 'https://example.com/no-title' }]);
    expect(block.sources?.[0]).not.toHaveProperty('title');
  });
});

describe('textContent 便捷构造', () => {
  it('构造单 text 块', () => {
    const content = textContent('单条文本');
    expect(content.blocks).toEqual([{ type: 'text', text: '单条文本' }]);
  });

  it('往返保真', () => {
    const content = textContent('往返文本');
    expect(decodeContent(encodeContent(content)).blocks).toEqual(content.blocks);
  });
});

describe('decodeContent 脏输入降级（c1-2-3）：永不抛、降级为可见 text，绝不静默丢弃', () => {
  it('非 JSON 字符串：不抛，降级为单 text 块且 text === raw', () => {
    const raw = 'not json {';
    let content!: ReturnType<typeof decodeContent>;
    expect(() => {
      content = decodeContent(raw);
    }).not.toThrow();
    expect(content.blocks).toEqual([{ type: 'text', text: raw }]);
  });

  it('合法 JSON 但为对象（非数组）：不抛，降级为单 text 块且 text === raw', () => {
    const raw = '{"type":"text","text":"我是对象不是数组"}';
    let content!: ReturnType<typeof decodeContent>;
    expect(() => {
      content = decodeContent(raw);
    }).not.toThrow();
    expect(content.blocks).toEqual([{ type: 'text', text: raw }]);
  });

  it.each([
    { name: '标量数字', raw: '42' },
    { name: '标量字符串', raw: '"裸字符串"' },
    { name: 'null', raw: 'null' },
    { name: '布尔', raw: 'true' },
  ])('合法 JSON 但为 $name（非数组）：降级为单 text 块且 text === raw', ({ raw }) => {
    const content = decodeContent(raw);
    expect(content.blocks).toEqual([{ type: 'text', text: raw }]);
  });

  it('数组含未知 type 的块：该块字符串化降级为 text，合法块保留', () => {
    const unknownBlock = { type: 'image', url: 'https://example.com/x.png' };
    const raw = JSON.stringify([
      { type: 'text', text: '合法开头' },
      unknownBlock,
      { type: 'code', language: 'ts', code: 'const y = 2;' },
    ]);
    const content = decodeContent(raw);
    expect(content.blocks).toEqual([
      { type: 'text', text: '合法开头' },
      { type: 'text', text: JSON.stringify(unknownBlock) },
      { type: 'code', language: 'ts', code: 'const y = 2;' },
    ]);
  });

  it('数组含缺 type 的对象：视为未知块，字符串化降级为 text', () => {
    const noTypeBlock = { text: '我没有 type' };
    const raw = JSON.stringify([noTypeBlock]);
    const content = decodeContent(raw);
    expect(content.blocks).toEqual([
      { type: 'text', text: JSON.stringify(noTypeBlock) },
    ]);
  });

  it.each([
    { name: '标量数字', el: 7 },
    { name: '标量字符串', el: 'abc' },
    { name: 'null', el: null },
  ])('数组含非对象元素（$name）：字符串化降级为 text（非静默丢弃）', ({ el }) => {
    const raw = JSON.stringify([el]);
    const content = decodeContent(raw);
    expect(content.blocks).toEqual([
      { type: 'text', text: JSON.stringify(el) },
    ]);
  });

  it('反假数据：降级是保留而非丢弃——脏块不会让 blocks 变空', () => {
    const raw = JSON.stringify([{ type: 'image' }, 99, null]);
    const content = decodeContent(raw);
    expect(content.blocks).toHaveLength(3);
    expect(content.blocks.every((b) => b.type === 'text')).toBe(true);
  });

  it.each([
    { name: 'media 为标量（非数组）', raw: '[{"type":"tool_result","toolUseId":"t","content":"c","media":42}]' },
    { name: 'media 含 null 元素', raw: '[{"type":"tool_result","toolUseId":"t","content":"c","media":[null]}]' },
    { name: 'sources 为标量（非数组）', raw: '[{"type":"tool_result","toolUseId":"t","content":"c","sources":"x"}]' },
    { name: 'sources 含标量元素', raw: '[{"type":"tool_result","toolUseId":"t","content":"c","sources":[7]}]' },
  ])('合法 tool_result 但 $name：不抛，整块降级为 text（永不抛契约）', ({ raw }) => {
    let content!: ReturnType<typeof decodeContent>;
    expect(() => {
      content = decodeContent(raw);
    }).not.toThrow();
    // 畸形 tool_result 整块字符串化降级为单 text 块（可见保留，非静默丢弃）。
    expect(content.blocks).toHaveLength(1);
    expect(content.blocks[0]?.type).toBe('text');
  });
});

describe('toPlainText 纯文本投影（c1-2-5）：拼 text/code 块、跳非文本块、顺序与 \\n 分隔', () => {
  it('混合块（text+thinking+tool_use+code）：仅含 text/code 正文，非文本块被跳过，顺序与分隔正确', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'text', text: '开头文本' },
      { type: 'thinking', thinking: '内部思考不应出现' },
      { type: 'tool_use', id: 'tu-1', name: 'search', input: { q: '不应出现' } },
      { type: 'code', language: 'typescript', code: 'const x = 1;' },
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: '工具结果不应出现',
      },
      { type: 'text', text: '结尾文本' },
    ];
    const content = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    const plain = content.toPlainText();
    // 稳定断言：严格等于按顺序拼接的 text/code 正文，以 '\n' 连接。
    expect(plain).toBe('开头文本\nconst x = 1;\n结尾文本');
    // 非文本块内容一律不出现。
    expect(plain).not.toContain('内部思考不应出现');
    expect(plain).not.toContain('search');
    expect(plain).not.toContain('不应出现');
    expect(plain).not.toContain('工具结果不应出现');
    // code 块只取纯代码，不带 language 标注。
    expect(plain).not.toContain('typescript');
  });

  it('顺序保真：text 与 code 交替，产出严格按 blocks 顺序', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'code', language: 'py', code: 'a = 1' },
      { type: 'text', text: '中间' },
      { type: 'code', language: 'py', code: 'b = 2' },
    ];
    const content = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    expect(content.toPlainText()).toBe('a = 1\n中间\nb = 2');
  });

  it('全为非文本块（thinking/tool_use/tool_result）：产出空串', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'thinking', thinking: '想' },
      { type: 'tool_use', id: 'tu-2', name: 'run', input: null },
      { type: 'tool_result', toolUseId: 'tu-2', content: '结果' },
    ];
    const content = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    expect(content.toPlainText()).toBe('');
  });

  it('被跳过的块不产生额外分隔：text 之间夹非文本块仍只有单个 \\n', () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'text', text: '第一行' },
      { type: 'thinking', thinking: '被跳过' },
      { type: 'text', text: '第二行' },
    ];
    const content = decodeContent(
      encodeContent({ blocks, toPlainText: () => '' }),
    );
    expect(content.toPlainText()).toBe('第一行\n第二行');
  });

  it('纯函数：同一内容多次调用产出稳定一致', () => {
    const content = textContent('稳定投影');
    expect(content.toPlainText()).toBe(content.toPlainText());
    expect(content.toPlainText()).toBe('稳定投影');
  });

  it('textContent 的 toPlainText 返回其文本', () => {
    expect(textContent('唯一文本').toPlainText()).toBe('唯一文本');
  });
});
