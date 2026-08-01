// domain/log/log-entry.ts
// SK 共享内核：运行时日志值对象——LogEntry 与 LogLevel（对齐 architecture.md §4.5/§3.4、prd.md FR-5、AC-6、NFR-6）。
// 零框架 import。本文件只定义值对象，不含任何适配器实现。
//
// 语义契约：
//   - LogEntry 为不可变值对象，全字段 readonly。
//   - timestamp 语义来自 Clock.now()（epoch 毫秒），由写入侧（RuntimeLog.append）经 Clock 端口注入；
//     核心不直接读取系统时钟，以保证核心包纯净、可测试、无隐式时间依赖。
//   - message 与 meta 均为「已脱敏」内容：写入前须经 Redactor 端口脱敏（FR-3、AC-3/AC-4）。

/** 日志级别，由低到高：调试 / 信息 / 警告 / 错误。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 运行时日志条目：不可变值对象，全字段 readonly。
 * timestamp 来自 Clock.now()（epoch 毫秒），由写入侧注入；message/meta 均为已脱敏内容。
 */
export interface LogEntry {
  /** 条目时刻，epoch 毫秒；语义来自 Clock.now()，由写入侧经 Clock 端口注入。 */
  readonly timestamp: number;
  /** 日志级别。 */
  readonly level: LogLevel;
  /** 来源标识，如 'c2.stream' / 'c7.doctor'。 */
  readonly source: string;
  /** 日志正文，已脱敏。 */
  readonly message: string;
  /** 结构化附加字段，已脱敏。 */
  readonly meta?: Readonly<Record<string, unknown>>;
}
