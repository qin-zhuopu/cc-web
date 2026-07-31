// conversation/domain/message/message-content.ts
// C1 Conversation 领域边界：消息内容值对象（MessageContent）与其编解码。
// 对齐 architecture §3.4（第 156-166 行）。
//
// 一条持久消息的正文是一个 MessageContent：以有序的 ContentBlock 列表承载
// text / thinking / tool_use / tool_result / code 五类块，并可投影为纯文本。
//
// 本文件负责：
//   - 富类型 MessageContent（blocks + toPlainText 投影）。
//   - encodeContent：MessageContent → JSON string（落库用）。
//   - decodeContent：JSON string → MessageContent（本故事仅合法路径；
//     脏输入降级归 c1-2-3）。
//   - textContent：单 text 块便捷构造。
//
// 零框架依赖、无 I/O、字段全 readonly。

import type {
  ContentBlock,
  MediaRef,
  ExternalSourceRef,
} from './content-block.js';

/**
 * MessageContent：消息内容值对象。
 *
 * blocks 为有序的内容块列表（判别联合 ContentBlock）；toPlainText 将其投影为
 * 单一纯文本串（供检索 / 摘要 / 日志等消费）。
 */
export interface MessageContent {
  readonly blocks: ReadonlyArray<ContentBlock>;
  /**
   * 将 blocks 投影为稳定纯文本（对齐 architecture §3.4 第 159 行注释「拼接 text/code 块」）。
   *
   * 【投影规则（c1-2-5，固定选择）】
   *   - 取文块：仅 text 块（取其 text）与 code 块（取其 code 原文）参与拼接；
   *     code 块不加 language 标注，只取纯代码，保证产出是「纯文本」而非带装饰的富文本
   *     （供列表预览与喂 C2.TitleGenerator 的 recentMessages 纯文本投影）。
   *   - 跳过块：thinking / tool_use / tool_result 三类非文本块一律跳过（不产出任何占位），
   *     因其内容（思维链 / 工具调用参数 / 工具结果）不属于用户可读正文。
   *   - 顺序：严格按 blocks 顺序拼接。
   *   - 分隔：相邻取文块之间以单个 '\n' 连接（被跳过的块不产生额外分隔）。
   *   - 纯函数：同输入必得同输出，无 I/O、无副作用，产出可稳定断言。
   */
  toPlainText(): string;
}

/**
 * 以给定 blocks 包装出一个 MessageContent（附带 toPlainText 投影）。
 *
 * 内部工厂：encodeContent / decodeContent / textContent 均经由此处统一构造，
 * 保证 toPlainText 行为一致。
 */
function makeContent(blocks: ReadonlyArray<ContentBlock>): MessageContent {
  return {
    blocks,
    toPlainText(): string {
      // 逐块投影：仅 text/code 块产出正文（见 MessageContent.toPlainText 文档规则）。
      // 非文本块（thinking/tool_use/tool_result）返回 undefined 被过滤，不产生占位或分隔。
      return blocks
        .map((block): string | undefined => {
          switch (block.type) {
            case 'text':
              return block.text;
            case 'code':
              // 只取纯代码，不加 language 标注，保证产出为纯文本。
              return block.code;
            default:
              // thinking / tool_use / tool_result：跳过。
              return undefined;
          }
        })
        .filter((text): text is string => text !== undefined)
        .join('\n');
    },
  };
}

/**
 * encodeContent：将 MessageContent 序列化为 JSON string（落库用）。
 *
 * 仅序列化 blocks 数组（toPlainText 是投影方法，不入库）。
 */
export function encodeContent(content: MessageContent): string {
  return JSON.stringify(content.blocks);
}

/**
 * 将任意值字符串化后包成单个 text 块（降级用）。
 *
 * 降级是显式行为：把无法识别的原始内容原样字符串化保留为文本，
 * 绝不静默丢弃（对齐 architecture §3.4 第 169 行「脏输入降级为 text」语义）。
 */
function degradeToText(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * 将一个来自 JSON.parse 的原始值归一化为 ContentBlock。
 *
 * 按 type 判别标签逐字段取出并重建，剔除 JSON 携带的多余字段，
 * 可选字段（isError/media/sources/title）仅在存在时保留。
 *
 * 【脏块降级规则（c1-2-3，固定选择）】数组中出现的以下两类脏元素均降级为
 * `{ type:'text', text: JSON.stringify(该元素) }`——即「字符串化保留」而非「静默丢弃」：
 *   1. 非对象元素（标量 / null）；
 *   2. 未知 type（含缺 type）的对象。
 * 选此规则而非丢弃，是为遵守「降级非静默吞」原则：脏内容以文本形态可见地保留下来，
 * 便于事后排查，而不是无声消失。
 */
function normalizeBlock(raw: unknown): ContentBlock {
  if (typeof raw !== 'object' || raw === null) {
    // 数组中的非对象元素（标量 / null）：视为未知块，字符串化降级为 text。
    return degradeToText(JSON.stringify(raw));
  }
  const obj = raw as Record<string, unknown>;
  switch (obj.type) {
    case 'text':
      return { type: 'text', text: obj.text as string };
    case 'thinking':
      return { type: 'thinking', thinking: obj.thinking as string };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: obj.id as string,
        name: obj.name as string,
        input: obj.input,
      };
    case 'tool_result': {
      const block: {
        type: 'tool_result';
        toolUseId: string;
        content: string;
        isError?: boolean;
        media?: ReadonlyArray<MediaRef>;
        sources?: ReadonlyArray<ExternalSourceRef>;
      } = {
        type: 'tool_result',
        toolUseId: obj.toolUseId as string,
        content: obj.content as string,
      };
      if (obj.isError !== undefined) {
        block.isError = obj.isError as boolean;
      }
      // media/sources 是可选数组：畸形（非数组、含非对象元素）时整块降级为 text，
      // 绝不无防御 .map()——否则 media:42 / media:[null] 会抛 TypeError，破坏
      // decodeContent「脏输入永不抛」契约（.map(normalizeBlock) 在 decode 的 try/catch 外）。
      if (obj.media !== undefined) {
        if (!Array.isArray(obj.media) || obj.media.some((m) => typeof m !== 'object' || m === null)) {
          return degradeToText(JSON.stringify(obj));
        }
        block.media = (obj.media as ReadonlyArray<Record<string, unknown>>).map(
          (m) => ({ id: m.id as string }),
        );
      }
      if (obj.sources !== undefined) {
        if (!Array.isArray(obj.sources) || obj.sources.some((s) => typeof s !== 'object' || s === null)) {
          return degradeToText(JSON.stringify(obj));
        }
        block.sources = (
          obj.sources as ReadonlyArray<Record<string, unknown>>
        ).map((s) => {
          const ref: { uri: string; title?: string } = {
            uri: s.uri as string,
          };
          if (s.title !== undefined) {
            ref.title = s.title as string;
          }
          return ref;
        });
      }
      return block;
    }
    case 'code':
      return {
        type: 'code',
        language: obj.language as string,
        code: obj.code as string,
      };
    default:
      // 脏块降级（c1-2-3）：未知 type / 缺 type 的对象 → 字符串化保留为 text，
      // 而非抛出或静默丢弃。绝不抛，保证 decodeContent 对脏输入永不抛。
      return degradeToText(JSON.stringify(obj));
  }
}

/**
 * decodeContent：将 JSON string 反序列化为 MessageContent，脏输入永不抛、显式降级。
 *
 * 对齐 architecture §3.4 第 169 行语义。三条降级路径：
 *   1. JSON.parse 抛异常（非法 JSON，如 'not json {'）→ 整个原始串降级为单 text 块。
 *   2. JSON.parse 结果非数组（对象 / 标量 / null）→ 整个原始串降级为单 text 块。
 *   3. 结果为数组但含脏元素 → 逐块归一化，脏元素按 normalizeBlock 的固定规则
 *      字符串化降级为 text（见其文档），合法块正常重建。
 *
 * 无论何种脏输入，本函数绝不抛异常、也绝不静默吞——降级为原始串（路径 1/2）
 * 或脏元素的字符串化（路径 3），脏内容始终以可见的文本形态保留。
 */
export function decodeContent(raw: string): MessageContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 路径 1：非法 JSON → 原始串作为单 text 块。
    return makeContent([degradeToText(raw)]);
  }
  if (!Array.isArray(parsed)) {
    // 路径 2：合法 JSON 但非数组（对象 / 标量 / null）→ 原始串作为单 text 块。
    return makeContent([degradeToText(raw)]);
  }
  // 路径 3：数组 → 逐块归一化（脏元素在 normalizeBlock 内降级）。
  const blocks = (parsed as ReadonlyArray<unknown>).map(normalizeBlock);
  return makeContent(blocks);
}

/**
 * textContent：以单个 text 块便捷构造 MessageContent。
 */
export function textContent(text: string): MessageContent {
  return makeContent([{ type: 'text', text }]);
}
