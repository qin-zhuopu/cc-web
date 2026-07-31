// domain/error/classified-error.ts
// 分类结果值对象（不可变）。仅类型契约，不含分类逻辑（分类逻辑属 sk-1-2）。
import type { ErrorCode } from './error-code.js';

export interface ClassifiedError {
  readonly code: ErrorCode;          // 稳定错误码
  readonly messageKey: string;       // 可翻译消息键，见 message-keys.ts
  readonly retryable: boolean;       // 是否值得重试（NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE=true）
  readonly cause?: unknown;          // 原始异常引用（脱敏由日志层负责）
  readonly detail?: string;          // 可选补充（已脱敏），供诊断
}
