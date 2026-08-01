---
id: SPEC-epic-sk-2
companions:
  - docs/contexts/shared-kernel/architecture.md
  - docs/contexts/shared-kernel/prd.md
  - docs/contexts/shared-kernel/epics-stories.md
sources:
  - docs/contexts/shared-kernel/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic SK-2 · 确定性基础端口（Clock / IdGenerator / Platform）

## Why

这是一个**待解的痛点**：时间、唯一 ID、平台探测的能力散落在各 Runtime / Provider，直调 `Date.now()` / `new Date()` / uuid 库导致上层用例无法确定性测试——涉及时间戳或 ID 的逻辑一旦跑单测就随机、随钟摆动，难以断言。SK 是迁移第一站、无上游依赖，把这三项横切能力端口化后，上层可在纯 Node 测试环境注入替身（冻结时钟、确定性 ID 序列）做纯逻辑测试，同时以架构铁律禁止散落的 `Date.now()`/uuid 直调进核心。E2 与 E1 并列为其余上下文最先依赖的地基（C1/C4/C9 直接消费 Clock/IdGenerator），必须优先且正确交付。

## Capabilities

- **CAP-1 · Clock 端口**
  - **intent:** 上层用例可通过 `Clock.now(): number` 获取时间（epoch 毫秒），生产由 `SystemClock` 提供真实时间，测试可注入冻结时钟。
  - **success:** 端口定义于 `ports/clock.ts`，签名 `now(): number` 返回 epoch 毫秒，与 architecture.md §4.6 一致；语义契约说明生产适配器 `SystemClock` 与测试替身冻结时钟的行为——冻结时钟两次取值返回相同值（对应 PRD AC-8、FR-6.2）。

- **CAP-2 · IdGenerator 端口**
  - **intent:** 上层用例可通过 `IdGenerator.next(): string` 生成唯一 ID，生产由 `UuidGenerator` 提供真实唯一值，测试可注入确定性序列。
  - **success:** 端口定义于 `ports/id-generator.ts`，签名 `next(): string`，与 architecture.md §4.7 一致；语义契约说明注入确定性 IdGenerator 后连续生成的 ID 与预期序列一致（对应 PRD AC-9、FR-7.2）。

- **CAP-3 · Platform 端口**
  - **intent:** 上层用例可通过 `Platform.info(): PlatformInfo` 只读获取操作系统类型、CPU 架构与运行环境标识。
  - **success:** 端口定义于 `ports/platform.ts`，`PlatformInfo` 含只读 `os`（`OsType`）/`arch`（`ArchType`）/`runtime`（`'node'`）字段，签名与 architecture.md §4.2 一致；语义契约说明返回值与实际运行环境一致、进程内稳定且只读，不可通过它修改环境状态（对应 PRD AC-11、FR-2.1/2.2/2.3）。

## Constraints

- 核心包铁律：`shared-kernel/` 下禁止 import `@nestjs/*`、`better-sqlite3`、`@anthropic-ai/*`、`uuid` 等具体框架/第三方实现，禁止在核心内直调 `Date.now()`/`new Date()`/`randomUUID`。本 epic 的产物是端口接口签名与语义契约，不含框架绑定。
- `verbatimModuleSyntax` 已启用：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。三个端口跨文件引用类型（如 `PlatformInfo`/`OsType`）时须遵守。
- 本 epic **只定义端口接口签名 + 语义契约**；具体适配器实现（`SystemClock`、`UuidGenerator`、`NodePlatform`）在 `apps/api` 适配器层，不在核心包内。测试替身（冻结时钟、确定性 ID 序列）是验证端口语义的手段，不是本 epic 的核心包产物。
- Clock 返回 epoch 毫秒（`number`），IdGenerator 返回 `string`，Platform 字段以 architecture.md §4.2/§4.6/§4.7 的类型别名为准，不得增删或改名；新增需求走 correct-course 而非在本 epic 内擅自扩展。

## Non-goals

- 不实现适配器具体实现（`SystemClock`/`UuidGenerator`/`NodePlatform` 及测试替身的落地代码属适配器层）。
- 不接入 NestJS DI（`SharedKernelModule` 的端口 token 绑定属 SK-4）。
- 不实现 Redactor / RuntimeLog（属 SK-3）。
- 不做错误分类相关能力（`ErrorCode` / `ClassifiedError` / `ErrorClassifier` / `SK_MESSAGE_KEYS` 已于 SK-1 完成）。
- 不做 C7 试点消费验证（属 SK-4）。

## Success signal

在 `packages/core` 内运行 `npm run test`，SK-2 三个故事的单测全绿：注入冻结 Clock 后两次 `now()` 返回相同值（AC-8）、注入确定性 IdGenerator 后连续 `next()` 与预期序列一致（AC-9）、Platform `info()` 返回的 `os`/`arch` 与实际运行环境一致且字段只读、进程内稳定（AC-11）；三个端口均定义于 `ports/` 且 `tsc --build` 在 `verbatimModuleSyntax` 下通过；禁用 import 静态扫描对 `ports/clock.ts`、`ports/id-generator.ts`、`ports/platform.ts` 0 命中。

## Assumptions

- 假设 `packages/core` 脚手架、`ports/` 目录与 `npm run test` 运行器已由 S1 冲刺的 monorepo 地基任务及 SK-1 交付就位；若在 sk-2-1 dispatch 时端口目录或运行器尚不可用，dev-auto 应 block 并提示先完成地基。
- 假设 architecture.md §4.2/§4.6/§4.7 的端口签名（含 `OsType`/`ArchType`/`PlatformInfo` 类型别名）为最终版本，无待决问题。
- 假设三个端口彼此独立（epics-stories.md 均标注「依赖：无」），可并行实现，本清单按 2-1→2-2→2-3 顺序列出仅为分派便利。
