---
id: SPEC-epic-sk-4
companions:
  - docs/contexts/shared-kernel/architecture.md
  - docs/contexts/shared-kernel/prd.md
  - docs/contexts/shared-kernel/epics-stories.md
sources:
  - docs/contexts/shared-kernel/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic SK-4 · i18n 端口、DI 接线与守卫

## Why

SK 前三个 epic 已把错误分类、确定性基础端口、脱敏与运行时日志沉成核心包里的 6 个端口，但它们此刻只是「悬空」的接口——没有一条把核心契约接到 NestJS 运行期的注入链路，上层上下文无从消费；同时 16 类错误的 `messageKey` 也还缺一个按键出文案的端口来兑现。本 epic 做三件收尾的事：补上第 7 个端口 `TranslationPort`（i18n 键出文案，缺失键返回键名而非抛错或空串），在 `apps/api` 装配 `SharedKernelModule` 把 7 个端口 token 绑定到适配器并导出（这是 SK 唯一带框架的部分），并把「核心包零框架依赖」这条分层铁律固化为一条纳入 `npm run test` 门禁的 import 静态守卫，防止框架/第三方实现日后腐蚀核心。三者合起来打通「核心定义接口 → DI 充当接线盒 → 上层 imports 即注入」的完整链路，是 SK 从「一堆接口」变成「可被 C1–C10 消费的地基」的最后一公里。

## Capabilities

- **CAP-1 · TranslationPort 端口**
  - **intent:** 上层用例可通过 `translate(key, locale, params?)` 按（消息键 + 语言 + 可选插值参数）取文案，通过 `has(key, locale)` 探测键是否存在；SK 仅贡献 `SK_MESSAGE_KEYS`，具体文案表由适配器提供。
  - **success:** 端口定义于 `ports/translation-port.ts`，签名与 architecture.md §4.4 一致——`translate(key: string, locale: Locale, params?: Readonly<Record<string, string | number>>): string` 与 `has(key: string, locale: Locale): boolean`，并导出 `Locale` 类型别名；语义契约说明缺失键返回 key 本身、不抛异常、不返回空串（对应 PRD AC-5、FR-4.3），支持插值参数（FR-4.1），文案表由适配器提供而非核心包内置（FR-4.2）。

- **CAP-2 · SharedKernelModule 依赖注入接线**
  - **intent:** 其余上下文的 Module 可 `imports: [SharedKernelModule]` 后注入 SK 全部 7 个端口，无需知道适配器实现。
  - **success:** `SharedKernelModule` 位于 `apps/api` 适配器层，把 7 个端口 token（`ErrorClassifier`/`Platform`/`Redactor`/`TranslationPort`/`RuntimeLog`/`Clock`/`IdGenerator`）全部 `providers` 绑定到对应适配器实现并 `exports`，绑定清单与 architecture.md §5 一致；核心包 `packages/core` 内不出现任何 `@nestjs/*` import，框架绑定只在 `apps/api`（对应 PRD AC-10、NFR-1）。RuntimeLog 的适配器构造依赖同模块内的 `Clock` 与 `Redactor` token。

- **CAP-3 · 禁用 import 静态检查守卫**
  - **intent:** 对 `packages/core` 源码做禁用 import / 禁用运行时 API 的静态扫描，命中即失败，作为分层铁律的自动化门禁防止腐蚀。
  - **success:** 守卫扫描 `@nestjs/*`/`better-sqlite3`/`@anthropic-ai/*`/`uuid` 等禁用 import 及 `Date.now(`/`randomUUID` 禁用运行时 API，命中即以非零退出码失败，且已纳入根 `npm run test` 门禁（对应 PRD AC-10、NFR-1）。**该守卫已于 SK-1 提前落地**（见 `scripts/check-core-imports.mjs`，已接入 `package.json` 的 `test`/`lint` 脚本并配套 `scripts/check-core-imports.test.ts` 回归），本 capability 做**补强与 AC-10 验收对齐**而非从零实现：确认扫描根、禁用清单、空扫描保护与 `npm run test` 接线满足 AC-10/NFR-1，若发现缺口（如新增端口目录未覆盖、禁用清单与 architecture.md 铁律不一致）则补齐。

## Constraints

- `TranslationPort` 属核心包 `packages/core`，零框架依赖：仅定义端口接口签名与语义契约，不含 `JsonTranslationTable` 适配器实现，不内置任何 locale 文案表。签名以 architecture.md §4.4 为准，不得增删或改名。
- `SharedKernelModule` 是 SK **唯一**带框架的产物，只能位于 `apps/api` 适配器层；`@nestjs/*` import 只允许出现在这里，绝不允许进入 `packages/core`（AC-10 的核心断言）。7 个端口 token 的绑定清单以 architecture.md §5 为准。
- import 守卫覆盖范围是 `packages/core`（当前扫描根 `packages/core/src`）；补强不得缩小扫描范围或放宽禁用清单。空扫描（扫描根被改名/清空）必须仍视为失败，避免门禁真空放行。
- `verbatimModuleSyntax` 已启用：`translation-port.ts` 内类型-only import（如引用 `Locale`）必须用 `import type`，模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。
- 新增/变更需求走 correct-course，不在本 epic 内擅自扩展端口签名或 DI 绑定清单。

## Non-goals

- 不做 Story 4.4「试点 C7 消费 ErrorClassifier 验证」——该故事在 sprint-status.yaml 标记为 deferred，本期 C7 不做，AC-12 与 Smoke Ledger 不在本 epic 交付范围。
- 不提供具体 locale 文案表（zh/en 等文案内容），文案表由适配器/各上下文提供（FR-4.2）。
- 不实现 `JsonTranslationTable` 或其余端口适配器的内部逻辑；`SharedKernelModule` 只做 token→适配器的绑定接线，适配器本身的实现细节不在本 epic 展开约束。
- 不做前六个端口的定义（`ErrorClassifier`/`Clock`/`IdGenerator`/`Platform`/`Redactor`/`RuntimeLog` 已于 SK-1/2/3 交付）。
- 不重写 import 守卫脚本；CAP-3 仅补强与验收对齐既有 `scripts/check-core-imports.mjs`。

## Success signal

- `packages/core/src/ports/translation-port.ts` 存在，导出 `TranslationPort` 与 `Locale`，签名与 architecture.md §4.4 逐字一致；缺失键语义（返回 key 本身、不抛、不空串，AC-5）有对应单测验证；`tsc --build` 在 `verbatimModuleSyntax` 下通过。
- `apps/api` 内 `SharedKernelModule` 可被其余 Module `imports` 后注入 7 个端口；7 个 token 全部 `providers` 绑定并 `exports`，绑定清单与 architecture.md §5 一致；`packages/core` 内 `@nestjs/*` import 0 命中（AC-10）。
- 根目录 `npm run test` 全绿：typecheck → `check-core-imports`（对 `packages/core` 禁用 import/API 0 命中，AC-10/NFR-1）→ vitest；守卫的空扫描保护与禁用清单确认满足 AC-10。

## Assumptions

- 假设 SK-1/2/3 交付的 6 个端口（`ErrorClassifier`/`Clock`/`IdGenerator`/`Platform`/`Redactor`/`RuntimeLog`）接口签名已就位且为最终版本；`SharedKernelModule`（4.2）依赖这 6 个端口加本 epic 的 `TranslationPort`（4.1）全部就位，故 4.2 排在 4.1 之后。
- 假设 architecture.md §4.4 的 `TranslationPort` 签名与 §5 的 DI 绑定清单为最终版本，无待决问题。
- 假设 `apps/api` 的 NestJS 脚手架、各端口适配器（`SystemClock`/`UuidGenerator`/`NodePlatform`/`RegexRedactor`/`JsonTranslationTable`/`RingBufferRuntimeLog`/`defaultErrorClassifier`）已由地基/前序冲刺就位或可在 4.2 内一并接线；若在 sk-4-2 dispatch 时某适配器缺失，dev-auto 应 block 并提示先补齐适配器。
- 假设 import 守卫 `scripts/check-core-imports.mjs` 及其 `npm run test` 接线保持 SK-1 落地时的状态，CAP-3 以其现状为基线做补强；若已被改动，以补强恢复 AC-10 覆盖为准。
