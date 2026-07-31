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
