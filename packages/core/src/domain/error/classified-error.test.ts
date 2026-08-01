import { describe, it, expect } from 'vitest';
import { ErrorCode } from './error-code.js';
import type { ClassifiedError } from './classified-error.js';

describe('ClassifiedError 值对象契约', () => {
  it('接受仅含必填字段的字面量', () => {
    const err: ClassifiedError = {
      code: ErrorCode.NETWORK,
      messageKey: 'sk.error.network',
      retryable: true,
    };
    expect(err.code).toBe(ErrorCode.NETWORK);
    expect(err.messageKey).toBe('sk.error.network');
    expect(err.retryable).toBe(true);
    expect(err.cause).toBeUndefined();
    expect(err.detail).toBeUndefined();
  });

  it('接受可选 cause / detail 字段', () => {
    const cause = new Error('boom');
    const err: ClassifiedError = {
      code: ErrorCode.UNKNOWN,
      messageKey: 'sk.error.unknown',
      retryable: false,
      cause,
      detail: 'redacted detail',
    };
    expect(err.cause).toBe(cause);
    expect(err.detail).toBe('redacted detail');
  });

  it('运行时对象结构与类型契约一致（字段名逐字）', () => {
    const err: ClassifiedError = {
      code: ErrorCode.TIMEOUT,
      messageKey: 'sk.error.timeout',
      retryable: true,
    };
    expect(Object.keys(err).sort()).toEqual(['code', 'messageKey', 'retryable']);
  });
});
