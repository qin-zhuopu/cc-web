// conversation/domain/message/stream-status.ts
// C1 Conversation 领域边界：持久转录行的生命周期状态。
//
// 【语义边界 · 务必分清】
// StreamStatus 只表达「这条持久转录消息最终完整 / 中断 / 出错」，
// 即一条已落库消息行的最终生命周期结果。
// 它绝不表达「现在还在流式吗」这类实时相位问题——那属于 C2 运行时的职责，
// 由 C2 在内存态里回答；C1 只记录持久事实，不追踪实时相位。

/**
 * StreamStatus：持久转录行的生命周期状态。
 *
 * - streaming：转录行创建后、尚未定型的中间态（增量写入中）。
 * - completed：转录行正常收尾，内容完整。
 * - interrupted：转录行被中断（如用户主动中止），内容不完整但非错误。
 * - error：转录行因错误终止，内容不完整。
 *
 * completed / interrupted / error 三者均为终态，一经落定不可回退。
 */
export type StreamStatus = 'streaming' | 'completed' | 'interrupted' | 'error';

/**
 * canTransition：判定一条持久转录行的生命周期状态迁移是否合法（纯函数）。
 *
 * 规则：
 * - streaming → completed / interrupted / error：合法（由中间态收敛到终态）。
 * - 任一终态 → 任何状态：非法（终态不可回退、不可再改写）。
 * - streaming → streaming：合法。选择将其视为幂等——同一中间态的重复写入
 *   （如多次增量追加）不应被判为非法迁移，避免调用方为幂等场景做额外特判。
 *
 * @param from 迁移前状态
 * @param to   迁移后状态
 * @returns 迁移合法返回 true，否则 false
 */
export function canTransition(from: StreamStatus, to: StreamStatus): boolean {
  // 终态一律不可迁出。
  if (from !== 'streaming') {
    return false;
  }
  // streaming 可迁往任一终态；streaming→streaming 视为幂等，同样合法。
  // 由于 to 的类型已被 StreamStatus 收敛为四个合法字面量，此处无需再枚举。
  return true;
}
