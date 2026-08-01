// domain/error/message-keys.test.ts
// 断言 SK_MESSAGE_KEYS：全覆盖 16 类、键值无重复、形如 sk.error.*、键集合恰好等于 ErrorCode 值集合（无多余）。
import { describe, it, expect } from 'vitest';
import { ErrorCode } from './error-code.js';
import { SK_MESSAGE_KEYS } from './message-keys.js';

// architecture.md §3.3 权威键映射（逐字），用于命名对齐比对。
const EXPECTED: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.NETWORK]: 'sk.error.network',
  [ErrorCode.TIMEOUT]: 'sk.error.timeout',
  [ErrorCode.RATE_LIMIT]: 'sk.error.rateLimit',
  [ErrorCode.AUTH]: 'sk.error.auth',
  [ErrorCode.PERMISSION]: 'sk.error.permission',
  [ErrorCode.INVALID_REQUEST]: 'sk.error.invalidRequest',
  [ErrorCode.NOT_FOUND]: 'sk.error.notFound',
  [ErrorCode.CONFLICT]: 'sk.error.conflict',
  [ErrorCode.SERVER]: 'sk.error.server',
  [ErrorCode.UNAVAILABLE]: 'sk.error.unavailable',
  [ErrorCode.QUOTA_EXCEEDED]: 'sk.error.quotaExceeded',
  [ErrorCode.RESOURCE_LIMIT]: 'sk.error.resourceLimit',
  [ErrorCode.FILESYSTEM]: 'sk.error.filesystem',
  [ErrorCode.PROCESS]: 'sk.error.process',
  [ErrorCode.ABORTED]: 'sk.error.aborted',
  [ErrorCode.UNKNOWN]: 'sk.error.unknown',
};

describe('SK_MESSAGE_KEYS 常量表', () => {
  it('全覆盖：每个 ErrorCode 都有对应键', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(SK_MESSAGE_KEYS[code]).toBeDefined();
    }
  });

  it('无多余键：键集合恰好等于 ErrorCode 值集合', () => {
    expect(Object.keys(SK_MESSAGE_KEYS).sort()).toEqual(
      Object.values(ErrorCode).sort(),
    );
  });

  it('命名对齐：每个键值与 §3.3 逐字一致', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(SK_MESSAGE_KEYS[code]).toBe(EXPECTED[code]);
    }
  });

  it('命名形如 sk.error.*', () => {
    for (const value of Object.values(SK_MESSAGE_KEYS)) {
      expect(value).toMatch(/^sk\.error\.[a-zA-Z]+$/);
    }
  });

  it('唯一性：16 个键值互不重复', () => {
    const values = Object.values(SK_MESSAGE_KEYS);
    expect(values).toHaveLength(16);
    expect(new Set(values).size).toBe(values.length);
  });
});
