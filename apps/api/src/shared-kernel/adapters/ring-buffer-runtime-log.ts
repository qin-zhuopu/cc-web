// apps/api/src/shared-kernel/adapters/ring-buffer-runtime-log.ts
// RuntimeLog 端口的最小占位适配器（供 DI 图装配，后续 epic 可替换/加固）。
//
// 有界环形缓冲：容量上限固定，超出以 FIFO 覆盖最旧条目（AC-6/FR-5.1）。
// append 是唯一写入路径：timestamp 经 Clock 端口注入，message/meta 经 Redactor
// 脱敏后入缓冲，脱敏不可绕过（NFR-4/FR-5.3、AC-7）。写入 O(1)。
import type { Clock, LogEntry, Redactor, RuntimeLog } from '@codepilot/core';

/** 默认容量上限。 */
const DEFAULT_CAPACITY = 1000;

/** 生产 RuntimeLog 的最小占位实现：定长环形数组 + 写入前强制脱敏。 */
export class RingBufferRuntimeLog implements RuntimeLog {
  readonly capacity: number;

  private readonly buffer: LogEntry[] = [];
  /** 下一次写入位置（环形游标）。 */
  private writeIndex = 0;
  /** 已写入总数，用于判断是否已环绕。 */
  private count = 0;

  constructor(
    private readonly clock: Clock,
    private readonly redactor: Redactor,
    capacity: number = DEFAULT_CAPACITY,
  ) {
    this.capacity = capacity;
  }

  append(entry: Omit<LogEntry, 'timestamp'>): void {
    // 写入前强制脱敏 message/meta，并由 Clock 注入 timestamp——此路径不可绕过。
    const redacted: LogEntry = {
      timestamp: this.clock.now(),
      level: entry.level,
      source: entry.source,
      message: this.redactor.redactString(entry.message),
      ...(entry.meta === undefined ? {} : { meta: this.redactor.redact(entry.meta) }),
    };
    this.buffer[this.writeIndex] = redacted;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
  }

  snapshot(): ReadonlyArray<LogEntry> {
    // 时间升序（最旧在前）：未环绕时即 0..count；已环绕时从 writeIndex 起绕一圈。
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    return [
      ...this.buffer.slice(this.writeIndex),
      ...this.buffer.slice(0, this.writeIndex),
    ];
  }

  clear(): void {
    this.buffer.length = 0;
    this.writeIndex = 0;
    this.count = 0;
  }
}
