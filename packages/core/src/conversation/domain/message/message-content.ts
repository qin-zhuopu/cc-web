// conversation/domain/message/message-content.ts
// C1 Conversation 领域边界：消息内容值对象（占位）。
// 对齐 architecture §3.4。
//
// 【占位说明】
// 本故事（c1-1-2）不实现富类型内容块与 encode/decode 编解码，
// 那属于 epic-c1-2 的职责。此处仅给出最小占位类型，供 Message.content 引用，
// 避免 Message 实体因缺失内容类型而无法定型。编解码落地时在此扩展为
// { blocks: ReadonlyArray<ContentBlock>; toPlainText(): string } 等富类型。

/**
 * 消息内容占位类型。
 *
 * 编解码（ContentBlock 联合、encode/decode、toPlainText 投影）属 c1-2，
 * 本故事暂以 unknown 占位，不约束具体形状。
 */
export type MessageContent = unknown;
