---
title: 'sk-1-2 实现 ErrorClassifier 分类逻辑'
type: 'feature'
created: '2026-07-31'
status: 'done'
baseline_commit: 'c7528c7'
review_loop_iteration: 0
context:
  - '{project-root}/docs/contexts/shared-kernel/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-sk-1/SPEC.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** sk-1-1 已落地 `ErrorCode`（16 类）与不可变 `ClassifiedError` 值对象，但还没有把任意底层异常映射为结构化错误的能力。上层用例（C2/C7）需要一个稳定的 `classify(error: unknown): ClassifiedError` 作为错误语义的单一入口，消除各自解析原始异常字符串的漂移。

**Approach:** 在 `packages/core` 的 `ports/error-classifier.ts` 定义 `ErrorClassifier` 端口接口，并随核心包提供纯函数默认实现 `defaultErrorClassifier`（无 I/O、无框架、同输入同输出）。分类逻辑按稳定特征（错误名/状态码/错误码/消息模式）把异常归入 16 类之一，无法识别归 `UNKNOWN` 且永不抛出。

## Boundaries & Constraints

**Always:**
- `classify(error: unknown): ClassifiedError` 是纯函数：同输入同输出、无副作用、无 I/O、不依赖时间/随机。
- 无法识别的异常必须归 `UNKNOWN` 且**永不抛出**（含 null/undefined/字符串/数字/对象等任意输入）。
- `retryable` 对 `NETWORK`/`TIMEOUT`/`RATE_LIMIT`/`UNAVAILABLE` 为 `true`，其余为 `false`。
- 每个分类结果必须携带 `code` + `messageKey` + `retryable`，并把原始输入放入 `cause`。
- `messageKey` 取 `sk.error.*` 形式且与 `ErrorCode` 一一对应（命名对齐 architecture.md §3.3）。本故事用内部映射产出；sk-1-3 再收敛为只读常量表并让此处引用（避免重复真相源）。
- 核心包铁律：零框架 import；类型-only import 用 `import type` + `.js` 扩展名（verbatimModuleSyntax）。import 守卫须保持 0 命中。

**Ask First:**
- 若判定某异常样本需要新增/改动 `ErrorCode`（走 correct-course，不在本故事内扩展 16 类）。
- 若要引入运行时依赖或把 messageKey 常量表提前在本故事落地（属 sk-1-3）。

**Never:**
- 不定义 `SK_MESSAGE_KEYS` 只读常量表（属 sk-1-3）——本故事仅内部产出键，不对外导出常量表。
- 不实现 Clock/IdGenerator/Platform/Redactor（SK-2、SK-3）。
- 不接 NestJS DI（属 SK-4 的 SharedKernelModule 接线）。
- 不做真实 i18n 文案表。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 16 类代表样本 | 每类一个代表性异常（见 Design Notes 样本表） | 逐一命中预期 `ErrorCode`，携带对应 `messageKey` 与 `retryable` | N/A |
| 可重试标记 | NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE 样本 | `retryable === true` | N/A |
| 不可重试标记 | 其余 12 类样本 | `retryable === false` | N/A |
| 未知异常兜底 | `null` / `undefined` / `42` / `{}` / `Symbol()` | 归 `UNKNOWN`，`retryable === false`，不抛 | 永不抛出 |
| 确定性 | 同一异常连续分类 100 次 | 100 次结果完全相等（深比较 code/messageKey/retryable） | N/A |
| 原始引用保留 | 任意 `Error` 实例 | 结果 `cause` 严格等于原始输入 | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/domain/error/error-code.ts` -- 已有 `ErrorCode` 枚举（16 类），本故事只读引用。
- `packages/core/src/domain/error/classified-error.ts` -- 已有不可变 `ClassifiedError` 接口，分类结果的返回类型。
- `packages/core/src/ports/error-classifier.ts` -- 新建：`ErrorClassifier` 端口接口（architecture.md §4.1 签名）+ 纯函数 `defaultErrorClassifier` 实现。
- `packages/core/src/ports/error-classifier.test.ts` -- 新建：16 类样本表驱动 + UNKNOWN 兜底 + 确定性 + retryable 断言。
- `packages/core/src/index.ts` -- 已有桶文件，追加导出 `ErrorClassifier` 类型与 `defaultErrorClassifier`。
- `docs/contexts/shared-kernel/architecture.md` -- §3.1 错误码语义、§3.3 消息键命名、§4.1 ErrorClassifier 端口契约的权威来源。
- `scripts/check-core-imports.mjs` -- 现有 import 守卫，新文件必须保持 0 命中。

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/error-classifier.ts` -- 定义 `ErrorClassifier` 端口 + 纯函数 `defaultErrorClassifier`：按稳定特征把 `unknown` 归入 16 类，UNKNOWN 兜底不抛，retryable 规则如上，cause 保留原始输入，messageKey 走内部 `sk.error.*` 映射（覆盖全 16 类）。
- [x] `packages/core/src/ports/error-classifier.test.ts` -- 表驱动测试：16 类代表样本逐一命中、retryable 正负例、UNKNOWN 兜底（含非 Error 输入）、确定性（同输入 100 次相等）、cause 保留。
- [x] `packages/core/src/index.ts` -- 追加导出 `ErrorClassifier`（type）与 `defaultErrorClassifier`。

**Acceptance Criteria:**
- Given 16 个代表性异常样本，when 逐一 `classify`，then 各自命中预期 `ErrorCode` 且携带对应 `messageKey`（`sk.error.*`）与正确 `retryable`。
- Given 任意非可识别输入（null/undefined/原始值/空对象），when `classify`，then 返回 `UNKNOWN` 且不抛出。
- Given 同一异常，when 连续 `classify` 100 次，then 每次结果三字段（code/messageKey/retryable）完全一致。
- Given NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE 之一，when `classify`，then `retryable === true`；其余 12 类为 `false`。
- Given 新增文件，when `npm run test`，then typecheck + import 守卫 0 命中 + 全部单测通过，退出码 0。

## Verification

**Commands:**
- `npm run test` -- expected: typecheck + import 守卫 0 命中 + vitest 全绿，退出码 0。

## Design Notes

- 端口签名严格对齐 architecture.md §4.1：`interface ErrorClassifier { classify(error: unknown): ClassifiedError; }`；默认实现导出为 `defaultErrorClassifier: ErrorClassifier`（或等价纯函数对象）。
- 分类**只依赖稳定特征**，禁止脆弱的整串消息精确匹配作为唯一依据：优先级建议 —— 先看结构化信号（HTTP `status`/`statusCode`、Node `err.code` 如 `ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND`/`EACCES`/`ENOENT`、`AbortError`/`err.name === 'AbortError'`），再看语义关键词。示例映射：`ETIMEDOUT`/`AbortError`(超时语境)→TIMEOUT，`ECONNREFUSED`/`ENOTFOUND`/`ECONNRESET`→NETWORK，status 401→AUTH，403→PERMISSION，400/422→INVALID_REQUEST，404→NOT_FOUND，409→CONFLICT，429→RATE_LIMIT，5xx→SERVER，503→UNAVAILABLE，`ENOENT`/`EACCES`(文件语境)→FILESYSTEM，子进程/spawn 错误→PROCESS，abort/取消→ABORTED，配额/余额/quota→QUOTA_EXCEEDED，上下文超限/payload too large→RESOURCE_LIMIT。样本表由实现者按此定稿，务必 16 类各至少一例。
- messageKey 命名逐字对齐 §3.3（如 `ErrorCode.RATE_LIMIT → 'sk.error.rateLimit'` 的驼峰化）。本故事用一个内部 `const` 映射产出；**不导出为公共常量表**，sk-1-3 落地 `SK_MESSAGE_KEYS` 后此处改为引用它，消除重复。
- `defaultErrorClassifier` 必须无状态、无闭包捕获可变量，确保确定性与可作为默认单例复用。

## Suggested Review Order

- 分类主流程：信号优先级 name → node code → status → keyword → UNKNOWN
  [`error-classifier.ts:218`](../../packages/core/src/ports/error-classifier.ts#L218)

- 纯函数默认实现：无状态、cause 保留、结构上永不抛
  [`error-classifier.ts:249`](../../packages/core/src/ports/error-classifier.ts#L249)

- HTTP 状态映射（评审后修：408/504→TIMEOUT、502→UNAVAILABLE 置于 >=500 之前）
  [`error-classifier.ts:97`](../../packages/core/src/ports/error-classifier.ts#L97)

- Node err.code 映射（评审后修：spawn 语境优先于 ENOENT/EACCES；EPIPE→NETWORK）
  [`error-classifier.ts:114`](../../packages/core/src/ports/error-classifier.ts#L114)

- error.name 映射（评审后修：AbortError 含超时语义归 TIMEOUT，否则 ABORTED）
  [`error-classifier.ts:146`](../../packages/core/src/ports/error-classifier.ts#L146)

- 语义关键词兜底（评审后修：裸 'connection' 收紧为 refused/reset/timed out）
  [`error-classifier.ts:149`](../../packages/core/src/ports/error-classifier.ts#L149)

- 端口接口 + 内部 messageKey 映射（sk-1-3 将收敛为只读常量表）
  [`error-classifier.ts:20`](../../packages/core/src/ports/error-classifier.ts#L20)

- 表驱动测试（16 类样本 + retryable 正负 + UNKNOWN 兜底 + 确定性 + cause）
  [`error-classifier.test.ts:135`](../../packages/core/src/ports/error-classifier.test.ts#L135)

- 桶文件导出
  [`index.ts:1`](../../packages/core/src/index.ts#L1)

## Spec Change Log

- 触发：sk-1-2 对抗评审发现 6 项分类正确性缺陷（均为 patch，不改 frozen intent）。
  修补：502/504/408 状态码归入正确语义类并修正漏重试（504/408→TIMEOUT、502→UNAVAILABLE）；`spawn ENOENT` 语境优先归 PROCESS；裸关键词 `connection` 收紧；EPIPE→NETWORK；AbortError 含超时语义改判 TIMEOUT。
  避免的已知坏态：真实网关超时/请求超时被判不可重试而静默漏重试；子进程启动失败被误显示为文件系统错误；连接池耗尽被误判为可重试网络错误。
  KEEP：信号优先级顺序（name→code→status→keyword）与纯函数无状态实现是正确设计，须保留；messageKey 内部映射不导出、留给 sk-1-3 收敛的决策保留。
