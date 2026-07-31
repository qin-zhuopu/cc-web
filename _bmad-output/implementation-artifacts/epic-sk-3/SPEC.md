---
id: SPEC-epic-sk-3
companions:
  - docs/contexts/shared-kernel/architecture.md
  - docs/contexts/shared-kernel/prd.md
  - docs/contexts/shared-kernel/epics-stories.md
sources:
  - docs/contexts/shared-kernel/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic SK-3 · 脱敏与运行时日志（Redactor / RuntimeLog）

## Why

这是一个**待解的痛点**：敏感信息（API Key、Bearer token、绝对路径里的用户名段、邮箱、密钥前缀）散落进错误上报与日志输出，泄漏面无法收敛；同时运行时诊断日志若无界增长会吃内存，若各处自定义又会绕过脱敏。SK 作为最底层核心包，把「脱敏规则」收敛为单一事实来源（`Redactor` 端口），并把「运行时日志」定义为有界环形缓冲（`RuntimeLog` 端口）且写入路径默认经 Redactor 过滤——任何日志点无论来自哪个上下文，都经统一脱敏，且缓冲有界、写入 O(1)。这消除了敏感信息泄漏面，也让诊断快照可安全导出。E3 建立在 E1（错误+领域类型）与 E2（Clock/IdGenerator/Platform）之上：`RuntimeLog` 内部要用 SK 自己的 `Clock`（取 timestamp）与本 epic 的 `Redactor`（脱敏），两者均为 SK 内端口，不越界。

## Capabilities

- **CAP-1 · Redactor 端口与内建规则契约**
  - **intent:** 任意日志/上报点可通过 `Redactor` 对字符串与结构化对象脱敏，返回脱敏后的副本而不改动原对象，内建规则覆盖已知敏感模式。
  - **success:** 端口定义于 `ports/redactor.ts`，签名 `redactString(input: string): string` 与 `redact<T>(input: T): T`，与 architecture.md §4.3 一致；语义契约说明——内建规则集覆盖 API Key / Bearer/token / 绝对路径用户名段 / 邮箱 / 密钥前缀，脱敏后原始敏感值不出现在输出中（PRD AC-3），`redact` 返回新副本且原对象不被修改（PRD AC-4），占位符使用 `***REDACTED***` 并保留可读结构（FR-3.3）。按 architecture.md §3.4 说明，`Redactor` 可随核心包提供纯函数默认实现（无 I/O、无框架），具体规则集适配器 `RegexRedactor` 落在 apps/api 适配器层——忠实反映架构原文。

- **CAP-2 · RuntimeLog 环形缓冲端口**
  - **intent:** 诊断场景可通过有界 `RuntimeLog` 追加日志并导出快照，缓冲达容量上限后按 FIFO 淘汰最旧条目，写入为常数级开销。
  - **success:** 端口定义于 `ports/runtime-log.ts`，签名 `append(entry: Omit<LogEntry, 'timestamp'>): void` / `snapshot(): ReadonlyArray<LogEntry>` / `clear(): void` / 只读 `capacity: number`，与 architecture.md §4.5 一致；`LogEntry` / `LogLevel` 值对象定义于 `domain/log/log-entry.ts`，含只读 `timestamp`（来自 `Clock.now()`）/ `level`（`LogLevel`）/ `source` / `message` / 可选 `meta`，与 architecture.md §3.4 一致；语义契约说明——向容量为 N 的缓冲写 N+K 条仅保留最新 N 条（PRD AC-6），写入 O(1)（NFR-6），快照按时间升序。`RingBufferRuntimeLog(capacity, clock, redactor)` 具体实现在 apps/api 适配器层。

- **CAP-3 · RuntimeLog 写入自动脱敏**
  - **intent:** 写入 `RuntimeLog` 的 message/meta 必须默认经 Redactor 脱敏，无绕过路径，使导出快照不含敏感值。
  - **success:** `append` 的语义契约明确——message 与 meta 写入前自动经 `Redactor` 脱敏（架构 §4.5 端口注释、FR-5.3），向缓冲写入含敏感值的消息后 `snapshot()` 中敏感值已被脱敏（PRD AC-7，反例断言），端口不暴露任何绕过 Redactor 的写入路径（NFR-4）。此为端口契约约束，脱敏发生在 `RingBufferRuntimeLog` 适配器构造时注入的 `Redactor` 上。

## Constraints

- 核心包铁律：`shared-kernel/` 下禁止 import `@nestjs/*`、`better-sqlite3`、`@anthropic-ai/*`、`uuid` 等具体框架/第三方实现，禁止在核心内直调 `Date.now()`/`new Date()`/`randomUUID`。本 epic 的产物是端口接口签名、领域值对象（`LogEntry`/`LogLevel`）与语义契约。
- `verbatimModuleSyntax` 已启用：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。`runtime-log.ts` 跨文件引用 `LogEntry`/`LogLevel` 时须遵守。
- `RuntimeLog` 内部依赖 SK 自己的 `Clock`（取 timestamp，SK-2.1 已完成）与本 epic 的 `Redactor`（脱敏，本 epic 3.1）——二者均为 SK 内端口，不越界、无外部依赖、无循环（架构 §4.5/§6）。本 epic 只定义端口契约与 timestamp 来源约定，不在核心包内实现环形缓冲的落地代码。
- 本 epic **定义端口接口签名 + 领域值对象 + 语义契约**；具体适配器实现（`RegexRedactor`、`RingBufferRuntimeLog`）在 apps/api 适配器层。按 architecture.md §3.4 原文，`Redactor` 允许随核心包提供纯函数默认实现——不自作主张扩展或收窄该结论。
- 端口签名、`LogEntry` 字段以 architecture.md §3.4/§4.3/§4.5 为准，不得增删或改名；新增敏感模式或字段走 correct-course 而非在本 epic 内擅自扩展。

## Non-goals

- 不实现 `TranslationPort` 端口（属 SK-4）。
- 不接入 NestJS DI（`SharedKernelModule` 的端口 token 绑定属 SK-4）。
- 不实现禁用 import 静态检查守卫（属 SK-4）。
- 不做 C7 试点消费验证（属 SK-4）。
- 不重做已完成的 SK-1（`ErrorCode`/`ClassifiedError`/`ErrorClassifier`/`SK_MESSAGE_KEYS`）与 SK-2（`Clock`/`IdGenerator`/`Platform`）能力；本 epic 复用 SK-2 的 `Clock` 端口，但不修改它。

## Success signal

在 `packages/core` 内运行 `npm run test`，SK-3 三个故事的单测全绿：对含 API Key/token/绝对路径/邮箱的样本脱敏后原始敏感值不出现在输出中（AC-3）、`redact` 返回新副本原对象不被修改（AC-4）；向容量为 N 的 `RuntimeLog` 写 N+K 条后 `snapshot()` 仅保留最新 N 条（AC-6）、`LogEntry` 携带来自 Clock 的 timestamp 与 level/source/message/meta；向 `RuntimeLog` 写入含敏感值消息后 `snapshot()` 中敏感值已脱敏（AC-7）；`Redactor` 定义于 `ports/redactor.ts`、`RuntimeLog` 定义于 `ports/runtime-log.ts`、`LogEntry`/`LogLevel` 定义于 `domain/log/log-entry.ts`，`tsc --build` 在 `verbatimModuleSyntax` 下通过，禁用 import 静态扫描对这些文件 0 命中。

## Assumptions

- 假设 `packages/core` 脚手架、`ports/` 与 `domain/log/` 目录、`npm run test` 运行器已由 S1 冲刺地基与 SK-1/SK-2 交付就位；SK-2.1 的 `Clock` 端口（`ports/clock.ts`）已存在，本 epic 直接引用其签名。若在 dispatch sk-3-2 时 `Clock` 端口尚不可用，dev-auto 应 block 并提示先完成 SK-2.1。
- 假设 architecture.md §3.4/§4.3/§4.5 的签名（`Redactor`、`RuntimeLog`、`LogEntry`/`LogLevel`）为最终版本，无待决问题。
- 假设故事间存在依赖链（见 epics-stories.md）：3.2 依赖 3.1（Redactor）与 SK-2.1（Clock），3.3 依赖 3.1 与 3.2，故本清单按 3-1→3-2→3-3 顺序列出，不可乱序。
