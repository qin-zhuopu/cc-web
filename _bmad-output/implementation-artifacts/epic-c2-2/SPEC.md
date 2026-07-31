---
id: SPEC-epic-c2-2
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-2 · StreamSession 聚合根 + phase 不变量 + #578 abort 反例回归

## Why

CodePilot 现有 stop/abort 卡死的根因是**运行时相位判断散落且靠人工纪律**：每条中断分支都要「记得翻状态」，interrupt 一挂起就没人把回合翻终态，phase 停在 `active`、composer gate 永久锁死（GitHub #578）。C2（AgentRuntime）的招牌价值，就是把「中断不卡死」从运行时纪律升级成**结构化不变量**。

epic-c2-1 已把地基铺好：`StreamPhase`/`canTransitionPhase`/`reconcilePhase`/`TerminalReason`/`TurnArtifacts`/`buildFinalContent`/14 类 `AgentStreamEvent` 都是纯类型与无副作用纯函数。但类型契约本身不会「保证」任何运行时行为——**保证发生在聚合根里**。本 epic 落地 `StreamSession` 聚合根（architecture.md §3.2），把 §3.1 的 phase 不变量变成运行时的、无法绕过的事实：

- phase 只能经四个领域方法迁移（`markSettling`/`complete`/`abort`/`fail`），外部不得直接赋值；每个方法内部先经 c2-1 的 `canTransitionPhase` 校验，非法迁移抛 `InvalidPhaseTransition`（AC-1）。
- **abort 不变量（FR-1.4，核心）**：任意 abort 路径执行后 phase **必然**落在 terminal 子态，**绝不停在 active**——把「每条中断分支都要记得翻 phase」的人工纪律，变成聚合根不变量。
- **#578 反例回归**：这是 C2 存在的核心理由。当外部 interrupt 信号**永不 resolve/永挂**时，force-abort 安全网**无条件先行**仍能让 phase 翻 `terminal(aborted)`、`canAccept()=true`，回合不卡死。本 epic 用假 Clock + 假 Runtime 替身在纯单元层复现并回归它。

本 epic 只实现聚合根本身与其 5 项能力（聚合根壳 + snapshot、四迁移方法幂等、abort 不变量 #578 反例、canAccept 门、apply 事件累积），复用 c2-1 的纯函数做唯一判据，**不重写迁移规则**；不实现 `StartStreamService`/`AbortStreamService`/`StreamSessionRegistry` 用例编排、不接 EventMapper、不接 SDK/进程、不接 NestJS DI（分属 c2-3~c2-6）。

## Capabilities

- **CAP-1 · StreamSession 聚合根壳 + snapshot（phase 只经领域方法迁移）**
  - **intent:** 实现 `StreamSession` 可变聚合根（内存态），持有 `id`/`sessionId`/`runtimeKind`/`phase`/`artifacts`/`tokenUsage`/`error`/`terminalReason`/时间戳，构造时 `phase=active`；对外只暴露 `snapshot()` 读快照，phase 不允许外部直接赋值，只能经四个领域方法迁移，并复用 c2-1 的 `canTransitionPhase` 作为唯一迁移判据。
  - **success:** `domain/stream/stream-session.ts` 定义 `StreamSession` 与不可变 `StreamSessionSnapshot`（字段与 architecture.md §3.2 一致），构造注入 `SK.Clock` 取 `startedAt`、经 `SK.IdGenerator` 或外部传入的 `StreamSessionId`，`snapshot()` 返回只读快照；四个迁移方法内部一律经 `canTransitionPhase` 校验、非法迁移抛 `InvalidPhaseTransition`，不重写迁移规则（对应 PRD FR-1.1/1.2、AC-1，epics-stories S2.1）。

- **CAP-2 · 四迁移方法幂等（markSettling / complete / abort / fail）**
  - **intent:** 实现 `markSettling`（active→settling）、`complete`（*→terminal(completed)）、`abort`（*→terminal(aborted)）、`fail`（*→terminal(errored)）四个迁移方法，每个内部先 `canTransitionPhase` 校验合法迁移，终态时记录 `settledAt`/`error`/`terminalReason`/`tokenUsage`，并**幂等**：已 terminal 时 no-op（不回退、不二次翻）。
  - **success:** 四方法与 architecture.md §3.2 签名一致；`complete(tokenUsage?)` 记录 usage 投影（无值不填 0）、`abort(reason)` 归 `ABORTED`、`fail(error)` 记录分类错误；已 terminal 调用任一方法为 no-op；单测覆盖合法迁移矩阵 + 幂等断言（对应 PRD FR-1.2/1.3/1.5，AC-1，epics-stories S2.2）。

- **CAP-3 · abort 不变量 + #578 force-abort 无条件先行反例回归**
  - **intent:** 把 abort 不变量落成聚合根保证——任意 abort 路径后 phase ∈ terminal 子态、绝不停 active；并用假 Clock + 假 Runtime 替身复现 GitHub #578：外部 interrupt 信号**永不 resolve/永挂**时，force-abort 安全网**无条件先行**（早于且独立于 interrupt）仍让 phase 翻 `terminal(aborted)`、`canAccept()=true`，回合不卡死。
  - **success:** 反例回归用例注入「`interrupt` 返回永不 resolve 的 Promise」的假 Runtime，用假 Clock 推进 force-abort 定时器，断言推进后 `session.snapshot().phase = terminal(aborted)`、`canAccept()=true`；断言 force-abort 安排早于 interrupt、不依赖 interrupt resolve；abort 归 `ABORTED` 独立类。与 architecture.md §3.2（abort 不变量）/§4.2/§6.3 一致（对应 PRD FR-1.4/3.2，AC-2/AC-4，epics-stories S2.3）。

- **CAP-4 · canAccept() 门（≡ phase !== active）**
  - **intent:** 实现 `canAccept(): boolean`，语义 ≡ `phase.kind !== ACTIVE`（`settling`/`terminal` 均可接受新发送），作为 composer「能否发送」的唯一领域判据；核心内不散落 `phase==='active'` 比较被 gate 复用。
  - **success:** `canAccept()` 在 active 返回 `false`、settling/terminal 返回 `true` 全态断言；terminal 后可接新输入（gate 不再永久锁死）；与 architecture.md §3.2、prd.md FR-1.6 一致（对应 PRD AC-3，epics-stories S2.4）。

- **CAP-5 · apply(event) 累积产物到 TurnArtifacts（不改 phase）**
  - **intent:** 实现 `apply(event: AgentStreamEvent): void`，把归一后的事件累积进 `TurnArtifacts`（text/thinking/tool_use/tool_result 等），并把 `result` 事件的 `tokenUsage`/`context_usage` 投影记录进快照；`apply` **不迁移 phase**（相位迁移只经四方法），孤儿 tool_result 保留。
  - **success:** `apply` 对 text/thinking/tool_use/tool_result 累积正确、孤儿 tool_result（无匹配 tool_use）保留、`result` 事件的 usage 投影记录（无上报留空、不填 0）；`apply` 调用不改变 phase；累积结果可经 c2-1 的 `buildFinalContent` 投影；与 architecture.md §3.2/§3.4/§3.5 一致（对应 PRD FR-4/FR-2.6 支撑、AC-9，epics-stories S2.5）。

## Constraints

- **核心零框架 import（NFR-1 / AC-14）**：`packages/core/agent-runtime/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`、`codex` SDK，禁止直调 `Date.now()`/`new Date()`/`randomUUID()`。聚合根取时一律经**构造注入的 `SK.Clock`**，不直调 `Date.now()`；id 经 `SK.IdGenerator` 或外部传入。
- **`verbatimModuleSyntax` 已启用**：类型-only import 必须用 `import type`，模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。本 epic 对 c2-1 的 `StreamPhase`/`canTransitionPhase`/`reconcilePhase`/`TerminalReason`/`TurnArtifacts`/`buildFinalContent`/`AgentStreamEvent` 及 SK 的 `ClassifiedError`/`Clock`/`IdGenerator` 的引用都须遵守。
- **复用 c2-1 纯函数做唯一迁移判据，不重写规则**：四迁移方法内部一律调用 c2-1 的 `canTransitionPhase` 判定合法性，force-abort 收敛复用 `reconcilePhase`，终态产物投影复用 `buildFinalContent`，归因复用 `TerminalReason`——**不得**在聚合根内重新实现或改写这些规则；接口/类型签名以 architecture.md §3.2 为准，不增删改名，新增需求走 correct-course。
- **phase 不落库、不与 C1 持久 StreamStatus 混用（NFR-2 / AC-15，架构铁律）**：`StreamPhase` 是实时内存态，聚合根不写任何持久层、不 import/建模 C1 的 `StreamStatus`（streaming/completed/interrupted/error）做实时判断。终态→C1 映射的实现属后续 epic，本 epic 聚合根只在内存维护 phase。
- **force-abort 无条件先行**：abort 路径中 force-abort 安全网必须早于且独立于 interrupt 请求——绝不排在 interrupt 的 `.then`/`.finally` 之后（这正是 #578 根因）。本 epic 在聚合根/反例回归层面把这条落成可测断言。
- **纯单元可测**：`StreamSession` 与 abort 不变量必须用**假 `AgentRuntimePort` + 假 `SK.Clock`**做纯单元测试（无 dev server / 无真实 SDK-进程-网络），可复现 #578（interrupt 永不 settle）并断言 phase 仍翻终态、`canAccept()=true`。

## Non-goals

- 不实现 `StartStreamService`/`AbortStreamService`/`GenerateTitleService`/`StreamSessionRegistry` 等用例编排与 force-abort 先行的**编排代码**（属 epic-c2-4 StartStream / epic-c2-5 AbortStream）——本 epic 只落聚合根本身与其不变量，abort 反例回归用假 Runtime 直接驱动聚合根，不建完整 AbortStream 用例。
- 不定义/实现 EventMapper 契约与未知事件降级规则（属 epic-c2-3）——`apply` 只消费**已归一**的 `AgentStreamEvent`。
- 不接入真实 Runtime 适配器（`ClaudeSdkRuntimeAdapter`/`NativeRuntimeAdapter`/`CodexRuntimeAdapter`）与 SDK/进程/HTTP（属 epic-c2-6）。
- 不接入 NestJS DI（`AgentRuntimeModule`、`forwardRef`、Controller）与终态→C1 `StreamStatus` 映射的实现（属后续 epic）。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿，且 `tsc --build` 在 `verbatimModuleSyntax` 下通过；禁用 import 静态守卫对新增聚合根文件 0 命中（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`Date.now`/`randomUUID`）。五个故事各自单测通过：`StreamSession` 构造 phase=active、snapshot 只读、phase 只经领域方法迁移；四迁移方法合法迁移矩阵 + 幂等（terminal 后 no-op）；`canAccept()` ≡ `phase !== active` 全态断言；`apply` 累积 text/thinking/tool/孤儿 tool_result 正确且不改 phase、usage 无上报留空。**#578 核心反例回归通过**：注入「interrupt 永不 resolve」的假 Runtime，用假 Clock 推进 force-abort 定时器后，`phase = terminal(aborted)`、`canAccept()=true`，回合不卡死（GitHub #578 结构化切断）。

## Assumptions

- 假设 epic-c2-1 已交付并稳定：`StreamPhase`/`StreamPhaseKind`/`TerminalSubstate`/`isActive`/`isTerminal`/`StreamSessionId`（`domain/stream/stream-phase.ts`）、`canTransitionPhase`/`reconcilePhase`（`phase-transition.ts`）、`TerminalReason`/`TerminalReasonCode`（`terminal-reason.ts`）、`TurnArtifacts`/`buildFinalContent`（`turn-artifacts.ts`）、14 类 `AgentStreamEvent`（`domain/event/agent-stream-event.ts`）签名为最终版本，本 epic 复用不改写；若尚不可用，dev-auto 应 block。
- 假设 SK 已交付 `ErrorClassifier`（16 类含 `ABORTED`）、`Clock`、`IdGenerator` 端口与语义稳定，聚合根经 `import type` 引用其接口类型、经构造注入使用（假替身在测试中提供）。
- 假设 `packages/core` 脚手架、`npm run test` 运行器与 `tsc --build` 增量构建已就位；聚合根用例编排（StartStream/AbortStream）留待 c2-4/c2-5，本 epic 的 abort 反例回归以假 Runtime + 假 Clock 直接驱动聚合根，不依赖尚未实现的用例。
