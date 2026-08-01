// agent-runtime/domain/message-keys.test.ts
// C2_MESSAGE_KEYS 常量表守卫：运行时只读、命名空间、键值唯一性。
import { describe, it, expect } from 'vitest';
import { C2_MESSAGE_KEYS } from './message-keys.js';

describe('C2_MESSAGE_KEYS', () => {
  it('运行时只读：对象被 Object.freeze 冻结', () => {
    expect(Object.isFrozen(C2_MESSAGE_KEYS)).toBe(true);
  });

  it('运行时只读：改写已有键抛 TypeError（ESM strict）', () => {
    expect(() => {
      // @ts-expect-error 故意违规写入以验证运行时冻结
      C2_MESSAGE_KEYS.streamCompleted = 'tampered';
    }).toThrow(TypeError);
  });

  it('运行时只读：新增键抛 TypeError（ESM strict）', () => {
    expect(() => {
      // @ts-expect-error 故意新增键以验证运行时冻结
      C2_MESSAGE_KEYS.injected = 'x';
    }).toThrow(TypeError);
  });

  it('所有键值均以 c2. 前缀开头（命名空间不越界）', () => {
    for (const value of Object.values(C2_MESSAGE_KEYS)) {
      expect(value.startsWith('c2.')).toBe(true);
    }
  });

  it('不重定义 SK 错误文案：不含任何 sk.error.* 键值', () => {
    for (const value of Object.values(C2_MESSAGE_KEYS)) {
      expect(value.startsWith('sk.error.')).toBe(false);
    }
  });

  it('键值无重复', () => {
    const values = Object.values(C2_MESSAGE_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('键值非空且为字符串', () => {
    for (const value of Object.values(C2_MESSAGE_KEYS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
