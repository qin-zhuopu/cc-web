// agent-runtime/domain/event/event-factory.ts
// C2 · AgentRuntime —— 14 类 AgentStreamEvent 的构造工厂 + 判别 type guard（c2-3-1）。
// 对齐 architecture §3.5、PRD FR-4 / AC-9。
//
// 【本故事（c2-3-1）范围】仅为 c2-1-5 已定义的 14 类事件补「构造工厂 + 判别 type guard」，
// 提供归一目标的可用面（consumer 侧安全构造与判别）。
// 绝不重定义联合成员、不改值对象签名——一律 import type 引用 agent-stream-event.js。
// 不定义 EventMapper 契约（属 c2-3-2）、不接 SDK（属 c2-6）、不接 NestJS DI。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process / uuid。
// 工厂只组装结构、不含任何 I/O，不调 Date.now / new Date / randomUUID（id/时刻由调用方注入）。

import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import type { TerminalReasonCode } from '../stream/terminal-reason.js';
import type {
  AgentStreamEvent,
  ContextUsage,
  PermissionRequest,
  RateLimitInfo,
  TokenUsage,
  ToolResultInfo,
  ToolUseInfo,
} from './agent-stream-event.js';
// phase_changed 是唯一由 C2 核心产出（非 Runtime 归一）的事件，权威定义在 phase-changed-event.ts（c2-3-4）。
// 此处 re-export 以保持事件工厂可用面完整，绝不在本文件重复定义（避免两处同名工厂）。
import { phaseChangedEvent } from './phase-changed-event.js';
import type { PhaseChangedEvent } from './phase-changed-event.js';

// ---------------------------------------------------------------------------
// 判别别名：从联合中按 type 抽取各成员，供工厂返回类型与 type guard 收窄使用。
// 只是对 c2-1-5 联合成员的「投影」，不新增字段、不改签名。
// ---------------------------------------------------------------------------

/** 按 type 从 AgentStreamEvent 联合中抽取对应成员类型（内部工具类型）。 */
type EventOf<T extends AgentStreamEvent['type']> = Extract<AgentStreamEvent, { type: T }>;

export type TextEvent = EventOf<'text'>;
export type ThinkingEvent = EventOf<'thinking'>;
export type ToolUseEvent = EventOf<'tool_use'>;
export type ToolResultEvent = EventOf<'tool_result'>;
export type ToolOutputEvent = EventOf<'tool_output'>;
export type StatusEvent = EventOf<'status'>;
export type ResultEvent = EventOf<'result'>;
export type ErrorEvent = EventOf<'error'>;
export type PermissionRequestEvent = EventOf<'permission_request'>;
export type PermissionResolvedEvent = EventOf<'permission_resolved'>;
export type ContextUsageEvent = EventOf<'context_usage'>;
export type RateLimitEvent = EventOf<'rate_limit'>;
export type FileChangedEvent = EventOf<'file_changed'>;
// PhaseChangedEvent 权威定义在 phase-changed-event.ts（c2-3-4），此处 re-export 保持可用面完整。
export type { PhaseChangedEvent };

// ---------------------------------------------------------------------------
// 构造工厂：只组装结构、无 I/O。每个工厂返回其对应联合成员（窄类型）。
// ---------------------------------------------------------------------------

/** 构造 text 事件。text 语义为「累积后的全文」（非增量），由 Mapper 决定累积口径。 */
export function textEvent(text: string): TextEvent {
  return { type: 'text', text };
}

/** 构造 thinking 事件。delta 为思考增量片段。 */
export function thinkingEvent(delta: string): ThinkingEvent {
  return { type: 'thinking', delta };
}

/** 构造 tool_use 事件，承载一次工具调用的归一投影。 */
export function toolUseEvent(tool: ToolUseInfo): ToolUseEvent {
  return { type: 'tool_use', tool };
}

/** 构造 tool_result 事件，承载一次工具执行结果（含孤儿结果）的归一投影。 */
export function toolResultEvent(result: ToolResultInfo): ToolResultEvent {
  return { type: 'tool_result', result };
}

/** 构造 tool_output 事件，承载工具的实时输出片段。 */
export function toolOutputEvent(data: string): ToolOutputEvent {
  return { type: 'tool_output', data };
}

/** 构造 status 事件，承载人类可读的运行状态文案。 */
export function statusEvent(text: string): StatusEvent {
  return { type: 'status', text };
}

/**
 * 构造 result 回合结果事件。
 *
 * 【AC-9 反假数据铁律 / c2-3-3】tokenUsage 与 terminalReason 均可空：
 * Runtime 未上报 token 用量时 **不传** tokenUsage（字段省略，绝不填 0、绝不造 TokenUsage）；
 * 无归因时 terminalReason 省略。仅当传入 undefined 之外的值时才写入对应字段，
 * 避免产出带 `tokenUsage: undefined` 显式键而误导「已知无值」与「未记录」的区分。
 */
export function resultEvent(params?: {
  readonly tokenUsage?: TokenUsage;
  readonly terminalReason?: TerminalReasonCode;
}): ResultEvent {
  const event: { type: 'result'; tokenUsage?: TokenUsage; terminalReason?: TerminalReasonCode } = {
    type: 'result',
  };
  if (params?.tokenUsage !== undefined) {
    event.tokenUsage = params.tokenUsage;
  }
  if (params?.terminalReason !== undefined) {
    event.terminalReason = params.terminalReason;
  }
  return event;
}

/** 构造 error 事件。error 为经 SK.ErrorClassifier 归一的 ClassifiedError（含 ABORTED 独立类）。 */
export function errorEvent(error: ClassifiedError): ErrorEvent {
  return { type: 'error', error };
}

/** 构造 permission_request 事件，承载 Runtime 发起的权限请求投影（C2 只中转，不判定）。 */
export function permissionRequestEvent(request: PermissionRequest): PermissionRequestEvent {
  return { type: 'permission_request', request };
}

/** 构造 permission_resolved 事件，承载对某权限请求的决议（allow/deny）。 */
export function permissionResolvedEvent(
  permissionRequestId: string,
  status: 'allow' | 'deny',
): PermissionResolvedEvent {
  return { type: 'permission_resolved', permissionRequestId, status };
}

/** 构造 context_usage 事件，承载上下文窗口占用投影（无值时上层不应发本事件，AC-9）。 */
export function contextUsageEvent(usage: ContextUsage): ContextUsageEvent {
  return { type: 'context_usage', usage };
}

/** 构造 rate_limit 事件，承载上游限流信息投影。 */
export function rateLimitEvent(info: RateLimitInfo): RateLimitEvent {
  return { type: 'rate_limit', info };
}

/**
 * 构造 file_changed 事件，承载本回合内变更的文件路径集合。
 * 防御性复制 paths 为不可变数组，避免外部持有可变引用后篡改事件内部状态。
 */
export function fileChangedEvent(paths: ReadonlyArray<string>): FileChangedEvent {
  return { type: 'file_changed', paths: Object.freeze([...paths]) };
}

// phase_changed 的构造工厂 phaseChangedEvent 权威定义在 phase-changed-event.ts（c2-3-4，C2 核心产出），
// 此处从 import 处 re-export，保持事件工厂可用面完整、不重复定义。
export { phaseChangedEvent };

// ---------------------------------------------------------------------------
// 判别 type guard：让消费方安全收窄到各分支字段。
// ---------------------------------------------------------------------------

export function isTextEvent(event: AgentStreamEvent): event is TextEvent {
  return event.type === 'text';
}

export function isThinkingEvent(event: AgentStreamEvent): event is ThinkingEvent {
  return event.type === 'thinking';
}

export function isToolUseEvent(event: AgentStreamEvent): event is ToolUseEvent {
  return event.type === 'tool_use';
}

export function isToolResultEvent(event: AgentStreamEvent): event is ToolResultEvent {
  return event.type === 'tool_result';
}

export function isToolOutputEvent(event: AgentStreamEvent): event is ToolOutputEvent {
  return event.type === 'tool_output';
}

export function isStatusEvent(event: AgentStreamEvent): event is StatusEvent {
  return event.type === 'status';
}

export function isResultEvent(event: AgentStreamEvent): event is ResultEvent {
  return event.type === 'result';
}

export function isErrorEvent(event: AgentStreamEvent): event is ErrorEvent {
  return event.type === 'error';
}

export function isPermissionRequestEvent(
  event: AgentStreamEvent,
): event is PermissionRequestEvent {
  return event.type === 'permission_request';
}

export function isPermissionResolvedEvent(
  event: AgentStreamEvent,
): event is PermissionResolvedEvent {
  return event.type === 'permission_resolved';
}

export function isContextUsageEvent(event: AgentStreamEvent): event is ContextUsageEvent {
  return event.type === 'context_usage';
}

export function isRateLimitEvent(event: AgentStreamEvent): event is RateLimitEvent {
  return event.type === 'rate_limit';
}

export function isFileChangedEvent(event: AgentStreamEvent): event is FileChangedEvent {
  return event.type === 'file_changed';
}

export function isPhaseChangedEvent(event: AgentStreamEvent): event is PhaseChangedEvent {
  return event.type === 'phase_changed';
}
