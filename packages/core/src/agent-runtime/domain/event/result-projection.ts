// agent-runtime/domain/event/result-projection.ts
// C2 · AgentRuntime —— result 事件 token 投影（纯函数）。
// 对齐 architecture §3.5 result 事件、PRD AC-9（反假数据：无上报留空不填 0）。
//
// 【本故事（c2-3-3）范围】只提供把 Runtime 上报的原始 usage 数据投影为 result 事件
// tokenUsage（TokenUsage / RuntimeTokenUsage）的纯函数：有上报原样投影，无上报字段留空
// （undefined），绝不用 0 占位。各 Runtime 具体字段名归一属适配器（c2-6），本函数只做
// 「已归一的原始上报 → result 投影」的最后一步反假数据把关。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / codex；不直调 Clock/随机源（本函数无副作用、无时间/随机依赖）。
// 只 import type 引用同域已定义的 TokenUsage，绝不重定义值对象签名。

import type { TokenUsage } from './agent-stream-event.js';

/**
 * RawTokenUsageReport —— Runtime 上报的原始 usage 数据（已由适配器归一到统一字段名，
 * 但每个字段是否上报仍不确定）。所有字段可选、可为 null，代表「该维度 Runtime 是否上报」
 * 的不确定性；本函数据此做反假数据投影。
 *
 * 字段语义与 TokenUsage 一一对应（inputTokens / outputTokens / cache 系列 / totalTokens），
 * 差异仅在于：这里全部可缺省/可 null（未上报），而 TokenUsage 里 input/output 为必填。
 */
export interface RawTokenUsageReport {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadInputTokens?: number | null;
  readonly cacheCreationInputTokens?: number | null;
  readonly totalTokens?: number | null;
}

/**
 * 取一个「被真实上报」的计数值：仅当为有限数值时视为已上报并原样返回，
 * 否则（undefined / null / NaN / Infinity）视为未上报返回 undefined。
 *
 * 注意：合法上报的 0 会被保留（Number.isFinite(0) === true）——0 若来自 Runtime 真实上报
 * 是真数据；AC-9 禁止的是「未上报却填 0」，而非「上报值恰为 0」。
 */
function pickReported(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * projectResultTokenUsage —— 把 Runtime 上报的原始 usage 投影为 result 事件的 tokenUsage。
 *
 * 反假数据规则（AC-9）：
 *  - 完全无上报（raw 为 null/undefined，或必填计数缺失）→ 返回 undefined，result.tokenUsage 留空，
 *    绝不构造 { inputTokens: 0, outputTokens: 0 } 之类假数据。
 *  - 有上报 → 原样投影已上报字段；未上报的可选字段（cache 系列 / total）保持 undefined，不补 0。
 *
 * 必填计数处理：TokenUsage 的 inputTokens / outputTokens 为必填。只有二者都被真实上报时
 * 才产出 TokenUsage；只要有一个未上报，就整体留空（返回 undefined）而非填 0 凑齐必填项——
 * 这样任何产出的 TokenUsage 都不含臆造的 0。
 *
 * @param raw Runtime 上报的原始 usage 数据（已归一字段名）；未上报则传 null/undefined。
 * @returns 有效上报时的 TokenUsage 投影；无有效上报时 undefined（不填 0）。
 */
export function projectResultTokenUsage(
  raw: RawTokenUsageReport | null | undefined,
): TokenUsage | undefined {
  if (raw == null) {
    return undefined;
  }

  const inputTokens = pickReported(raw.inputTokens);
  const outputTokens = pickReported(raw.outputTokens);

  // 必填计数未双双上报 → 整体留空，绝不填 0 凑齐（AC-9）。
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const cacheReadInputTokens = pickReported(raw.cacheReadInputTokens);
  const cacheCreationInputTokens = pickReported(raw.cacheCreationInputTokens);
  const totalTokens = pickReported(raw.totalTokens);

  // 逐字段仅在已上报时并入；未上报的可选字段整体省略（保持 undefined，不补 0）。
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}
