// packages/core 桶文件：仅导出领域类型（本轮 sk-1-1 只含 error 领域）。
export { ErrorCode } from './domain/error/error-code.js';
export type { ClassifiedError } from './domain/error/classified-error.js';
