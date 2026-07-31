// conversation/domain/message/content-block.ts
// C1 Conversation 领域边界：消息内容块（ContentBlock）判别联合。
//
// 一条持久消息的正文由若干「内容块」有序组成。每个块以 type 字段作判别标签，
// 对应 architecture §3.4 逐字定义的 5 类：text / thinking / tool_use / tool_result / code。
//
// 本文件只定义类型联合与其辅助形状（MediaRef / ExternalSourceRef），
// 不含任何编解码 / 投影实现（encode/decode/toPlainText 见 message-content.ts）。
// 零框架依赖、无 I/O、字段全 readonly。

/**
 * MediaRef：tool_result 中携带的媒体引用（最小往返保真形状）。
 *
 * 来源说明：architecture §3.4 的 ContentBlock 定义里 tool_result.media 标注为
 * `ReadonlyArray<MediaRef>`，但文档未逐字给出 MediaRef 字段。此处按「够 tool_result
 * 编解码往返保真的最小合理形状」定义——仅保留定位一份媒体资产所必需的引用字段，
 * 不臆造尺寸 / MIME / 元数据等额外字段（这些属 C4 Media 边界职责，不在 C1 落地）。
 */
export interface MediaRef {
  /** 媒体资产标识：指向 C4 Media 边界托管的一份资产。 */
  readonly id: string;
}

/**
 * ExternalSourceRef：tool_result 中携带的外部来源引用（最小往返保真形状）。
 *
 * 来源说明：同 MediaRef——§3.4 将 tool_result.sources 标注为
 * `ReadonlyArray<ExternalSourceRef>` 但未逐字给出字段。此处以「够往返保真的最小形状」
 * 定义：一条外部来源以其 URI 唯一定位，title 为可选的人类可读标题；不臆造摘要 /
 * 抓取时间 / 排名等额外字段。
 */
export interface ExternalSourceRef {
  /** 外部来源的定位符（如 URL）。 */
  readonly uri: string;
  /** 可选的人类可读标题。 */
  readonly title?: string;
}

/**
 * TextBlock：纯文本内容块。
 */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * ThinkingBlock：模型思考（reasoning）内容块。
 */
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
}

/**
 * ToolUseBlock：一次工具调用请求。
 *
 * input 为工具入参，形状随工具而异，故类型为 unknown——它是任意合法 JSON 值，
 * 由消费方按具体工具契约收窄，C1 不对其结构做约束。
 */
export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * ToolResultBlock：一次工具调用的结果。
 *
 * - toolUseId 关联对应的 ToolUseBlock.id。
 * - content 为结果正文（文本）。
 * - isError / media / sources 均为可选：分别标记错误结果、携带媒体引用、携带外部来源引用。
 */
export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly media?: ReadonlyArray<MediaRef>;
  readonly sources?: ReadonlyArray<ExternalSourceRef>;
}

/**
 * CodeBlock：代码内容块。
 */
export interface CodeBlock {
  readonly type: 'code';
  readonly language: string;
  readonly code: string;
}

/**
 * ContentBlock：消息内容块判别联合（对齐 architecture §3.4）。
 *
 * 5 类块各以 type 字面量作判别标签，可在消费侧对 type 做 switch/if 收窄。
 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | CodeBlock;
