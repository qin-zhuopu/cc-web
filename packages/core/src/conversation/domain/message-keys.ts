// conversation/domain/message-keys.ts
// C1 会话领域边界：C1 自身产生的 i18n 消息键常量表。零框架 import，仅常量。
// C1 只贡献键、不含具体文案（locale 文案表由 apps/api 适配器层提供）。
//
// 只读性（仿 SK message-keys.ts 范式，见 architecture、spec-sk-1-3）：
//   - as const 给出字面量类型 + 只读，防止运行时篡改与键值漂移。
//   - satisfies Readonly<Record<string, string>> 约束值恒为字符串键。
//
// 命名空间：全部键以 c1. 开头，与 SK 的 sk.* 命名空间互不重叠。
// NFR-5：默认标题 'New Chat' 经 key（c1.session.defaultTitle）而非硬编码，便于 i18n。

/**
 * C1 产生的 i18n 消息键常量：会话默认标题与标题来源 badge 文案。
 * 全项目键真相源——C1 领域模型与 i18n 适配器均引用本表。
 */
// Object.freeze：as const 仅给编译期只读，运行时对象仍可写；此处冻结以真正
// 兑现「防止运行时篡改」——ESM strict 模式下对冻结属性赋值会抛 TypeError。
export const C1_MESSAGE_KEYS = Object.freeze({
  /** 会话默认标题（NFR-5：'New Chat' 经此 key 解析，禁硬编码） */
  sessionDefaultTitle: 'c1.session.defaultTitle',
  /** 标题来源 badge：系统默认标题 */
  titleOriginDefault: 'c1.title.origin.default',
  /** 标题来源 badge：AI 生成标题 */
  titleOriginAi: 'c1.title.origin.ai',
  /** 标题来源 badge：用户手动设置标题 */
  titleOriginUser: 'c1.title.origin.user',
} as const satisfies Readonly<Record<string, string>>);
