import { describe, it, expect } from 'vitest';
import { ErrorCode } from './error-code.js';

// architecture.md §3.1 的 16 类错误码期望清单（名称 -> 值，逐字一致）。
const EXPECTED_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['NETWORK', 'NETWORK'],
  ['TIMEOUT', 'TIMEOUT'],
  ['RATE_LIMIT', 'RATE_LIMIT'],
  ['AUTH', 'AUTH'],
  ['PERMISSION', 'PERMISSION'],
  ['INVALID_REQUEST', 'INVALID_REQUEST'],
  ['NOT_FOUND', 'NOT_FOUND'],
  ['CONFLICT', 'CONFLICT'],
  ['SERVER', 'SERVER'],
  ['UNAVAILABLE', 'UNAVAILABLE'],
  ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
  ['RESOURCE_LIMIT', 'RESOURCE_LIMIT'],
  ['FILESYSTEM', 'FILESYSTEM'],
  ['PROCESS', 'PROCESS'],
  ['ABORTED', 'ABORTED'],
  ['UNKNOWN', 'UNKNOWN'],
];

describe('ErrorCode 枚举', () => {
  it('恰好含 16 个键', () => {
    expect(Object.keys(ErrorCode)).toHaveLength(16);
  });

  it('键集合与 §3.1 逐字一致（不增删改名）', () => {
    expect(Object.keys(ErrorCode).sort()).toEqual(
      EXPECTED_ENTRIES.map(([name]) => name).sort(),
    );
  });

  it('每个值等于其名称字符串', () => {
    for (const [name, value] of EXPECTED_ENTRIES) {
      expect(ErrorCode[name as keyof typeof ErrorCode]).toBe(value);
    }
  });

  it('无多余成员', () => {
    const expectedNames = new Set(EXPECTED_ENTRIES.map(([name]) => name));
    for (const key of Object.keys(ErrorCode)) {
      expect(expectedNames.has(key)).toBe(true);
    }
  });
});
