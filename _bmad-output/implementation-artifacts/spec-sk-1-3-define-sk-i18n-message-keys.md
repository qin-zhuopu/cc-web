---
title: 'sk-1-3 定义 SK i18n 消息键常量'
type: 'feature'
created: '2026-07-31'
status: 'in-progress'
baseline_commit: 'd47b2d2'
review_loop_iteration: 0
context:
  - '{project-root}/docs/contexts/shared-kernel/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-sk-1/SPEC.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** sk-1-2 的 `defaultErrorClassifier` 目前用一个**私有** `MESSAGE_KEYS` 映射产出 `sk.error.*` 键，这只是临时真相源。i18n 适配器需要一张对外、只读、稳定的 `SK_MESSAGE_KEYS` 常量表作为 16 类错误的文案入口；同时必须消除 sk-1-2 内部映射与本表的重复。

**Approach:** 在 `packages/core` 的 `domain/error/message-keys.ts` 定义只读 `SK_MESSAGE_KEYS`（每个 `ErrorCode` 映射唯一 `sk.error.*` 键，逐字对齐 architecture.md §3.3），用 `as const` + `satisfies` 保证只读与全覆盖；再把 `error-classifier.ts` 的私有映射删除、改为引用 `SK_MESSAGE_KEYS`，让全项目只有一处键真相源。

## Boundaries & Constraints

**Always:**
- `SK_MESSAGE_KEYS` 为只读常量（`as const`），每个 `ErrorCode` 有且仅有一个 `sk.error.*` 键，键值逐字对齐 architecture.md §3.3。
- 键集合无重复；覆盖全部 16 类 `ErrorCode`，无遗漏、无多余。
- `error-classifier.ts` 删除私有 `MESSAGE_KEYS`，改为引用 `SK_MESSAGE_KEYS`——消除重复真相源。classify 行为与 sk-1-2 完全不变（现有单测须继续全绿）。
- 核心包铁律：零框架 import；类型-only import 用 `import type` + `.js` 扩展名（verbatimModuleSyntax）。import 守卫保持 0 命中。

**Ask First:**
- 若发现 §3.3 的键命名与 sk-1-2 内部映射不一致而需要改动任一侧的键值。

**Never:**
- 不实现 `TranslationPort` 端口本身（属 SK-4）——本故事只定义键常量。
- 不实现任何 locale 文案表、不接 i18n 运行时。
- 不接 NestJS DI。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 全覆盖 | 遍历 `ErrorCode` 全部 16 值 | 每个值在 `SK_MESSAGE_KEYS` 有对应键 | N/A |
| 唯一性 | 收集全部键值 | 16 个键互不重复 | N/A |
| 命名对齐 | 每个键值 | 形如 `sk.error.*`，与 §3.3 逐字一致 | N/A |
| 无多余键 | `SK_MESSAGE_KEYS` 的键集合 | 恰好等于 `ErrorCode` 值集合，无多余 | N/A |
| 分类器复用 | `classify` 任意样本 | messageKey 取自 `SK_MESSAGE_KEYS`，行为与 sk-1-2 一致 | N/A |

</frozen-after-approval>

## Code Map

- `packages/core/src/domain/error/error-code.ts` -- 已有 `ErrorCode` 枚举（16 类），本故事键表的键来源。
- `packages/core/src/domain/error/message-keys.ts` -- 新建：只读 `SK_MESSAGE_KEYS` 常量表（architecture.md §3.3 全 16 键）。
- `packages/core/src/domain/error/message-keys.test.ts` -- 新建：全覆盖 / 唯一性 / 命名 / 无多余键断言。
- `packages/core/src/ports/error-classifier.ts` -- 现有私有 `MESSAGE_KEYS`（第 28-45 行）删除，改 import `SK_MESSAGE_KEYS`；`classify` 的 messageKey 取值改为 `SK_MESSAGE_KEYS[code]`。
- `packages/core/src/index.ts` -- 桶文件，追加导出 `SK_MESSAGE_KEYS`。
- `docs/contexts/shared-kernel/architecture.md` -- §3.3 是键命名的权威来源。

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/domain/error/message-keys.ts` -- 定义只读 `SK_MESSAGE_KEYS`，16 类各唯一 `sk.error.*` 键，逐字对齐 §3.3；用 `satisfies Readonly<Record<ErrorCode, string>>` 保证全覆盖与类型安全。
- [ ] `packages/core/src/ports/error-classifier.ts` -- 删除私有 `MESSAGE_KEYS`，import 并引用 `SK_MESSAGE_KEYS`；classify 行为不变。
- [ ] `packages/core/src/domain/error/message-keys.test.ts` -- 断言：每个 ErrorCode 有唯一键、键集合无重复、键形如 `sk.error.*`、键集合恰好等于 ErrorCode 值集合（无多余）。
- [ ] `packages/core/src/index.ts` -- 追加导出 `SK_MESSAGE_KEYS`。

**Acceptance Criteria:**
- Given `ErrorCode` 全部 16 值，when 查 `SK_MESSAGE_KEYS`，then 每个值有且仅有一个 `sk.error.*` 键，键集合无重复、无多余。
- Given 键命名，when 与 architecture.md §3.3 比对，then 逐字一致。
- Given sk-1-2 现有分类器单测，when `error-classifier.ts` 改为引用 `SK_MESSAGE_KEYS`，then 全部继续通过（行为零变化）。
- Given 全部改动，when `npm run test`，then typecheck + import 守卫 0 命中 + 全部单测通过，退出码 0。

## Verification

**Commands:**
- `npm run test` -- expected: typecheck + import 守卫 0 命中 + vitest 全绿，退出码 0。

## Design Notes

- §3.3 权威键映射（逐字）：NETWORK→`sk.error.network`、TIMEOUT→`sk.error.timeout`、RATE_LIMIT→`sk.error.rateLimit`、AUTH→`sk.error.auth`、PERMISSION→`sk.error.permission`、INVALID_REQUEST→`sk.error.invalidRequest`、NOT_FOUND→`sk.error.notFound`、CONFLICT→`sk.error.conflict`、SERVER→`sk.error.server`、UNAVAILABLE→`sk.error.unavailable`、QUOTA_EXCEEDED→`sk.error.quotaExceeded`、RESOURCE_LIMIT→`sk.error.resourceLimit`、FILESYSTEM→`sk.error.filesystem`、PROCESS→`sk.error.process`、ABORTED→`sk.error.aborted`、UNKNOWN→`sk.error.unknown`。
- 用 `as const` 得到字面量类型 + 只读；再 `satisfies Readonly<Record<ErrorCode, string>>` 让「漏掉任一 ErrorCode」变成编译错误，把全覆盖约束前移到类型层。
- sk-1-2 的私有 `MESSAGE_KEYS` 与本表逐字相同（sk-1-2 已按 §3.3 定稿），故收敛为引用后 classify 行为零变化，风险极低。
