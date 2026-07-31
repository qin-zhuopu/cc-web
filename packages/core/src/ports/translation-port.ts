// ports/translation-port.ts
// SK 共享内核：TranslationPort 端口——文案翻译抽象（对齐 architecture.md §4.4、prd.md FR-4、AC-5）。
// 零框架 import。本文件只定义端口接口与 Locale 类型别名，不含任何文案表与适配器实现。
//
// 职责边界：
//   - SK 只贡献 SK_MESSAGE_KEYS（键的来源），不承载具体 locale 文案表。
//   - 具体 locale 文案表由 apps/api 的 JsonTranslationTable 适配器提供（FR-4.2）。
//
// 语义契约：
//   - translate 支持插值参数（FR-4.1）。
//   - 缺失键：返回键名本身，不抛异常、不返回空串（AC-5 / FR-4.3）。

/** 语言标识，如 'zh' | 'en'。 */
export type Locale = string;

/**
 * 文案翻译端口：按键 + 语言解析文案。
 * 生产实现由 apps/api 的 JsonTranslationTable 适配器提供（FR-4.2）。
 */
export interface TranslationPort {
  /**
   * 按键 + 语言返回文案；支持插值参数（FR-4.1）。
   * 缺失键：返回 key 本身，不抛异常、不返回空串（AC-5 / FR-4.3）。
   */
  translate(key: string, locale: Locale, params?: Readonly<Record<string, string | number>>): string;
  /** 缺失键判定，供上层探测能力。 */
  has(key: string, locale: Locale): boolean;
}
