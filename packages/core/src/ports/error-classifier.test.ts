// ports/error-classifier.test.ts
// 表驱动测试：16 类代表样本逐一命中、retryable 正负例、UNKNOWN 兜底、确定性、cause 保留。
import { describe, it, expect } from 'vitest';
import { defaultErrorClassifier } from './error-classifier.js';
import { ErrorCode } from '../domain/error/error-code.js';

/** 构造带任意属性的 Error 实例（模拟 Node/HTTP 客户端异常形态）。 */
function makeError(message: string, props: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  return Object.assign(err, props);
}

/** 16 类代表样本表：每类至少一例，声明期望 code / messageKey / retryable。 */
const SAMPLES: ReadonlyArray<{
  name: string;
  input: unknown;
  code: ErrorCode;
  messageKey: string;
  retryable: boolean;
}> = [
  {
    name: 'ECONNREFUSED → NETWORK',
    input: makeError('connect ECONNREFUSED 127.0.0.1:443', { code: 'ECONNREFUSED' }),
    code: ErrorCode.NETWORK,
    messageKey: 'sk.error.network',
    retryable: true,
  },
  {
    name: 'ETIMEDOUT → TIMEOUT',
    input: makeError('request failed', { code: 'ETIMEDOUT' }),
    code: ErrorCode.TIMEOUT,
    messageKey: 'sk.error.timeout',
    retryable: true,
  },
  {
    name: 'AbortError (name) → ABORTED',
    input: makeError('The operation was aborted', { name: 'AbortError' }),
    code: ErrorCode.ABORTED,
    messageKey: 'sk.error.aborted',
    retryable: false,
  },
  {
    name: 'status 429 → RATE_LIMIT',
    input: makeError('rate limited', { status: 429 }),
    code: ErrorCode.RATE_LIMIT,
    messageKey: 'sk.error.rateLimit',
    retryable: true,
  },
  {
    name: 'status 401 → AUTH',
    input: makeError('unauthorized', { status: 401 }),
    code: ErrorCode.AUTH,
    messageKey: 'sk.error.auth',
    retryable: false,
  },
  {
    name: 'status 403 → PERMISSION',
    input: makeError('forbidden', { statusCode: 403 }),
    code: ErrorCode.PERMISSION,
    messageKey: 'sk.error.permission',
    retryable: false,
  },
  {
    name: 'status 400 → INVALID_REQUEST',
    input: makeError('bad request', { status: 400 }),
    code: ErrorCode.INVALID_REQUEST,
    messageKey: 'sk.error.invalidRequest',
    retryable: false,
  },
  {
    name: 'status 404 → NOT_FOUND',
    input: makeError('not found', { response: { status: 404 } }),
    code: ErrorCode.NOT_FOUND,
    messageKey: 'sk.error.notFound',
    retryable: false,
  },
  {
    name: 'status 409 → CONFLICT',
    input: makeError('conflict', { status: 409 }),
    code: ErrorCode.CONFLICT,
    messageKey: 'sk.error.conflict',
    retryable: false,
  },
  {
    name: 'status 500 → SERVER',
    input: makeError('internal server error', { status: 500 }),
    code: ErrorCode.SERVER,
    messageKey: 'sk.error.server',
    retryable: false,
  },
  {
    name: 'status 503 → UNAVAILABLE',
    input: makeError('service unavailable', { status: 503 }),
    code: ErrorCode.UNAVAILABLE,
    messageKey: 'sk.error.unavailable',
    retryable: true,
  },
  {
    name: 'quota keyword → QUOTA_EXCEEDED',
    input: makeError('You exceeded your current quota, please check your billing'),
    code: ErrorCode.QUOTA_EXCEEDED,
    messageKey: 'sk.error.quotaExceeded',
    retryable: false,
  },
  {
    name: 'context length keyword → RESOURCE_LIMIT',
    input: makeError("This model's maximum context length is 8192 tokens"),
    code: ErrorCode.RESOURCE_LIMIT,
    messageKey: 'sk.error.resourceLimit',
    retryable: false,
  },
  {
    name: 'ENOENT → FILESYSTEM',
    input: makeError('ENOENT: no such file or directory', { code: 'ENOENT' }),
    code: ErrorCode.FILESYSTEM,
    messageKey: 'sk.error.filesystem',
    retryable: false,
  },
  {
    // 修复#4：spawn ENOENT 应归 PROCESS 而非 FILESYSTEM（子进程语境优先）。
    name: 'spawn ENOENT → PROCESS',
    input: makeError('spawn git ENOENT', { code: 'ENOENT' }),
    code: ErrorCode.PROCESS,
    messageKey: 'sk.error.process',
    retryable: false,
  },
  {
    name: 'unrecognized → UNKNOWN',
    input: makeError('something entirely unexpected happened'),
    code: ErrorCode.UNKNOWN,
    messageKey: 'sk.error.unknown',
    retryable: false,
  },
  // —— 对抗评审修复样本 ——
  {
    // 修复#1：504 Gateway Timeout 本质超时，可重试。
    name: 'status 504 → TIMEOUT',
    input: makeError('gateway timeout', { status: 504 }),
    code: ErrorCode.TIMEOUT,
    messageKey: 'sk.error.timeout',
    retryable: true,
  },
  {
    // 修复#2：502 Bad Gateway 上游临时故障，可重试。
    name: 'status 502 → UNAVAILABLE',
    input: makeError('bad gateway', { status: 502 }),
    code: ErrorCode.UNAVAILABLE,
    messageKey: 'sk.error.unavailable',
    retryable: true,
  },
  {
    // 修复#3：408 Request Timeout 明确可重试超时。
    name: 'status 408 → TIMEOUT',
    input: makeError('request timeout', { status: 408 }),
    code: ErrorCode.TIMEOUT,
    messageKey: 'sk.error.timeout',
    retryable: true,
  },
  {
    // 修复#6：EPIPE（socket/管道破裂）常见且通常可重试，归 NETWORK。
    name: 'EPIPE → NETWORK',
    input: makeError('write EPIPE', { code: 'EPIPE' }),
    code: ErrorCode.NETWORK,
    messageKey: 'sk.error.network',
    retryable: true,
  },
  {
    // 轻量安全改进：AbortController 超时以 AbortError 抛出但含超时语义，归 TIMEOUT。
    name: 'AbortError with timeout message → TIMEOUT',
    input: makeError('The operation timed out', { name: 'AbortError' }),
    code: ErrorCode.TIMEOUT,
    messageKey: 'sk.error.timeout',
    retryable: true,
  },
];

describe('defaultErrorClassifier.classify — 16 类代表样本', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}`, () => {
      const result = defaultErrorClassifier.classify(sample.input);
      expect(result.code).toBe(sample.code);
      expect(result.messageKey).toBe(sample.messageKey);
      expect(result.retryable).toBe(sample.retryable);
    });
  }

  it('样本表覆盖全部 16 类 ErrorCode', () => {
    const covered = new Set(SAMPLES.map((s) => s.code));
    const all = Object.values(ErrorCode);
    expect(covered.size).toBe(all.length);
    for (const code of all) {
      expect(covered.has(code)).toBe(true);
    }
  });
});

describe('defaultErrorClassifier.classify — retryable 规则', () => {
  const retryableCodes = new Set([
    ErrorCode.NETWORK,
    ErrorCode.TIMEOUT,
    ErrorCode.RATE_LIMIT,
    ErrorCode.UNAVAILABLE,
  ]);

  for (const sample of SAMPLES) {
    it(`${sample.code} 的 retryable 与规则一致`, () => {
      const result = defaultErrorClassifier.classify(sample.input);
      expect(result.retryable).toBe(retryableCodes.has(sample.code));
    });
  }
});

describe('defaultErrorClassifier.classify — UNKNOWN 兜底（非 Error 输入）', () => {
  const cases: ReadonlyArray<{ name: string; input: unknown }> = [
    { name: 'null', input: null },
    { name: 'undefined', input: undefined },
    { name: 'number 42', input: 42 },
    { name: 'empty object', input: {} },
    { name: 'Symbol', input: Symbol('x') },
    { name: 'plain string', input: 'just some text' },
    { name: 'boolean', input: true },
    { name: 'array', input: [1, 2, 3] },
  ];

  for (const c of cases) {
    it(`${c.name} → UNKNOWN 且不抛`, () => {
      expect(() => defaultErrorClassifier.classify(c.input)).not.toThrow();
      const result = defaultErrorClassifier.classify(c.input);
      expect(result.code).toBe(ErrorCode.UNKNOWN);
      expect(result.messageKey).toBe('sk.error.unknown');
      expect(result.retryable).toBe(false);
    });
  }
});

describe('defaultErrorClassifier.classify — 确定性', () => {
  it('同一异常连续分类 100 次三字段完全一致', () => {
    const err = makeError('connect ECONNREFUSED', { code: 'ECONNREFUSED' });
    const first = defaultErrorClassifier.classify(err);
    for (let i = 0; i < 100; i++) {
      const next = defaultErrorClassifier.classify(err);
      expect(next.code).toBe(first.code);
      expect(next.messageKey).toBe(first.messageKey);
      expect(next.retryable).toBe(first.retryable);
    }
  });
});

describe('defaultErrorClassifier.classify — cause 保留原始引用', () => {
  it('结果 cause 严格等于原始 Error 输入', () => {
    const err = makeError('boom', { status: 500 });
    const result = defaultErrorClassifier.classify(err);
    expect(result.cause).toBe(err);
  });

  it('非 Error 输入的 cause 也严格保留', () => {
    const input = { weird: true };
    const result = defaultErrorClassifier.classify(input);
    expect(result.cause).toBe(input);
  });

  it('null 输入的 cause 为 null', () => {
    const result = defaultErrorClassifier.classify(null);
    expect(result.cause).toBe(null);
  });
});
