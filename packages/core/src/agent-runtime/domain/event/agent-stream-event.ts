// agent-runtime/domain/event/agent-stream-event.ts
// C2 · AgentRuntime —— 统一事件模型：14 类 AgentStreamEvent 判别联合 + 值对象。
// 对齐 architecture §3.5、PRD FR-4 / AC-9。
//
// 【本故事（c2-1-5）范围】只定义事件联合与值对象（只读）。
// 不定义 EventMapper 契约与未识别事件降级（属 c2-3），不接 SDK（属 c2-6），不接 NestJS DI。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process / codex。
// 引用 SK 的 ClassifiedError、C2 自身的 StreamPhase / TerminalReasonCode 均用 import type + .js 扩展名。
// 绝不 import C1 的持久 StreamStatus 做实时判断（NFR-2 / AC-15）。

import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import type { StreamPhase } from '../stream/stream-phase.js';
import type { TerminalReasonCode } from '../stream/terminal-reason.js';

/**
 * ToolUseInfo —— 一次工具调用的归一投影（只读值对象）。
 * 对齐现有 consumeSSEStream 的 onToolUse 回调载荷。
 *
 * - id：工具调用的唯一标识（用于与 tool_result 配对）。
 * - name：工具名。
 * - input：工具入参（原样透传的结构化对象；由 Mapper 归一，不在此解释语义）。
 */
export interface ToolUseInfo {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * ToolResultInfo —— 一次工具执行结果的归一投影（只读值对象）。
 * 对齐现有 consumeSSEStream 的 onToolResult 回调载荷。
 *
 * - toolUseId：对应 ToolUseInfo.id；孤儿结果（无匹配 tool_use）时仍保留，
 *   由 buildFinalContent 作为独立块处理（见 architecture §3.4，属 c2-2）。
 * - content：结果内容（文本或结构化内容的字符串投影）。
 * - isError：该结果是否代表工具执行失败。
 */
export interface ToolResultInfo {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

/**
 * TokenUsage —— Runtime 上报的 token 用量投影（只读值对象，只存不算）。
 *
 * 【AC-9 反假数据铁律】仅当 Runtime 真实上报时才构造 TokenUsage；
 * 未上报时整个 TokenUsage 留空（result 事件的 tokenUsage 字段省略），
 * 绝不用 0 占位、绝不显假 0。各计数字段本身在有值时如实填写。
 *
 * - inputTokens / outputTokens：输入 / 输出 token 数。
 * - cacheReadInputTokens / cacheCreationInputTokens：命中 / 写入提示缓存的 token 数（Runtime 支持时）。
 * - totalTokens：Runtime 直接上报的合计（若上报；不在此侧计算，避免与上游口径不一致）。
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * ContextUsage —— 上下文窗口占用投影（只读值对象，只存不算）。
 *
 * 【AC-9】Runtime 未上报时整个 ContextUsage 留空（context_usage 事件不发），UI 隐藏，不显假值。
 *
 * - usedTokens：当前已占用的上下文 token 数。
 * - maxTokens：上下文窗口上限。
 */
export interface ContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

/**
 * PermissionRequest —— Runtime 发起的一次权限请求归一投影（只读值对象）。
 * C2 只中转（见 architecture §6.6），不做经纪判定（属 C5）。
 *
 * - id：权限请求唯一标识（决议回传时定向匹配，对齐 permission_resolved.permissionRequestId）。
 * - toolName：触发权限的工具名。
 * - input：待批准的工具入参投影。
 */
export interface PermissionRequest {
  readonly id: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * RateLimitInfo —— 上游限流信息归一投影（只读值对象）。
 * 各字段均可选：Runtime 未提供的维度留空，不臆造（对齐 AC-9 反假数据精神）。
 *
 * - retryAfterMs：建议重试等待毫秒数。
 * - resetAt：限流窗口重置时刻（epoch 毫秒；由上游提供，不在此侧取 Clock）。
 * - scope：限流维度标识（如 requests / tokens），原样透传。
 */
export interface RateLimitInfo {
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  readonly scope?: string;
}

/**
 * AgentStreamEvent —— 统一事件模型的判别联合（14 类，以 type 判别）。
 * 对齐 architecture §3.5。
 *
 * 其中 text…file_changed（13 类）由各 Runtime 的 EventMapper 从原生事件归一而来
 * （对齐现有 consumeSSEStream 的 onText/onThinking/… 回调，FR-4.2/4.3，Mapper 属 c2-3）；
 * phase_changed（第 14 类）由 C2 核心在相位迁移时产出，不来自 Runtime（C2 内部产出）。
 *
 * 字段语义要点：
 *  - text：累积后的全文（非增量）。
 *  - thinking：思考增量（delta）。
 *  - result：回合结果事件；tokenUsage 可空（Runtime 未上报则省略，AC-9，不填 0）；
 *    terminalReason 携带归因码（可空）。
 *  - error：携带经 SK.ErrorClassifier 归一的 ClassifiedError（含 ABORTED 独立类）。
 */
export type AgentStreamEvent =
  | { readonly type: 'text'; readonly text: string } // 累积后的全文
  | { readonly type: 'thinking'; readonly delta: string }
  | { readonly type: 'tool_use'; readonly tool: ToolUseInfo }
  | { readonly type: 'tool_result'; readonly result: ToolResultInfo }
  | { readonly type: 'tool_output'; readonly data: string } // 工具实时输出
  | { readonly type: 'status'; readonly text: string }
  | {
      readonly type: 'result';
      readonly tokenUsage?: TokenUsage; // AC-9：未上报留空，不填 0
      readonly terminalReason?: TerminalReasonCode;
    }
  | { readonly type: 'error'; readonly error: ClassifiedError }
  | { readonly type: 'permission_request'; readonly request: PermissionRequest }
  | {
      readonly type: 'permission_resolved';
      readonly permissionRequestId: string;
      readonly status: 'allow' | 'deny';
    }
  | { readonly type: 'context_usage'; readonly usage: ContextUsage }
  | { readonly type: 'rate_limit'; readonly info: RateLimitInfo }
  | { readonly type: 'file_changed'; readonly paths: ReadonlyArray<string> }
  // phase_changed：C2 核心在相位迁移时产出，非 Runtime 归一（C2 内部产出）。
  | { readonly type: 'phase_changed'; readonly phase: StreamPhase };
