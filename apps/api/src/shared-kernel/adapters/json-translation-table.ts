// apps/api/src/shared-kernel/adapters/json-translation-table.ts
// TranslationPort 端口的最小占位适配器（供 DI 图装配，后续 epic 载入真实文案表）。
//
// 本轮为空表：任何键都视为缺失——translate 返回 key 本身、不抛异常、不返回空串
// （AC-5/FR-4.3）；has 恒返回 false。后续 story 载入 zh/en 文案表后替换。
//
// implements TranslationPort：拿到编译期契约校验，签名漂移时 tsc 立即报错
// （与其余 6 个适配器一致）。核心包已导出 TranslationPort/Locale（index.ts）。
import type { Locale, TranslationPort } from '@codepilot/core';

/** 生产 TranslationPort 的最小占位实现：空表，缺失键回退键名。 */
export class JsonTranslationTable implements TranslationPort {
  translate(
    key: string,
    _locale: Locale,
    _params?: Readonly<Record<string, string | number>>,
  ): string {
    // 空表：一律缺失，回退键名本身（不抛异常、不返回空串）。
    return key;
  }

  has(_key: string, _locale: Locale): boolean {
    return false;
  }
}
