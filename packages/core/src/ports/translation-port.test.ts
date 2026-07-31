// ports/translation-port.test.ts
// 端口只定义接口无实现，故用内联测试替身验证 TranslationPort 的语义契约：
//   - 缺失键返回键名本身、不抛异常、不返回空串（AC-5 / FR-4.3）。
//   - 存在键返回文案，带 params 时插值生效（FR-4.1）。
//   - has 对存在/不存在返回 true/false。
// 该替身仅存在于测试文件内，不进 src 生产代码。
import { describe, it, expect } from 'vitest';
import type { Locale, TranslationPort } from './translation-port.js';

/**
 * 最小翻译替身：内部一张 locale -> (key -> 模板) 的小文案表，
 * 模板用 {name} 占位，translate 时按 params 做简单插值。
 */
class FakeTranslation implements TranslationPort {
  private readonly tables: Readonly<Record<Locale, Readonly<Record<string, string>>>>;

  constructor(tables: Readonly<Record<Locale, Readonly<Record<string, string>>>>) {
    this.tables = tables;
  }

  translate(key: string, locale: Locale, params?: Readonly<Record<string, string | number>>): string {
    const template = this.tables[locale]?.[key];
    // 缺失键：返回键名本身，不抛、不返回空串（AC-5 / FR-4.3）。
    if (template === undefined) {
      return key;
    }
    if (params === undefined) {
      return template;
    }
    // 简单插值：将 {paramKey} 替换为对应值。
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name];
      return value === undefined ? match : String(value);
    });
  }

  has(key: string, locale: Locale): boolean {
    return this.tables[locale]?.[key] !== undefined;
  }
}

const makeTranslation = (): TranslationPort =>
  new FakeTranslation({
    zh: {
      'greeting.hello': '你好',
      'greeting.welcome': '欢迎，{name}！',
      'count.items': '共 {count} 项',
    },
    en: {
      'greeting.hello': 'Hello',
    },
  });

describe('TranslationPort 端口语义契约 — 缺失键', () => {
  it('AC-5：translate 不存在的 key → 返回该 key 本身（不抛、非空串）', () => {
    const t = makeTranslation();
    const missingKey = 'nonexistent.key';
    let result: string;
    expect(() => {
      result = t.translate(missingKey, 'zh');
    }).not.toThrow();
    expect(result!).toBe(missingKey);
    expect(result!).not.toBe('');
  });

  it('AC-5：has 不存在的 key → false', () => {
    const t = makeTranslation();
    expect(t.has('nonexistent.key', 'zh')).toBe(false);
  });

  it('已知 locale 下缺失键、以及未知 locale 均返回键名本身', () => {
    const t = makeTranslation();
    // en 表中不存在的键
    expect(t.translate('greeting.welcome', 'en')).toBe('greeting.welcome');
    // 未知 locale
    expect(t.translate('greeting.hello', 'fr')).toBe('greeting.hello');
  });
});

describe('TranslationPort 端口语义契约 — 存在键与插值', () => {
  it('存在的 key → 返回文案', () => {
    const t = makeTranslation();
    expect(t.translate('greeting.hello', 'zh')).toBe('你好');
    expect(t.translate('greeting.hello', 'en')).toBe('Hello');
  });

  it('FR-4.1：带 params 时插值生效（字符串与数字）', () => {
    const t = makeTranslation();
    expect(t.translate('greeting.welcome', 'zh', { name: '小明' })).toBe('欢迎，小明！');
    expect(t.translate('count.items', 'zh', { count: 3 })).toBe('共 3 项');
  });

  it('存在插值占位但未提供对应 param 时保留原占位', () => {
    const t = makeTranslation();
    expect(t.translate('greeting.welcome', 'zh', {})).toBe('欢迎，{name}！');
  });
});

describe('TranslationPort 端口语义契约 — has', () => {
  it('has 对存在/不存在返回 true/false', () => {
    const t = makeTranslation();
    expect(t.has('greeting.hello', 'zh')).toBe(true);
    expect(t.has('greeting.hello', 'en')).toBe(true);
    expect(t.has('greeting.welcome', 'en')).toBe(false);
    expect(t.has('nope', 'zh')).toBe(false);
  });
});
