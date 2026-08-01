// agent-runtime/ports/driven/agent-runtime-port.ts
// C2 · AgentRuntime 出站端口：AgentRuntimePort（C2 自有；供 C3 复用）。
// 对齐 architecture §5.1。零框架 import；仅接口签名骨架。
//
// 【本故事（c2-1-6）范围】只给端口签名与请求/引用形状，不实现三适配器
//（ClaudeSdkRuntimeAdapter / NativeRuntimeAdapter / CodexRuntimeAdapter，属基础设施层）、
// 不实现 RuntimeRouter（属 epic-c2-2）、不接 SDK / 子进程 / HTTP。
//
// 【铁律】核心零框架：不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / codex；类型-only import 用 import type + .js 扩展名，字段全 readonly。
// 归一后的 AgentStreamEvent 由适配器内 EventMapper 产出，核心不出现 SDK/进程/HTTP 细节（NFR-1 / AC-14）。

import type { StreamSessionId } from '../../domain/stream/stream-phase.js';
import type { AgentStreamEvent } from '../../domain/event/agent-stream-event.js';
import type { RuntimeKind, RuntimeAvailability } from '../runtime-kind.js';
import type { ResolvedProviderView } from './provider-read-port.js';
import type { PromptMessage } from './conversation-ports.js';

/**
 * RuntimeRunOptions —— 一次原生调用的运行选项投影（只读）。
 * 由 StartStreamInput 归约而来，原样透传给适配器（mode/model/effort/thinking/skills 等）。
 * 各字段 Runtime 支持时生效；未提供保持 undefined，不预填假默认（反假数据）。
 */
export interface RuntimeRunOptions {
  readonly mode: string;
  readonly model: string;
  readonly effort?: string;
  readonly thinking?: { readonly type: string; readonly budgetTokens?: number };
  readonly context1m?: boolean;
  readonly selectedSkills?: ReadonlyArray<string>;
  readonly systemPromptAppend?: string;
}

/**
 * AbortSignalLike —— 中断信号的最小结构契约（只读）。
 *
 * 【为何本地定义而非 import DOM/Node AbortSignal】核心包保持环境无关，
 * 只刻画 run 需要的最小形状（aborted 只读 + 订阅/退订）；实际 AbortSignal / AbortController
 * 由适配器层（fetch / SDK）提供并结构化满足此形状。
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * RuntimeRunRequest —— 发起一次原生调用的请求（对齐 architecture §5.1）。
 *  - streamId：本次回合标识。
 *  - runtimeKind：路由到对应适配器。
 *  - resolvedProvider：只读解析结果，来自 C7（endpoint/auth/model）。
 *  - promptView：喂模型历史投影，来自 C1.getPromptView。
 *  - content：本回合用户输入。
 *  - options：运行选项投影。
 *  - abortSignal：中断信号（force-abort / 优雅 interrupt 均可触发）。
 */
export interface RuntimeRunRequest {
  readonly streamId: StreamSessionId;
  readonly runtimeKind: RuntimeKind;
  readonly resolvedProvider: ResolvedProviderView;
  readonly promptView: ReadonlyArray<PromptMessage>;
  readonly content: string;
  readonly options: RuntimeRunOptions;
  readonly abortSignal: AbortSignalLike;
}

/**
 * TurnRef —— 一次进行中回合的运行时句柄引用（对齐 architecture §5.1）。
 *  - streamId：回合标识（核心可见的稳定键）。
 *  - native：适配器内部句柄（Query / AbortController / thread-turn 等），
 *    对核心不透明（unknown），核心不解释、不依赖其结构。
 */
export interface TurnRef {
  readonly streamId: StreamSessionId;
  readonly native?: unknown;
}

/**
 * PermissionDecision —— 上层（经 C5 经纪）对某次权限请求的决议投影（只读值对象）。
 *
 * 【c2-7 扩展】本类型随 CAP-2「权限决议中转」新增，供 resolvePermission 把上层决议
 *   忠实投递给对应 Runtime 适配器。C2 只中转、不做经纪判定（自动批准/超时拒绝归 C5）。
 *
 *  - permissionRequestId：定向匹配的权限请求标识（对齐 PermissionRequest.id / permission_resolved.permissionRequestId）。
 *  - status：决议结果——'allow'（本次批准）/ 'allow_session'（本会话内批准同类）/ 'deny'（拒绝）。
 *  - updatedInput：可选，批准时上层可下发修订后的工具入参（Runtime 支持时生效），原样透传。
 *  - denyMessage：可选，拒绝时回传给 Runtime/模型的说明文案，原样透传。
 */
export interface PermissionDecision {
  readonly permissionRequestId: string;
  readonly status: 'allow' | 'allow_session' | 'deny';
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly denyMessage?: string;
}

/**
 * AgentRuntimePort —— C2 自有出站端口（对外提供 → C3 复用，对齐 architecture §5.1）。
 *
 * 实现位置：三适配器 ClaudeSdkRuntimeAdapter / NativeRuntimeAdapter / CodexRuntimeAdapter
 *（各带 EventMapper，位于基础设施层），经 RuntimeRouter 按 runtimeKind 路由。
 * 供 C3 复用：C3 imports: [AgentRuntimeModule] 后注入本端口发起子 agent AI 调用，C2 不感知子 agent。
 *
 * 仅签名骨架，无实现体。
 */
export interface AgentRuntimePort {
  /** 发起一次原生调用，产出**归一后**的 AgentStreamEvent 流（EventMapper 在适配器内）。 */
  run(request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent>;
  /** 优雅中断，返回 Runtime 权威状态（供 reconcilePhase）；关闭 turn/thread/Query（FR-3.5）。 */
  interrupt(turnRef: TurnRef): Promise<string | null>;
  /** 强制关闭 turn（force-abort 安全网兜底调用）。 */
  forceKillTurn(turnRef: TurnRef): void;
  /** 非 spawn 的可用性探测（Codex 探 binary/版本，不启进程）。 */
  availability(): Promise<RuntimeAvailability>;
  /**
   * 【c2-7 扩展 · CAP-2】把上层权限决议忠实投递给对应回合的 Runtime（FR-7.2/7.3）。
   * C2 只中转、不裁决；按 turnRef.streamId 定位适配器委派。可同步或异步完成。
   */
  resolvePermission(turnRef: TurnRef, decision: PermissionDecision): void | Promise<void>;
}
