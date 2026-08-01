// ports/clock.ts
// SK 共享内核：Clock 端口——统一时间来源抽象（对齐 architecture.md §4.6、FR-6.3）。
// 零框架 import。本文件只定义端口接口，不含任何适配器实现。
//
// 语义契约：
//   - 生产适配器 SystemClock 返回系统真实时间（读取系统时钟）。
//   - 测试替身 FrozenClock 返回注入的固定时刻（now 恒等），
//     MutableClock 支持可推进时刻，便于确定性测试。
//   - 上层（领域/应用逻辑）禁止直接读取系统时钟，一律经 Clock 端口取时（FR-6.3），
//     以保证核心包纯净、可测试、无隐式时间依赖。

/**
 * 时间来源端口：统一提供当前时刻。
 * 生产实现走系统时钟，测试可注入冻结/可推进替身。
 */
export interface Clock {
  /** 当前时刻，epoch 毫秒。 */
  now(): number;
}
