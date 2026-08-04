// agent-runtime/ports/driving/start-stream-usecase.ts
// C2 · AgentRuntime 驱动端口：StartStreamUseCase（发起一次回合）。
// 对齐 architecture §4.1。零框架 import；仅接口签名骨架。
//
// 【本故事（c2-1-6）范围】只给端口签名与入/出参形状，不实现 StartStreamService（属 epic-c2-2）、
// 不接 AgentRuntimePort 路由、不接 SDK、不接 NestJS DI。
//
// 【铁律】核心零框架：不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process；类型-only import 用 import type + .js 扩展名，字段全 readonly。

import type { StreamSessionId } from '../../domain/stream/stream-phase.js';
import type { AgentStreamEvent } from '../../domain/event/agent-stream-event.js';

/**
 * FileAttachmentRef —— 回合发起时携带的文件附件引用（只读投影）。
 * C2 只透传引用，不承载文件字节（媒体归属 C4）。
 *  - id：附件标识（供适配器解析实际内容）。
 *  - name：文件名（可选，UI / 提示词组织用）。
 *  - mimeType：媒体类型（可选，Runtime 支持时用于分派）。
 */
export interface FileAttachmentRef {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
}

/**
 * MentionRef —— 回合发起时携带的 @ 提及引用（只读投影）。
 *  - kind：提及种类（如 file / symbol / url，原样透传，不在 C2 解释语义）。
 *  - value：提及值（路径 / 标识 / 文本）。
 */
export interface MentionRef {
  readonly kind: string;
  readonly value: string;
}

/**
 * ThinkingOptions —— 思考预算选项（Runtime 支持时透传）。
 *  - type：思考模式标识（原样透传）。
 *  - budgetTokens：思考 token 预算（可选；未提供则由 Runtime 取默认）。
 */
export interface ThinkingOptions {
  readonly type: string;
  readonly budgetTokens?: number;
}

/**
 * StartStreamInput —— 发起一次回合的入参（对齐 architecture §4.1）。
 *
 * 【反假数据】可选字段无值保持 undefined，用例不预填假默认。
 */
export interface StartStreamInput {
  /** C1 会话 id（一个会话可承载多次回合）。 */
  readonly sessionId: string;
  /** 本回合用户输入内容。 */
  readonly content: string;
  /** 会话模式：code / plan / ask（原样透传，Runtime 侧解释）。 */
  readonly mode: string;
  /** 模型标识。 */
  readonly model: string;
  /** Provider 标识 —— 经 C7.ProviderRepository 解析协议 / auth / endpoint。 */
  readonly providerId: string;
  /** 文件附件引用列表（可选）。 */
  readonly files?: ReadonlyArray<FileAttachmentRef>;
  /** @ 提及引用列表（可选）。 */
  readonly mentions?: ReadonlyArray<MentionRef>;
  /** 追加到系统提示词的片段（可选）。 */
  readonly systemPromptAppend?: string;
  /** 努力档位：low / medium / high / max（Runtime 支持时）。 */
  readonly effort?: string;
  /** 思考选项（Runtime 支持时）。 */
  readonly thinking?: ThinkingOptions;
  /** 是否启用 1M context（Anthropic 系支持时）。 */
  readonly context1m?: boolean;
  /** 本回合选用的技能标识列表（可选）。 */
  readonly selectedSkills?: ReadonlyArray<string>;
  /** assistant 自动触发：跳过存 user 消息 / 标题生成（FR-2）。 */
  readonly autoTrigger?: boolean;
}

/**
 * StartStreamResult —— 发起回合的结果（对齐 architecture §4.1）。
 *  - streamId：本次回合的 StreamSessionId。
 *  - events：归一后的 AgentStreamEvent 异步事件流（订阅式亦可）。
 */
export interface StartStreamResult {
  readonly streamId: StreamSessionId;
  readonly events: AsyncIterable<AgentStreamEvent>;
}

/**
 * StartStreamUseCase —— 发起一次回合的驱动端口（对外提供）。
 *
 * 仅签名骨架，无实现体——编排逻辑（旧回合先 abort、解析 provider → runtimeKind、
 * 取历史投影、创建 StreamSession、订阅归一事件流、终态落 C1）落地属 epic-c2-2。
 * 见 architecture §4.1 / §6.1 编排要点。
 */
export interface StartStreamUseCase {
  /**
   * 发起一次回合（编排见 §4.1）：
   *  1. 若该 sessionId 已有 active 回合 → 先 abort 旧回合（FR-2.4 / AC-11）。
   *  2. 经 C7.ProviderRepository 解析 providerId → 选 RuntimeKind（FR-2.2）。
   *  3. 经 C1.GetSessionHistoryUseCase.getPromptView 拿喂模型历史（FR-2.3）。
   *  4. 创建 StreamSession(phase=active)，注册进 registry，调 AgentRuntimePort.run。
   *  5. 消费归一事件 → session.apply；终态时 complete/abort/fail + 落 C1（FR-2.5/2.6）。
   */
  start(input: StartStreamInput): Promise<StartStreamResult>;
}
