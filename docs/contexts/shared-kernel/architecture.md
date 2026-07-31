---
title: 六边形架构 — SK 共享内核
context: SK · Shared Kernel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：SK · 共享内核 (Shared Kernel)

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 上下文定位

SK 是六边形架构的**最底层**，被 C1–C10 全部依赖，自身依赖端口清单为"无"。它不含任何业务领域逻辑。

```
        C1  C2  C3  C4  C5  C6  C7  C8  C9  C10
          \  \   \   \  |  /   /   /   /  /
           \__\___\___\_|_/___/___/___/__/
                        ↓ 全部依赖
                 ┌──────────────┐
                 │  SK 核心包     │  packages/core/shared-kernel/
                 │  (零框架依赖)  │
                 └──────────────┘
                        ↑ 实现注入
              ┌──────────────────────┐
              │  SK 适配器 (apps/api)  │  系统时钟 / uuid / i18n 表 / 脱敏规则
              └──────────────────────┘
```

**SK 的特殊性：** 它对外提供的 7 个"端口"里，多数是**出站端口 (driven ports)** 语义——即 SK 定义接口、由适配器实现、供上层注入使用。它几乎没有传统意义的"用例 (UseCase 驱动端口)"，因为它不编排业务流程，只提供能力契约。ErrorClassifier / Redactor 也可提供纯函数默认实现（无 I/O、无框架），随核心包发布。

## 2. 目录结构

```
packages/core/shared-kernel/
├── domain/
│   ├── error/
│   │   ├── error-code.ts          # ErrorCode 枚举（16 类）
│   │   ├── classified-error.ts    # ClassifiedError 值对象
│   │   └── message-keys.ts        # SK 自身产生的 i18n 消息键常量
│   └── log/
│       └── log-entry.ts           # LogEntry / LogLevel 值对象
├── ports/
│   ├── error-classifier.ts        # ErrorClassifier 端口
│   ├── platform.ts                # Platform 端口
│   ├── redactor.ts                # Redactor 端口
│   ├── translation-port.ts        # TranslationPort 端口
│   ├── runtime-log.ts             # RuntimeLog 端口
│   ├── clock.ts                   # Clock 端口
│   └── id-generator.ts            # IdGenerator 端口
└── index.ts                       # 桶文件：仅导出端口与领域类型
```

> 具体适配器实现（`SystemClock`、`UuidGenerator`、`RegexRedactor`、`JsonTranslationTable`、`RingBufferRuntimeLog`）位于 `apps/api` 适配器层，不在核心包内。本文件给出其应满足的签名，不给实现。

## 3. 领域模型 (Domain Model)

### 3.1 ErrorCode — 16 类结构化错误

```ts
// domain/error/error-code.ts
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
```

> 16 类划分覆盖 CodePilot 现有 Runtime/Provider 常见错误面（网络、认证、限流、配额、上下文超限、进程、abort）。`ABORTED` 独立成类以支撑 C2 stream abort 语义（现有 abort/stop 高发区）在 UI 上与真实错误区分。

### 3.2 ClassifiedError — 分类结果值对象

```ts
// domain/error/classified-error.ts
export interface ClassifiedError {
  readonly code: ErrorCode;          // 稳定错误码
  readonly messageKey: string;       // 可翻译消息键，见 message-keys.ts
  readonly retryable: boolean;       // 是否值得重试（NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE=true）
  readonly cause?: unknown;          // 原始异常引用（脱敏由日志层负责）
  readonly detail?: string;          // 可选补充（已脱敏），供诊断
}
```

### 3.3 message-keys — SK 自身产生的 i18n 键

```ts
// domain/error/message-keys.ts
// SK 只定义自己产生的键；文案表由适配器提供。
export const SK_MESSAGE_KEYS = {
  [ErrorCode.NETWORK]:         'sk.error.network',
  [ErrorCode.TIMEOUT]:         'sk.error.timeout',
  [ErrorCode.RATE_LIMIT]:      'sk.error.rateLimit',
  [ErrorCode.AUTH]:            'sk.error.auth',
  [ErrorCode.PERMISSION]:      'sk.error.permission',
  [ErrorCode.INVALID_REQUEST]: 'sk.error.invalidRequest',
  [ErrorCode.NOT_FOUND]:       'sk.error.notFound',
  [ErrorCode.CONFLICT]:        'sk.error.conflict',
  [ErrorCode.SERVER]:          'sk.error.server',
  [ErrorCode.UNAVAILABLE]:     'sk.error.unavailable',
  [ErrorCode.QUOTA_EXCEEDED]:  'sk.error.quotaExceeded',
  [ErrorCode.RESOURCE_LIMIT]:  'sk.error.resourceLimit',
  [ErrorCode.FILESYSTEM]:      'sk.error.filesystem',
  [ErrorCode.PROCESS]:         'sk.error.process',
  [ErrorCode.ABORTED]:         'sk.error.aborted',
  [ErrorCode.UNKNOWN]:         'sk.error.unknown',
} as const;
```

### 3.4 LogEntry — 运行时日志条目

```ts
// domain/log/log-entry.ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly timestamp: number;   // 来自 Clock.now()
  readonly level: LogLevel;
  readonly source: string;      // 来源标识，如 'c2.stream' / 'c7.doctor'
  readonly message: string;     // 已脱敏
  readonly meta?: Readonly<Record<string, unknown>>; // 已脱敏
}
```

## 4. 端口 (Ports)

> 约定：SK 端口以出站端口 (driven port) 为主——核心定义接口，适配器实现。上层通过 DI 注入。

### 4.1 ErrorClassifier

```ts
// ports/error-classifier.ts
export interface ErrorClassifier {
  /** 将任意异常映射为结构化分类结果；永不抛出，无法识别归 UNKNOWN。 */
  classify(error: unknown): ClassifiedError;
}
```
- **实现位置：** 可随核心包提供纯函数默认实现 `defaultErrorClassifier`（无 I/O）；框架侧仅做 DI 绑定。
- **语义：** 纯函数，相同输入相同输出（FR-1.4）。
- **消费方：** C2（`SK.ErrorClassifier`）、C7（`SK.ErrorClassifier`），及任意需统一错误的上下文。

### 4.2 Platform

```ts
// ports/platform.ts
export type OsType = 'darwin' | 'win32' | 'linux' | 'unknown';
export type ArchType = 'x64' | 'arm64' | 'unknown';

export interface PlatformInfo {
  readonly os: OsType;
  readonly arch: ArchType;
  readonly runtime: 'node';      // 本机 NestJS 进程
}

export interface Platform {
  /** 返回只读平台信息，进程内稳定。 */
  info(): PlatformInfo;
}
```
- **实现位置：** 适配器 `NodePlatform`，读 `process.platform` / `process.arch`（在适配器层，核心不 import `process` 具体用法）。

### 4.3 Redactor

```ts
// ports/redactor.ts
export interface Redactor {
  /** 对字符串脱敏，返回脱敏后新串。 */
  redactString(input: string): string;
  /** 对结构化对象深度脱敏，返回脱敏后新副本，不修改原对象。 */
  redact<T>(input: T): T;
}
```
- **实现位置：** 适配器 `RegexRedactor`，持有内建规则集（API Key / Bearer / 绝对路径用户名段 / 邮箱 / 密钥前缀）。
- **语义：** 纯函数、不可变输入（FR-3.1）；占位符 `***REDACTED***`（FR-3.3）。
- **消费方：** RuntimeLog 写入、任意错误上报路径。

### 4.4 TranslationPort

```ts
// ports/translation-port.ts
export type Locale = string; // 如 'zh' | 'en'

export interface TranslationPort {
  /**
   * 按键 + 语言返回文案；支持插值参数。
   * 缺失键：返回 key 本身（不抛、不返回空串）。见 FR-4.3。
   */
  translate(key: string, locale: Locale, params?: Readonly<Record<string, string | number>>): string;
  /** 缺失键判定，供上层探测能力。 */
  has(key: string, locale: Locale): boolean;
}
```
- **实现位置：** 适配器 `JsonTranslationTable`，加载各上下文提供的文案表；SK 只贡献 `SK_MESSAGE_KEYS`。

### 4.5 RuntimeLog

```ts
// ports/runtime-log.ts
export interface RuntimeLog {
  /** 追加一条日志；message/meta 写入前自动经 Redactor 脱敏。 */
  append(entry: Omit<LogEntry, 'timestamp'>): void;
  /** 导出当前环形缓冲快照（已脱敏、时间升序）。 */
  snapshot(): ReadonlyArray<LogEntry>;
  /** 清空缓冲。 */
  clear(): void;
  /** 当前容量上限。 */
  readonly capacity: number;
}
```
- **实现位置：** 适配器 `RingBufferRuntimeLog(capacity, clock, redactor)`；有界 FIFO 覆盖（FR-5.1），O(1) 写入（NFR-6）。
- **依赖：** 内部使用 SK 的 `Clock`（取 timestamp）与 `Redactor`（脱敏）——均为 SK 内端口，不越界。

### 4.6 Clock

```ts
// ports/clock.ts
export interface Clock {
  /** 当前时刻，epoch 毫秒。 */
  now(): number;
}
```
- **实现位置：** 适配器 `SystemClock`（`Date.now()`）；测试用 `FrozenClock` / `MutableClock`。
- **规则：** 上层禁止直接 `Date.now()`，一律经 Clock（FR-6.3）。

### 4.7 IdGenerator

```ts
// ports/id-generator.ts
export interface IdGenerator {
  /** 生成全局唯一 ID。 */
  next(): string;
}
```
- **实现位置：** 适配器 `UuidGenerator`；测试用 `SequentialIdGenerator`。
- **规则：** 上层禁止直接调用 uuid/随机库，一律经 IdGenerator（FR-7.3）。

## 5. 依赖注入接线 (NestJS 侧)

SK 核心包不含框架代码。`apps/api` 提供一个 `SharedKernelModule`，把端口 token 绑定到适配器实现：

```
SharedKernelModule (apps/api)
  provides & exports:
    ErrorClassifier   → defaultErrorClassifier (或 NestErrorClassifier)
    Platform          → NodePlatform
    Redactor          → RegexRedactor
    TranslationPort   → JsonTranslationTable
    RuntimeLog        → RingBufferRuntimeLog(capacity, Clock, Redactor)
    Clock             → SystemClock
    IdGenerator       → UuidGenerator
```
其余上下文的 Module `imports: [SharedKernelModule]` 后即可注入这些端口。这符合分层铁律：核心定义接口，NestJS DI 充当接线盒。

## 6. 跨上下文契约核对

| 端口 | 消费上下文 | 契约来源（边界表） |
|---|---|---|
| ErrorClassifier | C2, C7 | context-boundaries.md：C2/C7 「依赖端口：SK.ErrorClassifier」 |
| Clock / IdGenerator | C1, C4, C9 等 | C1「SK.Clock/IdGenerator」、C4「SK.IdGenerator」 |
| Redactor / RuntimeLog / TranslationPort / Platform | 全部（横切） | SK 对外端口清单 |

**边界纪律自检：** SK 未引用任何 C1–C10 概念；RuntimeLog 内部复用的 Clock/Redactor 均为 SK 内端口，无外部依赖，无循环。

## 7. 测试策略（对应 PRD AC）

- 纯单元测试（`npm run test` 层，无 dev server）：ErrorClassifier 表驱动、Redactor 反例断言、RingBuffer 淘汰、FrozenClock/SequentialIdGenerator 注入。
- 静态检查：对 `shared-kernel/` 做禁用 import 扫描（AC-10）。
- 集成 smoke：试点 C7 消费 ErrorClassifier，验证同一 Provider 探针异常跨来源分类一致（AC-12）。
