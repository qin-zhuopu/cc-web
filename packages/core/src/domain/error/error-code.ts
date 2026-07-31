// domain/error/error-code.ts
// SK 共享内核：16 类结构化错误码。零框架 import，仅类型与常量。
// 清单以 architecture.md §3.1 为准，不得增删或改名。
export enum ErrorCode {
  // —— 网络 / 传输 ——
  NETWORK          = 'NETWORK',           // 网络不可达 / DNS / 连接失败
  TIMEOUT          = 'TIMEOUT',           // 请求超时
  RATE_LIMIT       = 'RATE_LIMIT',        // 触发限流 (429)
  // —— 认证 / 授权 ——
  AUTH             = 'AUTH',              // 认证失败 (401)
  PERMISSION       = 'PERMISSION',        // 授权不足 (403)
  // —— 请求 / 协议 ——
  INVALID_REQUEST  = 'INVALID_REQUEST',   // 客户端请求非法 (400/422)
  NOT_FOUND        = 'NOT_FOUND',         // 资源不存在 (404)
  CONFLICT         = 'CONFLICT',          // 状态冲突 (409)
  // —— 服务端 ——
  SERVER           = 'SERVER',            // 上游 5xx
  UNAVAILABLE      = 'UNAVAILABLE',       // 服务不可用 (503)
  // —— 配额 / 资源 ——
  QUOTA_EXCEEDED   = 'QUOTA_EXCEEDED',    // 配额 / 余额耗尽
  RESOURCE_LIMIT   = 'RESOURCE_LIMIT',    // 上下文长度 / 载荷过大
  // —— 本地 / 环境 ——
  FILESYSTEM       = 'FILESYSTEM',        // 本地文件 I/O 错误
  PROCESS          = 'PROCESS',           // 子进程 / 运行时进程错误
  // —— 流程控制 ——
  ABORTED          = 'ABORTED',           // 用户主动中断 / abort
  // —— 兜底 ——
  UNKNOWN          = 'UNKNOWN',           // 无法归类
}
