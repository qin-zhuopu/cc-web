// packages/core 桶文件：导出领域类型与端口契约。
export { ErrorCode } from './domain/error/error-code.js';
export { SK_MESSAGE_KEYS } from './domain/error/message-keys.js';
export type { ClassifiedError } from './domain/error/classified-error.js';
export type { ErrorClassifier } from './ports/error-classifier.js';
export { defaultErrorClassifier } from './ports/error-classifier.js';
export type { Clock } from './ports/clock.js';
export type { IdGenerator } from './ports/id-generator.js';
export type { OsType, ArchType, PlatformInfo, Platform } from './ports/platform.js';
export type { Redactor } from './ports/redactor.js';
export type { RuntimeLog } from './ports/runtime-log.js';
export type { LogEntry, LogLevel } from './domain/log/log-entry.js';
export type { Locale, TranslationPort } from './ports/translation-port.js';

// ==== C1 Conversation ====
// 会话领域值对象/实体（session）
export type { SessionId, ChatSession } from './conversation/domain/session/chat-session.js';
export { SessionStatus, SessionMode, SessionSource } from './conversation/domain/session/chat-session.js';
export type { TitleOrigin } from './conversation/domain/session/title-origin.js';
export { canOverrideTitle } from './conversation/domain/session/title-origin.js';
// 消息领域值对象/实体（message）
export type { MessageId, MessageRole, Message } from './conversation/domain/message/message.js';
export type { MessageContent } from './conversation/domain/message/message-content.js';
export { encodeContent, decodeContent, textContent } from './conversation/domain/message/message-content.js';
// 消息内容块（判别联合与其辅助形状）
export type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  CodeBlock,
  MediaRef,
  ExternalSourceRef,
} from './conversation/domain/message/content-block.js';
export type { StreamStatus } from './conversation/domain/message/stream-status.js';
export { canTransition } from './conversation/domain/message/stream-status.js';
export type { TokenUsage } from './conversation/domain/message/token-usage.js';
// C1 i18n 消息键
export { C1_MESSAGE_KEYS } from './conversation/domain/message-keys.js';
// 驱动端口（driving）与输入类型
export type { CreateSessionInput, ListSessionsQuery, ManageSessionUseCase } from './conversation/ports/driving/manage-session-usecase.js';
export type { SetSessionTitleUseCase } from './conversation/ports/driving/set-session-title-usecase.js';
export type { AppendMessageInput, AppendMessageUseCase } from './conversation/ports/driving/append-message-usecase.js';
export type { HistoryQuery, GetSessionHistoryUseCase } from './conversation/ports/driving/get-session-history-usecase.js';
// 被驱动端口（driven）
export type { SessionRepository } from './conversation/ports/driven/session-repository.js';
export type { MessageRepository } from './conversation/ports/driven/message-repository.js';
export type { TitleGenerationInput, TitleGeneratorPort } from './conversation/ports/driven/title-generator-port.js';
// 用例服务（application service）
export { ManageSessionService } from './conversation/usecases/manage-session.js';
export { SetSessionTitleService } from './conversation/usecases/set-session-title.js';
export { AppendMessageService } from './conversation/usecases/append-message.js';
export { GetSessionHistoryService } from './conversation/usecases/get-session-history.js';

// ==== C2 AgentRuntime ====
// 实时相位状态机（phase 不落库，绝不与 C1 持久 StreamStatus 混用；NFR-2/AC-15）
export type { StreamPhase, StreamSessionId } from './agent-runtime/domain/stream/stream-phase.js';
export { StreamPhaseKind, TerminalSubstate, isActive, isTerminal } from './agent-runtime/domain/stream/stream-phase.js';
// 相位状态机纯函数判定（合法迁移谓词 + 中断收敛）
export { canTransitionPhase, reconcilePhase } from './agent-runtime/domain/stream/phase-transition.js';
// 终态归因值对象 + 归因码映射纯函数
export type { TerminalReason } from './agent-runtime/domain/stream/terminal-reason.js';
export { TerminalReasonCode, expectedErrorCode, isUserAbort, isErrorReason } from './agent-runtime/domain/stream/terminal-reason.js';
// 累积产物值对象 + 最终内容投影纯函数
export type { TurnArtifacts } from './agent-runtime/domain/stream/turn-artifacts.js';
export { buildFinalContent } from './agent-runtime/domain/stream/turn-artifacts.js';
// 统一事件模型（14 类判别联合 + 值对象）；TokenUsage 与 C1 同名，别名 RuntimeTokenUsage 避免桶冲突
export type {
  AgentStreamEvent,
  ToolUseInfo,
  ToolResultInfo,
  ContextUsage,
  PermissionRequest,
  RateLimitInfo,
  TokenUsage as RuntimeTokenUsage,
} from './agent-runtime/domain/event/agent-stream-event.js';
// C2 i18n 消息键（c2.* 命名空间）
export { C2_MESSAGE_KEYS } from './agent-runtime/domain/message-keys.js';
// RuntimeKind 枚举 + 可用性值对象
export type { RuntimeAvailability } from './agent-runtime/ports/runtime-kind.js';
export { RuntimeKind } from './agent-runtime/ports/runtime-kind.js';
// 驱动端口（driving）与入/出参形状
export type {
  StartStreamUseCase,
  StartStreamInput,
  StartStreamResult,
  FileAttachmentRef,
  MentionRef,
  ThinkingOptions,
} from './agent-runtime/ports/driving/start-stream-usecase.js';
export type { AbortStreamUseCase } from './agent-runtime/ports/driving/abort-stream-usecase.js';
// TitleGenerator（权威归属 C2）；入参与 C1 同名，别名 RuntimeTitleGenerationInput 避免桶冲突
export type {
  TitleGenerator,
  TitleGenerationInput as RuntimeTitleGenerationInput,
} from './agent-runtime/ports/driving/title-generator.js';
// 被驱动端口（driven）：C2 自有 AgentRuntimePort + C7 只读端口
export type {
  AgentRuntimePort,
  RuntimeRunRequest,
  RuntimeRunOptions,
  TurnRef,
  AbortSignalLike,
} from './agent-runtime/ports/driven/agent-runtime-port.js';
export type { ProviderReadPort, ResolvedProviderView, ProviderProtocol } from './agent-runtime/ports/driven/provider-read-port.js';
// 喂模型历史投影（AppendMessageUseCase/GetSessionHistoryUseCase 已由 C1 段导出，此处不重复）
export type { PromptMessage } from './agent-runtime/ports/driven/conversation-ports.js';
