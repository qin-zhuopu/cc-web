// domain/stream/terminal-reason.test.ts
// TerminalReason 归因码 + 到 SK.ErrorClassifier 的映射约定单测。对齐 §3.5、AC-5。
import { describe, it, expect } from 'vitest';
import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import { ErrorCode } from '../../../domain/error/error-code.js';
import {
  TerminalReasonCode,
  expectedErrorCode,
  isUserAbort,
  isErrorReason,
  type TerminalReason,
} from './terminal-reason.js';

describe('TerminalReasonCode', () => {
  it('恰好含 6 类归因码', () => {
    const codes = Object.values(TerminalReasonCode);
    expect(codes).toHaveLength(6);
    expect(new Set(codes)).toEqual(
      new Set([
        'completed',
        'user_aborted',
        'idle_timeout',
        'tool_timeout',
        'runtime_error',
        'process_died',
      ]),
    );
  });

  it('枚举值即约定字面量', () => {
    expect(TerminalReasonCode.COMPLETED).toBe('completed');
    expect(TerminalReasonCode.USER_ABORTED).toBe('user_aborted');
    expect(TerminalReasonCode.IDLE_TIMEOUT).toBe('idle_timeout');
    expect(TerminalReasonCode.TOOL_TIMEOUT).toBe('tool_timeout');
    expect(TerminalReasonCode.RUNTIME_ERROR).toBe('runtime_error');
    expect(TerminalReasonCode.PROCESS_DIED).toBe('process_died');
  });
});

describe('TerminalReason 值对象', () => {
  it('COMPLETED 可省略 classified', () => {
    const reason: TerminalReason = { code: TerminalReasonCode.COMPLETED };
    expect(reason.classified).toBeUndefined();
  });

  it('可携带 SK 分类结果（不重定义，直接引用 ClassifiedError）', () => {
    const classified: ClassifiedError = {
      code: ErrorCode.ABORTED,
      messageKey: 'sk.error.aborted',
      retryable: false,
    };
    const reason: TerminalReason = {
      code: TerminalReasonCode.USER_ABORTED,
      classified,
    };
    expect(reason.classified?.code).toBe(ErrorCode.ABORTED);
  });
});

describe('expectedErrorCode 映射约定（AC-5）', () => {
  it('user_aborted → ABORTED', () => {
    expect(expectedErrorCode(TerminalReasonCode.USER_ABORTED)).toBe(ErrorCode.ABORTED);
  });

  it('idle_timeout → TIMEOUT', () => {
    expect(expectedErrorCode(TerminalReasonCode.IDLE_TIMEOUT)).toBe(ErrorCode.TIMEOUT);
  });

  it('tool_timeout → PROCESS', () => {
    expect(expectedErrorCode(TerminalReasonCode.TOOL_TIMEOUT)).toBe(ErrorCode.PROCESS);
  });

  it('process_died → PROCESS', () => {
    expect(expectedErrorCode(TerminalReasonCode.PROCESS_DIED)).toBe(ErrorCode.PROCESS);
  });

  it('runtime_error → null（交由 ErrorClassifier 依原始异常分类）', () => {
    expect(expectedErrorCode(TerminalReasonCode.RUNTIME_ERROR)).toBeNull();
  });

  it('completed → null（正常完成，无错误码）', () => {
    expect(expectedErrorCode(TerminalReasonCode.COMPLETED)).toBeNull();
  });

  it('user_aborted / idle_timeout / tool_timeout 三路错误码彼此不同（反例区分）', () => {
    const abort = expectedErrorCode(TerminalReasonCode.USER_ABORTED);
    const idle = expectedErrorCode(TerminalReasonCode.IDLE_TIMEOUT);
    const tool = expectedErrorCode(TerminalReasonCode.TOOL_TIMEOUT);
    expect(new Set([abort, idle, tool]).size).toBe(3);
  });
});

describe('isUserAbort（ABORTED 不显示成"出错了"，AC-5）', () => {
  it('仅 user_aborted 为真', () => {
    expect(isUserAbort(TerminalReasonCode.USER_ABORTED)).toBe(true);
  });

  it('其余归因码均为假', () => {
    for (const code of [
      TerminalReasonCode.COMPLETED,
      TerminalReasonCode.IDLE_TIMEOUT,
      TerminalReasonCode.TOOL_TIMEOUT,
      TerminalReasonCode.RUNTIME_ERROR,
      TerminalReasonCode.PROCESS_DIED,
    ]) {
      expect(isUserAbort(code)).toBe(false);
    }
  });
});

describe('isErrorReason（区分错误终态与非错误终态）', () => {
  it('completed 与 user_aborted 非错误终态', () => {
    expect(isErrorReason(TerminalReasonCode.COMPLETED)).toBe(false);
    expect(isErrorReason(TerminalReasonCode.USER_ABORTED)).toBe(false);
  });

  it('idle_timeout / tool_timeout / runtime_error / process_died 为错误终态', () => {
    expect(isErrorReason(TerminalReasonCode.IDLE_TIMEOUT)).toBe(true);
    expect(isErrorReason(TerminalReasonCode.TOOL_TIMEOUT)).toBe(true);
    expect(isErrorReason(TerminalReasonCode.RUNTIME_ERROR)).toBe(true);
    expect(isErrorReason(TerminalReasonCode.PROCESS_DIED)).toBe(true);
  });
});
