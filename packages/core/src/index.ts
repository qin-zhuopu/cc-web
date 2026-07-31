// packages/core 桶文件：导出领域类型与端口契约。
export { ErrorCode } from './domain/error/error-code.js';
export { SK_MESSAGE_KEYS } from './domain/error/message-keys.js';
export type { ClassifiedError } from './domain/error/classified-error.js';
export type { ErrorClassifier } from './ports/error-classifier.js';
export { defaultErrorClassifier } from './ports/error-classifier.js';
