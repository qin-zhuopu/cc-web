// domain/error/message-keys.ts
// SK 共享内核：SK 自身产生的 i18n 消息键常量表。零框架 import，仅常量。
// SK 只定义自己产生的键；locale 文案表由 apps/api 适配器层提供，SK 不含任何具体文案。
//
// 只读性与全覆盖（见 architecture.md §3.3、spec-sk-1-3）：
//   - as const 给出字面量类型 + 只读，防止运行时篡改与键值漂移。
//   - satisfies Readonly<Record<ErrorCode, string>> 把「漏掉任一 ErrorCode」前移为编译错误，
//     保证 16 类各有且仅有一个 sk.error.* 键，键值逐字对齐 §3.3。
import { ErrorCode } from './error-code.js';

/**
 * SK 产生的 i18n 消息键常量：每个 ErrorCode 映射唯一 sk.error.* 键。
 * 全项目键真相源——error-classifier.ts 与 i18n 适配器均引用本表。
 */
export const SK_MESSAGE_KEYS = {
  [ErrorCode.NETWORK]: 'sk.error.network',
  [ErrorCode.TIMEOUT]: 'sk.error.timeout',
  [ErrorCode.RATE_LIMIT]: 'sk.error.rateLimit',
  [ErrorCode.AUTH]: 'sk.error.auth',
  [ErrorCode.PERMISSION]: 'sk.error.permission',
  [ErrorCode.INVALID_REQUEST]: 'sk.error.invalidRequest',
  [ErrorCode.NOT_FOUND]: 'sk.error.notFound',
  [ErrorCode.CONFLICT]: 'sk.error.conflict',
  [ErrorCode.SERVER]: 'sk.error.server',
  [ErrorCode.UNAVAILABLE]: 'sk.error.unavailable',
  [ErrorCode.QUOTA_EXCEEDED]: 'sk.error.quotaExceeded',
  [ErrorCode.RESOURCE_LIMIT]: 'sk.error.resourceLimit',
  [ErrorCode.FILESYSTEM]: 'sk.error.filesystem',
  [ErrorCode.PROCESS]: 'sk.error.process',
  [ErrorCode.ABORTED]: 'sk.error.aborted',
  [ErrorCode.UNKNOWN]: 'sk.error.unknown',
} as const satisfies Readonly<Record<ErrorCode, string>>;
