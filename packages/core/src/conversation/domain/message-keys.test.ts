// conversation/domain/message-keys.test.ts
// 校验 C1_MESSAGE_KEYS：只读、c1. 命名空间、无重复值、含默认标题键。
import { describe, it, expect } from 'vitest';
import { C1_MESSAGE_KEYS } from './message-keys.js';

describe('C1_MESSAGE_KEYS', () => {
  it('所有键值均以 c1. 命名空间开头', () => {
    for (const value of Object.values(C1_MESSAGE_KEYS)) {
      expect(value.startsWith('c1.')).toBe(true);
    }
  });

  it('键值无重复', () => {
    const values = Object.values(C1_MESSAGE_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('含会话默认标题键（NFR-5）', () => {
    expect(C1_MESSAGE_KEYS.sessionDefaultTitle).toBe('c1.session.defaultTitle');
  });

  it('含标题来源 badge 三个来源键', () => {
    expect(C1_MESSAGE_KEYS.titleOriginDefault).toBe('c1.title.origin.default');
    expect(C1_MESSAGE_KEYS.titleOriginAi).toBe('c1.title.origin.ai');
    expect(C1_MESSAGE_KEYS.titleOriginUser).toBe('c1.title.origin.user');
  });

  it('运行时只读——写入被冻结/拒绝', () => {
    expect(() => {
      // @ts-expect-error 测试运行时不可变性：as const 下赋值应被 TS 拦截且运行时无效
      C1_MESSAGE_KEYS.sessionDefaultTitle = 'tampered';
    }).toThrow();
    expect(C1_MESSAGE_KEYS.sessionDefaultTitle).toBe('c1.session.defaultTitle');
  });
});
