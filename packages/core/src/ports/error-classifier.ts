// ports/error-classifier.ts
// SK 共享内核：ErrorClassifier 端口 + 纯函数默认实现。
// 零框架 import；类型-only import 用 import type + .js 扩展名（verbatimModuleSyntax）。
//
// 语义（见 architecture.md §4.1、spec-sk-1-2）：
//   - classify(error: unknown): ClassifiedError 是纯函数——同输入同输出、无 I/O、
//     不依赖时间/随机、无副作用、无可变闭包捕获。
//   - 无法识别的异常归 UNKNOWN 且永不抛出（含 null/undefined/原始值/对象等任意输入）。
//   - retryable 仅对 NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE 为 true，其余为 false。
//   - 每个结果携带 code + messageKey + retryable，并把原始输入放入 cause。
//   - messageKey 取 sk.error.* 形式，与 ErrorCode 一一对应（对齐 architecture.md §3.3）。
//     引用 SK_MESSAGE_KEYS 作为全项目唯一键真相源（sk-1-3 落地，消除重复映射）。
import { ErrorCode } from '../domain/error/error-code.js';
import { SK_MESSAGE_KEYS } from '../domain/error/message-keys.js';
import type { ClassifiedError } from '../domain/error/classified-error.js';

/**
 * 将任意异常映射为结构化分类结果；永不抛出，无法识别归 UNKNOWN。
 * 见 architecture.md §4.1。
 */
export interface ErrorClassifier {
  classify(error: unknown): ClassifiedError;
}

/** 可重试错误码集合：只有这 4 类值得重试。 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.NETWORK,
  ErrorCode.TIMEOUT,
  ErrorCode.RATE_LIMIT,
  ErrorCode.UNAVAILABLE,
]);

/** 从任意输入尽力提取 HTTP 状态码（status / statusCode / response.status）。 */
function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const candidates: unknown[] = [record.status, record.statusCode];
  const response = record.response;
  if (typeof response === 'object' && response !== null) {
    candidates.push((response as Record<string, unknown>).status);
    candidates.push((response as Record<string, unknown>).statusCode);
  }
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && /^\d+$/.test(c)) return Number(c);
  }
  return undefined;
}

/** 从任意输入尽力提取 Node 风格错误码字符串（err.code，如 ECONNREFUSED）。 */
function extractNodeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

/** 从任意输入尽力提取 error.name。 */
function extractName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

/** 从任意输入尽力提取可读消息文本（message 字段或字符串本身），统一小写便于关键词匹配。 */
function extractMessage(error: unknown): string {
  if (typeof error === 'string') return error.toLowerCase();
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message.toLowerCase();
  }
  return '';
}

/** 按 HTTP 状态码归类；命中返回 ErrorCode，否则 undefined。 */
function classifyByStatus(status: number): ErrorCode | undefined {
  if (status === 401) return ErrorCode.AUTH;
  if (status === 403) return ErrorCode.PERMISSION;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.CONFLICT;
  if (status === 429) return ErrorCode.RATE_LIMIT;
  if (status === 400 || status === 422) return ErrorCode.INVALID_REQUEST;
  if (status === 408) return ErrorCode.TIMEOUT; // Request Timeout — 明确可重试超时
  if (status === 413) return ErrorCode.RESOURCE_LIMIT; // payload too large
  if (status === 503) return ErrorCode.UNAVAILABLE;
  if (status === 504) return ErrorCode.TIMEOUT; // Gateway Timeout — 本质超时，可重试
  if (status === 502) return ErrorCode.UNAVAILABLE; // Bad Gateway — 上游临时故障，可重试
  if (status >= 500) return ErrorCode.SERVER;
  return undefined;
}

/** 按 Node 风格错误码归类；命中返回 ErrorCode，否则 undefined。 */
function classifyByNodeCode(code: string, message: string): ErrorCode | undefined {
  // 子进程语境优先：spawn 失败常带 err.code='ENOENT'/'EACCES'，若不先判会被误归 FILESYSTEM。
  if (message.includes('spawn') || message.includes('child process')) {
    return ErrorCode.PROCESS;
  }
  switch (code) {
    case 'ETIMEDOUT':
      return ErrorCode.TIMEOUT;
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ECONNRESET':
    case 'EPIPE':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return ErrorCode.NETWORK;
    case 'EACCES':
      // EACCES 可能是文件权限，也可能是网络端口权限；文件语境优先归 FILESYSTEM。
      return ErrorCode.FILESYSTEM;
    case 'ENOENT':
    case 'EEXIST':
    case 'EISDIR':
    case 'ENOTDIR':
    case 'EMFILE':
    case 'ENOSPC':
      return ErrorCode.FILESYSTEM;
    default:
      return undefined;
  }
}

/** 按 error.name 归类；命中返回 ErrorCode，否则 undefined。 */
function classifyByName(name: string, message: string): ErrorCode | undefined {
  if (name === 'AbortError') {
    // AbortController 超时会以 AbortError 抛出；含超时语义时归 TIMEOUT（可重试），
    // 否则视为用户主动中断归 ABORTED（不可重试）。
    if (message.includes('timeout') || message.includes('timed out')) return ErrorCode.TIMEOUT;
    return ErrorCode.ABORTED;
  }
  if (name === 'TimeoutError') return ErrorCode.TIMEOUT;
  return undefined;
}

/** 按语义关键词归类（最弱信号，作为兜底前的最后依据）。 */
function classifyByKeyword(message: string): ErrorCode | undefined {
  if (message === '') return undefined;

  // 中断 / 取消
  if (message.includes('abort') || message.includes('cancel')) return ErrorCode.ABORTED;
  // 超时
  if (message.includes('timeout') || message.includes('timed out')) return ErrorCode.TIMEOUT;
  // 限流
  if (message.includes('rate limit') || message.includes('too many requests')) return ErrorCode.RATE_LIMIT;
  // 配额 / 余额
  if (
    message.includes('quota') ||
    message.includes('insufficient balance') ||
    message.includes('insufficient_quota') ||
    message.includes('billing')
  ) {
    return ErrorCode.QUOTA_EXCEEDED;
  }
  // 上下文超限 / 载荷过大
  if (
    message.includes('context length') ||
    message.includes('context window') ||
    message.includes('maximum context') ||
    message.includes('too large') ||
    message.includes('payload too large') ||
    message.includes('token limit') ||
    message.includes('maximum tokens')
  ) {
    return ErrorCode.RESOURCE_LIMIT;
  }
  // 子进程 / 运行时进程
  if (message.includes('spawn') || message.includes('child process') || message.includes('exited with code')) {
    return ErrorCode.PROCESS;
  }
  // 认证 / 授权
  if (message.includes('unauthorized') || message.includes('authentication')) return ErrorCode.AUTH;
  if (message.includes('forbidden') || message.includes('permission denied')) return ErrorCode.PERMISSION;
  // 文件系统
  if (message.includes('no such file') || message.includes('enoent') || message.includes('file system')) {
    return ErrorCode.FILESYSTEM;
  }
  // 网络
  if (
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('econnreset') ||
    message.includes('dns') ||
    // 裸 'connection' 过宽（'connection pool exhausted' 等非网络断连），
    // 只匹配真正的网络断连语义。
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('connection timed out')
  ) {
    return ErrorCode.NETWORK;
  }
  // 服务不可用 / 服务端
  if (message.includes('service unavailable')) return ErrorCode.UNAVAILABLE;
  if (message.includes('internal server error')) return ErrorCode.SERVER;
  // 请求 / 协议
  if (message.includes('not found')) return ErrorCode.NOT_FOUND;
  if (message.includes('conflict')) return ErrorCode.CONFLICT;
  if (message.includes('invalid request') || message.includes('bad request') || message.includes('validation')) {
    return ErrorCode.INVALID_REQUEST;
  }
  return undefined;
}

/**
 * 分类主流程：按信号稳定度从强到弱依次尝试，全部落空归 UNKNOWN。
 * 顺序—— error.name(结构化) → Node err.code(结构化) → HTTP status(结构化) → 语义关键词。
 * name/code 先行是因为 AbortError / ETIMEDOUT 等是明确信号，不应被消息里的噪声词覆盖。
 */
function resolveCode(error: unknown): ErrorCode {
  const name = extractName(error);
  const message = extractMessage(error);

  if (name !== undefined) {
    const byName = classifyByName(name, message);
    if (byName !== undefined) return byName;
  }

  const nodeCode = extractNodeCode(error);
  if (nodeCode !== undefined) {
    const byNodeCode = classifyByNodeCode(nodeCode, message);
    if (byNodeCode !== undefined) return byNodeCode;
  }

  const status = extractStatus(error);
  if (status !== undefined) {
    const byStatus = classifyByStatus(status);
    if (byStatus !== undefined) return byStatus;
  }

  const byKeyword = classifyByKeyword(message);
  if (byKeyword !== undefined) return byKeyword;

  return ErrorCode.UNKNOWN;
}

/**
 * 纯函数默认实现：无状态、无闭包捕获可变量，可作为默认单例复用。
 * classify 永不抛出——resolveCode 内所有提取器对任意输入安全返回。
 */
export const defaultErrorClassifier: ErrorClassifier = {
  classify(error: unknown): ClassifiedError {
    const code = resolveCode(error);
    return {
      code,
      messageKey: SK_MESSAGE_KEYS[code],
      retryable: RETRYABLE_CODES.has(code),
      cause: error,
    };
  },
};
