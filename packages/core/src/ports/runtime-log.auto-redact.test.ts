// ports/runtime-log.auto-redact.test.ts
// SK 共享内核：RuntimeLog 写入自动脱敏语义契约测试（对齐 architecture.md §4.5、prd.md FR-5.3/NFR-4、AC-7）。
// 用内联测试替身验证「凡走 append 写入必经 Redactor、快照中不出现未脱敏原值」的反例断言（AC-7）。
// 测试替身仅存于本文件，不属生产代码。

import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.js';
import type { Redactor } from './redactor.js';
import type { RuntimeLog } from './runtime-log.js';
import type { LogEntry } from '../domain/log/log-entry.js';

// 脱敏占位符，与 architecture.md §4.3 / FR-3.3 约定一致。
const PLACEHOLDER = '***REDACTED***';

/**
 * 内联测试替身：把 'sk-' 前缀密钥与邮箱替换为占位符。
 * 纯函数、无副作用，返回脱敏后新副本，不修改原输入（AC-4/FR-3.1）。
 */
function createFakeRedactor(): Redactor {
  const scrub = (input: string): string =>
    input
      // sk- 前缀密钥
      .replace(/sk-[A-Za-z0-9]+/g, PLACEHOLDER)
      // 邮箱地址
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, PLACEHOLDER);

  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactValue(v);
      }
      return out;
    }
    return value;
  };

  return {
    redactString: (input: string): string => scrub(input),
    redact: <T>(input: T): T => redactValue(input) as T,
  };
}

/** 假 clock：返回注入的固定时刻（读取的是替身而非系统时钟）。 */
function createFakeClock(fixed: number): Clock {
  return { now: (): number => fixed };
}

/**
 * 内联测试替身：唯一写入路径 append 强制经 Redactor 后再入缓冲。
 * 端口不暴露任何绕过 Redactor 的旁路写入方法（NFR-4/FR-5.3）。
 */
class RedactingRingBuffer implements RuntimeLog {
  readonly capacity: number;
  readonly #clock: Clock;
  readonly #redactor: Redactor;
  #buffer: LogEntry[] = [];

  constructor(capacity: number, clock: Clock, redactor: Redactor) {
    this.capacity = capacity;
    this.#clock = clock;
    this.#redactor = redactor;
  }

  append(entry: Omit<LogEntry, 'timestamp'>): void {
    // 唯一写入路径：message 与 meta 先经 Redactor 脱敏，timestamp 经 clock 注入。
    const redacted: LogEntry = {
      timestamp: this.#clock.now(),
      level: entry.level,
      source: entry.source,
      message: this.#redactor.redactString(entry.message),
      meta: entry.meta === undefined ? undefined : this.#redactor.redact(entry.meta),
    };
    this.#buffer.push(redacted);
    if (this.#buffer.length > this.capacity) {
      this.#buffer.shift();
    }
  }

  snapshot(): ReadonlyArray<LogEntry> {
    return [...this.#buffer];
  }

  clear(): void {
    this.#buffer = [];
  }
}

describe('RuntimeLog 写入自动脱敏语义契约（AC-7 / NFR-4 / FR-5.3）', () => {
  it('append 写入含敏感值的日志后，快照中原始敏感值被 ***REDACTED*** 取代（AC-7）', () => {
    const log = new RedactingRingBuffer(8, createFakeClock(1_700_000_000_000), createFakeRedactor());

    log.append({
      level: 'error',
      source: 'c2.stream',
      message: '调用失败，密钥 sk-SECRET123 无效',
      meta: { token: 'sk-TOKEN456', contact: 'alice@example.com', retries: 3 },
    });

    const snapshot = log.snapshot();
    expect(snapshot).toHaveLength(1);
    const entry = snapshot[0]!;

    // message 中的敏感原值不再出现，被占位符取代。
    expect(entry.message).not.toContain('sk-SECRET123');
    expect(entry.message).toContain(PLACEHOLDER);

    // meta 中的敏感原值不再出现，被占位符取代；非敏感字段保留。
    const meta = entry.meta as Record<string, unknown>;
    expect(meta.token).toBe(PLACEHOLDER);
    expect(meta.contact).toBe(PLACEHOLDER);
    expect(meta.retries).toBe(3);
  });

  it('无论写入多少条，凡走 append 的条目一律脱敏——端口无绕过 Redactor 的旁路（NFR-4/FR-5.3）', () => {
    const log = new RedactingRingBuffer(8, createFakeClock(1_700_000_000_000), createFakeRedactor());

    const sensitivePayloads = [
      { message: 'key=sk-AAA111', meta: { auth: 'sk-BBB222' } },
      { message: '用户 bob@corp.io 登录', meta: { email: 'carol@corp.io' } },
      { message: 'no-secret-here', meta: { plain: 'value' } },
    ];

    for (const payload of sensitivePayloads) {
      log.append({ level: 'info', source: 'c7.doctor', message: payload.message, meta: payload.meta });
    }

    // 整份快照序列化后，绝不出现任一未脱敏的敏感原值。
    const serialized = JSON.stringify(log.snapshot());
    for (const raw of ['sk-AAA111', 'sk-BBB222', 'bob@corp.io', 'carol@corp.io']) {
      expect(serialized).not.toContain(raw);
    }

    // append 是唯一写入路径：RuntimeLog 端口除 append 外无其他写入方法（clear 仅清空、snapshot 仅读取）。
    const writeLikeMethods = Object.getOwnPropertyNames(RedactingRingBuffer.prototype).filter(
      (name) => name !== 'constructor' && name !== 'append' && name !== 'snapshot' && name !== 'clear',
    );
    expect(writeLikeMethods).toEqual([]);
  });

  it('Redactor 为纯函数：脱敏不修改调用方传入的原对象（AC-4/FR-3.1）', () => {
    const log = new RedactingRingBuffer(8, createFakeClock(1_700_000_000_000), createFakeRedactor());
    const originalMeta = { token: 'sk-KEEP789' };

    log.append({ level: 'warn', source: 'c2.stream', message: 'sk-KEEP789', meta: originalMeta });

    // 传入的原对象不被就地改写。
    expect(originalMeta.token).toBe('sk-KEEP789');
  });
});
