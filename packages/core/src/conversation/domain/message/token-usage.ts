// conversation/domain/message/token-usage.ts
// C1 Conversation 领域边界：Token 用量投影值对象。
// 对齐 architecture §3.3。零框架 import，纯值对象。
//
// 【只存不算 · 务必分清】
// TokenUsage 是 C2 落库时提供的「投影」——C1 只忠实记录，绝不参与任何计算/汇总。
// 因此不设 totalTokens 之类的派生字段（那会诱导 C1 去「算」）。
// 全部字段可选：某项无值 = C2 未记录该项，一律 undefined；
// 严禁落假 0 或假空串（AC-10）——0 与「未记录」语义不同，混淆会污染统计。

/**
 * Token 用量投影：C2 在消息落库时按需提供的原始计数快照。
 *
 * 所有字段均为可选：
 * - 有值时为 C2 明确记录的原始计数；
 * - 无值时为 undefined，表示「未记录」，绝不以 0 冒充（AC-10）。
 */
export interface TokenUsage {
  /** 输入 token 数（prompt 侧）。未记录时 undefined。 */
  readonly inputTokens?: number;
  /** 输出 token 数（生成侧）。未记录时 undefined。 */
  readonly outputTokens?: number;
  /** 写入缓存的输入 token 数。未记录时 undefined。 */
  readonly cacheCreationInputTokens?: number;
  /** 命中缓存的输入 token 数。未记录时 undefined。 */
  readonly cacheReadInputTokens?: number;
}
