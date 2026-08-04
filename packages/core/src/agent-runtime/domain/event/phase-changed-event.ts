// agent-runtime/domain/event/phase-changed-event.ts
// C2 · AgentRuntime —— phase_changed 事件：唯一由 C2 核心产出（而非 Runtime 归一）的事件（c2-3-4）。
// 对齐 architecture §3.5、PRD FR-4.2/4.3。
//
// 【本故事（c2-3-4）范围 / 语义要点】
// AgentStreamEvent 的 14 类中，text…file_changed（13 类）均由各 Runtime 的 EventMapper 从原生事件
// 归一而来（属 c2-3-2 契约 / c2-6 实现）；唯有 phase_changed 例外——它由 C2 核心在 StreamSession
// 相位迁移时（active→settling / *→terminal 等，见 stream-session.ts 的 markSettling/complete/abort/fail）
// 主动产出，向订阅方广播「回合实时相位已变化」。因此：
//   - 它【不来自外部 Runtime】，【不经 EventMapper】归一（EventMapper 只处理 Runtime 原生事件）；
//   - Mapper 也【绝不】伪造 phase_changed；相位是核心聚合根的权威事实，不由上游 Runtime 决定。
// 本文件是 phaseChangedEvent 的权威定义处（single source of truth）；event-factory.ts 从此处 re-export，
// 不重复定义，避免归一目标出现两处同名工厂。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process / uuid。
// 工厂只组装结构、不含任何 I/O，不调 Date.now / new Date / randomUUID。
// StreamPhase 是实时内存相位、绝不落库、不与 C1 持久 StreamStatus 混用（NFR-2 / AC-15）。

import type { StreamPhase } from '../stream/stream-phase.js';
import type { AgentStreamEvent } from './agent-stream-event.js';

/**
 * PhaseChangedEvent —— phase_changed 联合成员的窄类型（从 c2-1 联合中按 type 抽取投影）。
 * 仅对已有联合成员做「投影」，不新增字段、不改签名（不重定义联合）。
 */
export type PhaseChangedEvent = Extract<AgentStreamEvent, { type: 'phase_changed' }>;

/**
 * 构造 phase_changed 事件（C2 核心产出，c2-3-4）。
 *
 * 由 C2 核心在 StreamSession 相位迁移时调用，把「迁移后的最新相位」广播给订阅方。
 * 载荷字段以 architecture §3.5 为准——联合成员仅携带单个 `phase`（迁移后的结果相位），
 * 不携带 from/to 二元组：订阅方关心的是「现在处于哪个相位」，前一相位由订阅方自身状态持有。
 * phase 为 c2-1 定义的不可变 StreamPhase 值对象，此处原样承载、不复制不改写。
 *
 * @param phase 迁移后的最新相位（active / settling / terminal(子态)）
 * @returns phase_changed 事件（窄类型）
 */
export function phaseChangedEvent(phase: StreamPhase): PhaseChangedEvent {
  return { type: 'phase_changed', phase };
}

/**
 * isPhaseChangedEvent —— phase_changed 判别 type guard，供消费方安全收窄到 phase 字段。
 */
export function isPhaseChangedEvent(event: AgentStreamEvent): event is PhaseChangedEvent {
  return event.type === 'phase_changed';
}
