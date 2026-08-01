---
id: SPEC-epic-sk-1
companions:
  - docs/contexts/shared-kernel/architecture.md
  - docs/contexts/shared-kernel/prd.md
  - docs/contexts/shared-kernel/epics-stories.md
sources:
  - docs/contexts/shared-kernel/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic SK-1 · 结构化错误分类

## Why

这是一个**待解的痛点**：绞杀者迁移中，错误语义散落在各 Runtime / Provider，UI 错误提示不一致、无法可靠区分「可重试」与「终态失败」。SK 是迁移第一站、无上游依赖，把 16 类结构化错误与分类能力落成核心包的稳定契约后，C2（AgentRuntime）与 C7（Provider）能统一消费，消除错误语义漂移。这是其余上下文最先依赖的地基之一，必须优先且正确交付。

## Capabilities

- **CAP-1 · 错误码与领域类型**
  - **intent:** 核心包提供稳定的 `ErrorCode` 枚举与 `ClassifiedError` 值对象，作为全项目错误的单一事实来源。
  - **success:** `ErrorCode` 含 architecture.md §3.1 列出的全部 16 类；`ClassifiedError` 含 `code`/`messageKey`/`retryable`/`cause?`/`detail?` 字段；类型定义位于 `domain/error/` 且无任何框架 import（对应 PRD AC-1、AC-10）。

- **CAP-2 · 错误分类逻辑**
  - **intent:** 上层用例可通过 `classify(error: unknown): ClassifiedError` 把任意异常映射为结构化错误。
  - **success:** 16 个代表性异常样本逐一命中预期类；无法识别归 `UNKNOWN` 且永不抛；相同输入连续分类结果一致；`retryable` 对 NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE 为 true（对应 PRD AC-1、AC-2、FR-1.2）。

- **CAP-3 · i18n 消息键常量**
  - **intent:** i18n 适配器可通过 `SK_MESSAGE_KEYS` 常量表为 16 类错误提供文案入口。
  - **success:** 每个 `ErrorCode` 对应唯一 `sk.error.*` 键（architecture.md §3.3）；键为常量、只读（对应 PRD FR-4.2）。

## Constraints

- 核心包铁律：`shared-kernel/` 下禁止 import `@nestjs/*`、`better-sqlite3`、`@anthropic-ai/*`、`uuid`，禁止直调 `Date.now`/`randomUUID`。本 epic 的产物是类型与常量契约，不含框架绑定。
- `ClassifiedError` 是值对象（不可变）；`classify` 是纯函数，同输入同输出，无副作用、无 I/O。
- 消息键只贡献 key 常量，locale 文案表由 `apps/api` 适配器层提供，SK 不含任何具体文案。
- 16 类错误码以 architecture.md §3.1 为准，不得增删或改名；新增需求走 correct-course 而非在本 epic 内擅自扩展。

## Non-goals

- 不实现 `TranslationPort` 端口本身（属 SK-4）；本 epic 只定义键常量。
- 不实现任何 locale 文案表、不接 i18n 运行时。
- 不做 C7 试点消费验证（sk-4-4，已 deferred，且本期 C7 不做）。
- 不接入 NestJS DI（属 SK-4 的 SharedKernelModule 接线）。
- 不实现 Clock/IdGenerator/Platform/Redactor/RuntimeLog（属 SK-2、SK-3）。

## Success signal

在 `packages/core` 内运行 `npm run test`，SK-1 三个故事的单测与反例 smoke 全绿：16 个异常样本各自命中预期 `ErrorCode`、未知异常归 `UNKNOWN` 不抛、同输入分类确定、每个错误码有唯一只读消息键；且禁用 import 静态扫描对 `domain/error/` 0 命中。

## Assumptions

- 假设 `packages/core` 脚手架与 `npm run test` 运行器由 S1 冲刺的 monorepo 地基任务先行就位（见 sprint-plan.md S1）；若在 sk-1-1 dispatch 时尚不存在，dev-auto 应 block 并提示先完成地基。
- 假设 architecture.md §3.1 的 16 类错误码清单为最终版本，无待决问题。
