// ports/runtime-log.ts
// SK 共享内核：RuntimeLog 端口——有界环形运行时日志抽象（对齐 architecture.md §4.5/§3.4、prd.md FR-5、AC-6、NFR-6）。
// 零框架 import。本文件只定义端口接口，不含任何适配器实现。
//
// 语义契约：
//   - 有界环形缓冲：容量上限 capacity 固定；写入 N+K 条时仅保留最新 N 条，
//     以 FIFO 方式覆盖最旧条目（AC-6/FR-5.1）。
//   - append 写入 O(1)（NFR-6），不做线性搬移。
//   - append 接受省略 timestamp 的条目，timestamp 由实现经 Clock 端口注入（epoch 毫秒）；
//     message/meta 写入前自动经 Redactor 端口脱敏（FR-3、AC-3/AC-4）。
//   - 自动脱敏不可绕过（NFR-4/FR-5.3、AC-7）：append 是端口唯一的写入路径，
//     任何进入缓冲的条目都必经 Redactor；端口不暴露任何跳过脱敏的旁路写入方法，
//     故快照中永不出现未脱敏的原始敏感值。
//   - snapshot 返回当前缓冲快照，时间升序（最旧在前、最新在后）、内容已脱敏。
//
// 说明：具体 RingBufferRuntimeLog(capacity, clock, redactor) 实现属适配器层
//       （如 apps/api 的 RingBufferRuntimeLog），本文件仅定义端口契约，不含实现。

import type { LogEntry } from '../domain/log/log-entry.js';

/**
 * 运行时日志端口：有界环形缓冲，提供追加、快照、清空能力。
 * 写入 O(1)（NFR-6）；超出 capacity 时以 FIFO 覆盖最旧条目（AC-6/FR-5.1）。
 * append 是唯一写入路径，且写入前强制脱敏——端口不暴露绕过 Redactor 的旁路方法（NFR-4/FR-5.3、AC-7）。
 */
export interface RuntimeLog {
  /**
   * 追加一条日志；timestamp 由实现经 Clock 端口注入。
   * message/meta 写入前自动经 Redactor 脱敏，此脱敏不可绕过：
   * append 为端口唯一写入路径，凡进入缓冲的条目必经 Redactor，
   * 故快照中永不出现未脱敏的原始敏感值（NFR-4/FR-5.3、AC-7）。写入 O(1)。
   */
  append(entry: Omit<LogEntry, 'timestamp'>): void;
  /** 导出当前环形缓冲快照（已脱敏、时间升序）。 */
  snapshot(): ReadonlyArray<LogEntry>;
  /** 清空缓冲。 */
  clear(): void;
  /** 当前容量上限。 */
  readonly capacity: number;
}
