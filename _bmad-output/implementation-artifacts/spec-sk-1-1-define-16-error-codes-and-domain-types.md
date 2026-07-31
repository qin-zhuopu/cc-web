---
title: 'S1 地基 + sk-1-1 定义 16 类错误码与领域类型'
type: 'feature'
created: '2026-07-31'
status: 'done'
baseline_commit: '8d56e4ffea87f52d730ead4615542bdf59ad93b2'
review_loop_iteration: 0
context:
  - '{project-root}/docs/contexts/shared-kernel/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-sk-1/SPEC.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** monorepo 已声明 workspaces 但 `packages/` 为空，没有核心包脚手架、没有测试运行器、没有边界门禁；同时 sk-1-1 需要把 16 类结构化错误落成 Shared Kernel 的稳定类型契约。本轮真实目的是验证 bmad-dev-auto 全自动链路能否走通，因此地基与门禁必须真正立起来、`npm run test` 必须能跑。

**Approach:** 建 `packages/core`（核心包，零框架）与 `apps/api`（NestJS 侧仅留骨架），配好 TypeScript、Vitest 测试运行器、lint；落地一条扫描 `packages/core` 的 import 静态守卫（命中 `@nestjs/*`、`better-sqlite3`、`@anthropic-ai/*`、`uuid` 或直调 `Date.now`/`randomUUID` 即失败）并纳入 `npm run test` 门禁；在 `packages/core` 的 `domain/error/` 下实现 `ErrorCode` 枚举（16 类）与不可变 `ClassifiedError` 值对象，仅类型与常量，不含分类逻辑。

## Boundaries & Constraints

**Always:**
- `packages/core` 全程零框架 import；`domain/error/` 下 0 框架 import。
- `ErrorCode` 精确含 architecture.md §3.1 全部 16 类，名称与值逐字一致，不增删改名。
- `ClassifiedError` 为不可变值对象（全字段 `readonly`），含 `code` / `messageKey` / `retryable` / `cause?` / `detail?`。
- import 静态守卫必须真正生效并纳入根 `npm run test` 门禁（故意注入违规 import 能让门禁失败）。
- 术语纪律：禁止用「上下文」指代 bounded context；指代模块用全称（Shared Kernel / Conversation / AgentRuntime）或「领域边界」。全程中文。

**Ask First:**
- 若需引入本轮范围外的运行时依赖（如真实 i18n 库、NestJS 运行时装配）。
- 若 architecture.md §3.1 的 16 类清单需要任何增删改（须走 correct-course）。

**Never:**
- 不实现 `ErrorClassifier` 分类逻辑（sk-1-2）、不做 `SK_MESSAGE_KEYS` 常量表（sk-1-3）。
- 不实现 Clock / IdGenerator / Platform（SK-2）或任何其它领域边界。
- 不接 NestJS DI、不实现真实 i18n 文案表、不做 apps/api 业务逻辑（仅骨架）。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 错误码枚举完整性 | 读取 `ErrorCode` 枚举全部键 | 恰好 16 个键，与 §3.1 名称/值逐字一致 | N/A |
| 值对象契约 | 构造 `ClassifiedError` 字面量 | 类型检查通过，`code`/`messageKey`/`retryable` 必填，`cause`/`detail` 可选 | 缺必填字段编译期报错 |
| 门禁-合法核心代码 | `packages/core` 无违规 import | 静态守卫 0 命中，`npm run test` 通过 | N/A |
| 门禁-违规 import | 在 core 写 `import '@nestjs/common'` | 静态守卫命中报错，`npm run test` 失败 | 非零退出码 + 明确报错文件/规则 |

</frozen-after-approval>

## Code Map

现状：`packages/core` 与 `apps/api`、`apps/web` 目录均为空；根 `package.json` 已声明 `workspaces: ["apps/*","packages/*"]`（`private: true`，无脚本、无依赖）；根无 tsconfig、无 lint 配置。Node v22.22.0 / npm 10.9.4。

- `package.json`（根）-- 已有 workspaces；需补 `scripts.test`（串联 typecheck + 门禁 + 单测）、`scripts.lint`、devDependencies（typescript / vitest / tsx 等）。
- `packages/core/`（空）-- 新建核心包：`package.json`、`tsconfig.json`、`src/domain/error/{error-code.ts,classified-error.ts}`、`src/index.ts`（桶文件，仅导出领域类型）、单测 `src/domain/error/*.test.ts`。
- `apps/api/`（空）-- 新建 NestJS 侧骨架：`package.json` + `tsconfig.json` + 占位 `src/`（本轮不接 DI，仅让 workspace 结构成立、可被 tsconfig 引用）。
- 目录结构基线见 architecture.md §2（`domain/error/error-code.ts` / `classified-error.ts` / `message-keys.ts`）；本轮只落 error-code 与 classified-error，message-keys 属 sk-1-3。
- import 守卫：新建 `scripts/check-core-imports.mjs`（零依赖 Node 脚本，正则/AST 扫描 `packages/core/src`，命中禁用清单即非零退出），根 `package.json` 的 `test` 脚本前置调用。

## Tasks & Acceptance

**Execution:**
- [x] `package.json`（根）-- 增补 `scripts.test`/`scripts.lint`/`scripts.typecheck`、devDependencies（typescript、vitest、tsx、@types/node）、tsconfig 引用 -- 让根 `npm run test` 成为门禁入口。
- [x] `tsconfig.base.json`（根）-- 建共享 TS 基线配置（strict、目标 ES2022、composite/paths），供各包 extends。
- [x] `packages/core/package.json` + `packages/core/tsconfig.json` -- 核心包声明（零运行时依赖）与本地 vitest 配置。
- [x] `packages/core/src/domain/error/error-code.ts` -- 定义 `ErrorCode` 枚举含 §3.1 全 16 类，零框架 import。
- [x] `packages/core/src/domain/error/classified-error.ts` -- 定义不可变 `ClassifiedError` 接口（`code`/`messageKey`/`retryable`/`cause?`/`detail?` 全 `readonly`）。
- [x] `packages/core/src/index.ts` -- 桶文件，仅导出 `ErrorCode` 与 `ClassifiedError`。
- [x] `packages/core/src/domain/error/error-code.test.ts` + `classified-error.test.ts` -- 断言 16 类完整/名称值一致、值对象契约。
- [x] `scripts/check-core-imports.mjs` -- 扫描 `packages/core/src` 命中禁用 import/API 即非零退出；纳入根 `test` 脚本。
- [x] `apps/api/package.json` + `apps/api/tsconfig.json` + 占位 `src/` -- NestJS 侧骨架，仅让 workspace 成立。

**Acceptance Criteria:**
- Given 干净 checkout，when 在项目根运行 `npm install && npm run test`，then 全绿：typecheck 通过、import 守卫 0 命中、sk-1-1 单测通过。
- Given `ErrorCode` 枚举，when 断言其键集合，then 恰好等于 §3.1 的 16 个名称且每个值等于其名称字符串。
- Given 在 `packages/core/src` 内故意加入 `import '@nestjs/common'`，when 运行 `npm run test`，then 门禁失败（非零退出、明确指出违规文件与规则）；删除后恢复全绿。
- Given `domain/error/` 下任一源码文件，when 检查其 import，then 0 框架 import。

## Verification

**Commands:**
- `npm install` -- expected: workspace 依赖安装成功。
- `npm run test` -- expected: typecheck + import 守卫 + vitest 全绿，退出码 0。
- 临时在 `packages/core/src/index.ts` 顶部加 `import '@nestjs/common';` 后运行 `npm run test` -- expected: 门禁失败、非零退出；随后删除该行恢复全绿（证明门禁非摆设）。

## Design Notes

- 测试运行器选 Vitest：零配置、原生 TS/ESM、单文件即可跑，契合纯单元测试（无 dev server）诉求；`npm run test` 脚本按 `typecheck → check-core-imports → vitest run` 顺序串联，任一失败即中断。
- import 守卫用零依赖 Node 脚本（非 ESLint 插件）以降低本轮地基复杂度并保证 `npm run test` 层强门禁；扫描禁用清单：`@nestjs/*`、`better-sqlite3`、`@anthropic-ai/*`、`uuid`，以及源码中直调 `Date.now`（`Date.now(`）与 `randomUUID`。后续 SK-4 的 story 4.3 可升级为 ESLint 规则，此处接口/意图保持一致。
- `ClassifiedError` 用 `interface` + 全 `readonly` 字段表达不可变值对象；`cause?: unknown`（脱敏由日志层负责）、`detail?: string`。本轮不提供构造函数或工厂（避免混入 sk-1-2 逻辑）。

## Suggested Review Order

**边界门禁（本轮最高杠杆，先看）**

- 门禁入口：串联 typecheck → 守卫 → vitest，任一失败即中断
  [`package.json:14`](../../package.json#L14)

- 守卫核心：纯函数 scanContent/extractModuleSpecifiers + CLI 主流程，命中禁用 import/API 即非零退出
  [`check-core-imports.mjs:66`](../../scripts/check-core-imports.mjs#L66)

- 健壮性三补：statSync 容错、空扫描拦截、行内注释剥离
  [`check-core-imports.mjs:129`](../../scripts/check-core-imports.mjs#L129)

**sk-1-1 领域类型契约**

- 16 类错误码枚举，逐字对齐 architecture.md §3.1
  [`error-code.ts:4`](../../packages/core/src/domain/error/error-code.ts#L4)

- 不可变 ClassifiedError 值对象，仅类型契约不含分类逻辑
  [`classified-error.ts:5`](../../packages/core/src/domain/error/classified-error.ts#L5)

- 桶文件：仅导出领域类型
  [`index.ts:2`](../../packages/core/src/index.ts#L2)

**脚手架与测试（支撑项，最后看）**

- 共享 TS strict 基线（NodeNext/composite/verbatimModuleSyntax）
  [`tsconfig.base.json:3`](../../tsconfig.base.json#L3)

- 核心包声明：零运行时依赖、ESM
  [`package.json:1`](../../packages/core/package.json#L1)

- 守卫回归测试（14 例）：锁住四条禁用规则与不误报边界
  [`check-core-imports.test.ts:29`](../../scripts/check-core-imports.test.ts#L29)

- 枚举完整性单测（16 类/名称值一致/无多余）
  [`error-code.test.ts:24`](../../packages/core/src/domain/error/error-code.test.ts#L24)

- 值对象契约单测（必填/可选字段/运行时结构）
  [`classified-error.test.ts:5`](../../packages/core/src/domain/error/classified-error.test.ts#L5)

- apps/api 骨架占位（本轮不接 DI）
  [`main.ts:4`](../../apps/api/src/main.ts#L4)
