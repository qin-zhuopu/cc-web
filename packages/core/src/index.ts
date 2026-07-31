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
