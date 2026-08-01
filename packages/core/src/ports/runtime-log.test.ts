// ports/runtime-log.test.ts
// RuntimeLog 端口契约测试：用测试文件内联的最小实现替身验证语义契约（AC-6/FR-5.1）。
// 零框架 import；类型 import 用 import type + .js。

import { describe, expect, it } from 'vitest';
import type { LogEntry, LogLevel } from '../domain/log/log-entry.js';
import type { RuntimeLog } from './runtime-log.js';

/**
 * 递增假时钟：每次读取 now() 返回自增计数值，模拟 Clock 端口，产生严格递增的 timestamp。
 * 仅用于本测试文件。
 */
class CountingClock {
  private counter = 0;
  now(): number {
    return ++this.counter;
  }
}

/**
 * 最小内联环形缓冲实现：以数组做 FIFO 覆盖，容量注入，timestamp 由注入的假时钟产生。
 * 不含脱敏（脱敏语义属适配器层，此替身仅验证环形缓冲与 timestamp 注入契约）。仅用于本测试文件。
 */
class InMemoryRingBuffer implements RuntimeLog {
  readonly capacity: number;
  private readonly clock: CountingClock;
  private buffer: LogEntry[] = [];

  constructor(capacity: number, clock: CountingClock) {
    this.capacity = capacity;
    this.clock = clock;
  }

  append(entry: Omit<LogEntry, 'timestamp'>): void {
    const full: LogEntry = { ...entry, timestamp: this.clock.now() };
    this.buffer.push(full);
    if (this.buffer.length > this.capacity) {
      // FIFO 覆盖最旧条目
      this.buffer.shift();
    }
  }

  snapshot(): ReadonlyArray<LogEntry> {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

describe('RuntimeLog 端口契约', () => {
  it('AC-6：capacity=N 写 N+K 条，snapshot 仅保留最新 N 条并按时间升序', () => {
    const capacity = 3;
    const log = new InMemoryRingBuffer(capacity, new CountingClock());
    const total = 5; // N=3, K=2
    const level: LogLevel = 'info';

    for (let i = 1; i <= total; i += 1) {
      log.append({ level, source: 'c2.stream', message: `msg-${i}` });
    }

    const snap = log.snapshot();

    // 仅保留最新 N 条
    expect(snap).toHaveLength(capacity);
    // FIFO 覆盖：最旧的 msg-1、msg-2 被覆盖，保留 msg-3/4/5
    expect(snap.map((e) => e.message)).toEqual(['msg-3', 'msg-4', 'msg-5']);

    // 时间升序（最旧在前、最新在后）
    for (let i = 1; i < snap.length; i += 1) {
      expect(snap[i]!.timestamp).toBeGreaterThan(snap[i - 1]!.timestamp);
    }
  });

  it('append 接受 Omit<LogEntry,"timestamp">，snapshot 返回带 timestamp 的完整 LogEntry', () => {
    const log = new InMemoryRingBuffer(4, new CountingClock());

    log.append({
      level: 'warn',
      source: 'c7.doctor',
      message: 'something',
      meta: { code: 42 },
    });

    const [entry] = log.snapshot();
    expect(entry).toBeDefined();
    // timestamp 由实现经（假）Clock 注入，调用方无需提供
    expect(typeof entry!.timestamp).toBe('number');
    expect(entry!.timestamp).toBeGreaterThan(0);
    expect(entry!.level).toBe('warn');
    expect(entry!.source).toBe('c7.doctor');
    expect(entry!.message).toBe('something');
    expect(entry!.meta).toEqual({ code: 42 });
  });

  it('clear 清空缓冲', () => {
    const log = new InMemoryRingBuffer(2, new CountingClock());
    log.append({ level: 'debug', source: 's', message: 'a' });
    log.append({ level: 'error', source: 's', message: 'b' });
    expect(log.snapshot()).toHaveLength(2);

    log.clear();
    expect(log.snapshot()).toHaveLength(0);
  });
});
