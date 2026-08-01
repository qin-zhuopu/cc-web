---
id: SPEC-epic-c2-5
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-5 · 中断回合 AbortStream（GitHub #578 结构化切断：force-abort 无条件先行 + reconcile + 关句柄）

## Why

C2（AgentRuntime）存在的**核心理由**就是这一条：把 GitHub #578「点 stop / abort 后 composer 永久卡死」从根上切断。#578 的根因是——旧代码把「翻终态 abort」排进了优雅 interrupt 的 `.finally`，一旦 interrupt 挂起（Runtime 无响应），`.finally` 永不执行，`phase` 永远停在 `active`，`canAccept()` 永远 false，输入框永久锁死。

epic-c2-2 已在**聚合根层**落下安全网的一半：`StreamSession.abort(reason)` 命令一到即无条件同步翻 `terminal(aborted)`、`canAccept()` 立即 true，不依赖任何 interrupt 的 resolve（c2-2-3 已复现「interrupt 永挂仍翻终态」的聚合根级反例）。但**用例编排层**的另一半还空着：真正的 `AbortStreamService` 尚未落地——它要保证「force-abort 定时器**无条件先行**安排（早于且独立于 interrupt）」这一时序不变量，这正是 #578 在编排层的结构化沉淀（PRD FR-3 / NFR-3 / AC-2 / AC-4）。

本 epic 落地 `AbortStreamService.abort` 的完整中断编排（PRD FR-3 全部），全部为**纯逻辑**、可用假端口 + 假 Clock 做纯单元测试：

- **幂等门（FR-3.1）**：`phase` 非 active → 幂等返回（no-op）。
- **force-abort 安全网无条件先行（FR-3.2 / AC-4）**：先经可注入的调度抽象安排 force-abort（到期若仍 active 则 `session.abort(ABORTED)` + `runtime.forceKillTurn`），**再**发 interrupt；force-abort 的安排绝不排在 interrupt 的 `.then`/`.finally` 之后。
- **markSettling（FR-1.5）**：安排安全网后把回合标记 settling。
- **best-effort 优雅 interrupt + reconcile 收敛（FR-3.3）**：经 `AgentRuntimePort.interrupt(turnRef)` 发优雅中断，拿 Runtime 权威 `runtimeStatus` → 经 `reconcilePhase` 收敛（terminal 则翻终态，running/unknown 不纠正、交安全网兜底）；interrupt 挂起/抛错时不阻塞相位翻转（`.catch` 只吞，绝不在此翻 active）。
- **abort 归 ABORTED 独立类（FR-3.4 / AC-5）**：中断归因经 `SK.ErrorClassifier` 归 `ABORTED`，与真实错误 `ClassifiedError.code` 不同。
- **关 turn/句柄（FR-3.5 / AC-6）**：abort 通知适配器 `interrupt`/`forceKillTurn` 关闭 turn/thread/Query 句柄，防残留污染下一轮。
- **idle/tool timeout 归因（FR-3.6 / AC-5）**：idle-timeout / tool-timeout 走 abort 路径翻终态，但归因不同（TIMEOUT / PROCESS），三路 `ClassifiedError.code` 可区分。

**#578 真实端到端回归（本 epic 招牌）**：用假 `AgentRuntimePort.interrupt` 返回**永不 resolve** 的 Promise、假 Clock 推进 force-abort 定时器，断言整条 `AbortStreamService.abort` 编排走完后 `phase = terminal(aborted)`、`canAccept()=true`——即真实 interrupt 永挂时回合仍被安全网兜底翻终态、composer 立即解锁。这比 c2-2-3 的聚合根级反例更进一步：验证的是**编排层的时序不变量**（安全网先行）而非仅聚合根方法。

本 epic 只落 `AbortStreamService` 用例编排 + 一个 force-abort 调度抽象端口，全部纯逻辑。**不实现**任何具体 Runtime 适配器的 interrupt/forceKillTurn（属 c2-6）、不接 SDK/进程/HTTP、不接 NestJS DI（属 c2-7）。

## Capabilities

- **CAP-1 · force-abort 调度抽象端口（核心零框架下可 spy 的定时器，支撑 AC-4）**
  - **intent:** 核心零框架禁止直调 `setTimeout`，但 force-abort 安全网需要「延时到期触发」的能力，且 AC-4 要求能 spy「安排先行」。定义一个可注入的调度抽象（C2 driven port，如 `ForceAbortScheduler.schedule(callback, delayMs): CancelHandle`），生产实现（属 c2-7 接线）用 `setTimeout`，测试用手动触发假件（记录被安排、可手动 fire / 配合假 Clock）。
  - **success:** 新增 `ports/driven/force-abort-scheduler.ts`：接口 `schedule(callback: () => void, delayMs: number): () => void`（返回 cancel 函数）+ `FORCE_ABORT_MS` 常量（或由构造注入延时值，以 architecture §4.2 为准）。核心不 import `node:timers`/不直调 `setTimeout`。单测用假 scheduler 断言 `schedule` 被调、可手动触发回调、可取消（对应 PRD FR-3.2/AC-4、architecture §4.2 `clock-based-timeout`）。

- **CAP-2 · AbortStreamService 幂等门 + force-abort 无条件先行 + markSettling（FR-3.1/3.2/1.5 / AC-4）**
  - **intent:** 实现 `AbortStreamService implements AbortStreamUseCase`，构造注入 `AgentRuntimePort` + `StreamSessionRegistry` + `ForceAbortScheduler` + `SK.ErrorClassifier` + `SK.Clock`（对齐 architecture §8）。`abort(streamId)`：① 经 registry 取 session，无 session 或 phase 非 active → 幂等返回（FR-3.1）；② **无条件先行**经 `ForceAbortScheduler.schedule` 安排 force-abort 安全网（到期回调见 CAP-4）——这一步**必须早于且独立于**任何 interrupt 调用；③ `session.markSettling()`（FR-1.5）；④ 之后才发 interrupt（CAP-3）。
  - **success:** 单测（用假 scheduler + spy）断言：非 active 回合 abort 为 no-op（FR-3.1）；active 回合 abort 时 `scheduleForceAbort` 的调用**早于** `requestInterrupt`（AC-4，用调用序列 spy 断言）；interrupt 抛错时 force-abort 仍已安排（AC-4）；安排安全网后 `markSettling` 被调、phase = settling（对应 PRD FR-3.1/3.2、FR-1.5、AC-4，epics-stories S5.1/S5.2）。

- **CAP-3 · best-effort 优雅 interrupt + reconcilePhase 收敛（FR-3.3 / AC-2）**
  - **intent:** 安排安全网并 markSettling 后，经 `AgentRuntimePort.interrupt(turnRef)` 发 best-effort 优雅中断（turnRef 由核心以 `{ streamId }` 构造，native 句柄由适配器按 streamId 内部解析，核心不碰句柄）。interrupt 返回权威 `runtimeStatus`（`string | null`）→ 经 `reconcilePhase(runtimeStatus, currentPhase)` 收敛：返回 terminal 则据子态翻终态（complete/abort/fail 对应），返回 null（running/unknown）不纠正、交 force-abort 安全网兜底。**interrupt 挂起 / 抛错绝不阻塞相位翻转**：`.catch` 只吞错（可经 RuntimeLog 记录），绝不在此把 phase 翻回 active、绝不把 abort 排进 interrupt 的 `.finally`。
  - **success:** 单测断言：interrupt 返回 'interrupted' → reconcile 翻 terminal(aborted)；返回 'idle' → terminal(completed)；返回 'error' → terminal(errored)；返回 'running'/null → 不纠正（phase 仍 settling，等安全网）。**#578 核心回归（AC-2）**：假 interrupt 返回永不 resolve 的 Promise + 假 Clock 推进 force-abort 定时器 → 断言 `phase = terminal(aborted)`、`canAccept()=true`（interrupt 永挂仍被安全网兜底翻终态，composer 解锁）。reconcile 复用 c2-1 的 `reconcilePhase`，不重写（对应 PRD FR-3.3、AC-2，epics-stories S5.3）。

- **CAP-4 · force-abort 到期兜底：仍 active 则 abort(ABORTED) + forceKillTurn（FR-3.2/3.4/3.5 / AC-5/AC-6）**
  - **intent:** force-abort 安全网到期回调：若回合**仍 active**（interrupt 未能收敛）→ `session.abort(classified ABORTED)`（经 `SK.ErrorClassifier` 把 AbortError 归 `ABORTED`）无条件翻 terminal(aborted)，并 `runtime.forceKillTurn(turnRef)` 强制关闭 turn/句柄兜底（FR-3.5）。若回合已非 active（interrupt 已收敛 / reader 已 settle）→ 到期回调 no-op（幂等）。回合收敛后应 cancel 未到期的安全网（避免多余触发），但即便未 cancel，聚合根 abort 幂等（terminal 后 no-op）也保证安全。
  - **success:** 单测断言：interrupt 永挂 → 定时器到期 → session.abort(ABORTED)（phase=terminal(aborted)）+ forceKillTurn 被调（AC-6）；interrupt 已让回合 terminal → 定时器到期回调 no-op（幂等，不二次翻）；abort 归因 `ClassifiedError.code === ABORTED`，与真实错误 code 不同（AC-5）（对应 PRD FR-3.2/3.4/3.5、AC-5/AC-6，epics-stories S5.4/S5.5）。

- **CAP-5 · 关 turn/句柄通知 + late-unregister no-op（FR-3.5 / AC-6）**
  - **intent:** abort 路径确保适配器被通知关闭 turn/thread/Query 句柄：优雅路径经 `interrupt(turnRef)`、兜底路径经 `forceKillTurn(turnRef)`，防句柄残留导致下一轮语义错乱。核心侧只按 streamId 传 turnRef、调端口方法，不持有/不解释 native 句柄；「ClaudeCode late-unregister（旧 lockId 的 teardown 不 evict 新 turn 句柄）为 no-op」是**适配器侧**语义（属 c2-6），本 epic 在核心侧只保证「abort 必调 interrupt 和/或 forceKillTurn 通知适配器」这一契约。
  - **success:** 单测（假 AgentRuntimePort spy）断言：abort 编排走完后 `interrupt` 与（兜底路径下）`forceKillTurn` 被调、传入 turnRef.streamId 正确；核心不触碰 native 句柄结构（对应 PRD FR-3.5、AC-6，epics-stories S5.5）。late-unregister no-op 的适配器实现留待 c2-6。

- **CAP-6 · idle-timeout / tool-timeout 归因区分（FR-3.6 / AC-5）**
  - **intent:** idle-timeout（回合空闲超时）与 tool-timeout（工具执行超时）都走 abort 路径翻终态，但**归因不同**：按 architecture §6.2 / terminal-reason，idle→TIMEOUT、tool→PROCESS（或按文档权威归类）。核心侧提供把这两类超时信号归一为对应 `ClassifiedError` / `TerminalReason` 的路径（经 `SK.ErrorClassifier` 或 `terminal-reason` 映射，复用不重写）。
  - **success:** 单测断言：user-abort→ABORTED、idle-timeout→TIMEOUT、tool-timeout→PROCESS 三路 `ClassifiedError.code` / `TerminalReasonCode` 互不相同（AC-5）；三路都能翻终态、`canAccept()=true`（对应 PRD FR-3.6、AC-5，epics-stories S5.6）。**注**：真实超时的定时器触发机制（idle 计时/tool 计时）若涉及具体 Runtime 属 c2-6，本 epic 只落「给定超时信号 → 正确归因翻终态」的核心归类逻辑，不造假定时器。

## Constraints

- **核心零框架 import（NFR-1 / AC-14）**：`packages/core/src/agent-runtime/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`、`node:timers`、`codex`；**禁止直调 `setTimeout`/`setInterval`/`Date.now()`/`new Date()`/`randomUUID()`**（注释里也别连写 `Date.now(`）。force-abort 延时经 CAP-1 的可注入 `ForceAbortScheduler`，取时经注入 `SK.Clock`。
- **#578 时序铁律 · force-abort 无条件先行**：`AbortStreamService.abort` 里，force-abort 安全网的**安排**必须早于且独立于 interrupt 调用——**绝不**把 `session.abort` 或安全网安排排进 `interrupt(...).then/.finally/.catch`。interrupt 挂起/抛错时相位翻转不受影响。这是本 epic 存在的核心理由，评审重点审。
- **用例是纯编排，不接 SDK/进程/HTTP/DI**：只实现 `AbortStreamService` + `ForceAbortScheduler` 端口契约（纯逻辑），依赖全部经**构造注入的端口接口**（`AgentRuntimePort`/`StreamSessionRegistry`/`ForceAbortScheduler`/`SK.ErrorClassifier`/`SK.Clock`）。**绝不** import 任何 Runtime 适配器实现、SDK、子进程、HTTP、NestJS。适配器的 interrupt/forceKillTurn/late-unregister 具体实现属 c2-6，`AgentRuntimeModule`/`forwardRef`/Controller 与 `ForceAbortScheduler` 的 setTimeout 生产实现属 c2-7。
- **复用既有聚合根/纯函数/端口，不重定义**：`StreamSession`（c2-2）的 abort/markSettling/complete/fail/canAccept 与 `reconcilePhase`/`canTransitionPhase`（c2-1）、`TerminalReason`/`TerminalReasonCode`（c2-1）、`AgentRuntimePort`/`TurnRef`（c2-1）、`AbortStreamUseCase`（c2-1）、`SK.ErrorClassifier`（AbortError→ABORTED、timeout→TIMEOUT 已实现）全部**引用**（`import type` 用于类型，值 import 用于聚合根/纯函数），绝不重新声明、绝不重写迁移规则或归类逻辑。
- **abort 归因经 ErrorClassifier，不手拼 ClassifiedError**：中断/超时归因一律经注入的 `SK.ErrorClassifier.classify`（构造 name='AbortError'/含 timeout 语义的错误交 classify），绝不在 C2 手工拼 `ClassifiedError` 造假 code。
- **TurnRef 由核心以 {streamId} 构造**：核心不持有/不解释 native 句柄；`interrupt`/`forceKillTurn` 传入 `{ streamId }`（TurnRef.native 可选，适配器按 streamId 内部解析实际句柄）。
- **phase 不落库、registry 非持久层（NFR-2 / AC-15）**：AbortStream 全程只操作内存态 phase 与内存 registry，绝不落库、不 import C1 持久 StreamStatus 做实时判断。
- **`verbatimModuleSyntax` 已启用**：类型-only import 用 `import type` + `.js` 扩展名（NodeNext）；值 import（`reconcilePhase`/`isActive`/`isTerminal`/`StreamPhaseKind`/`TerminalSubstate` 等）走普通 import + `.js`。字段 readonly。
- **纯单元可测**：`AbortStreamService` 必须能用假 `AgentRuntimePort`（可注入 interrupt 永挂 / 返回各 runtimeStatus / spy 调用序列）+ 假 `ForceAbortScheduler`（手动触发）+ 假 Clock + 假 registry 做纯单元测试，无 dev server / 无真实 SDK-进程-网络。**#578 回归必须真断言**（interrupt 永挂 → 安全网兜底翻终态），非空断言。
- **术语中文**；用户可见文案走 `c2.*` messageKey，错误文案 key 来自 `SK.ErrorClassifier` 的 messageKey。测试用 vitest，`*.test.ts` 同目录。

## Non-goals

- 不实现任何具体 Runtime 适配器的 `interrupt`/`forceKillTurn`/句柄注册/late-unregister no-op（ClaudeSDK 的 `abortConversation`+`Query.interrupt` 组合、Native 的 `AbortController.abort`、Codex 的关 thread）——属 epic-c2-6。
- 不实现 `ForceAbortScheduler` 的 `setTimeout` 生产实现、不接 NestJS DI（`AgentRuntimeModule`/`forwardRef`/Controller）——属 epic-c2-7（本 epic 只定义 scheduler 端口契约 + 用假件测编排）。
- 不实现真实 idle-timeout / tool-timeout 的计时触发机制（依赖具体 Runtime 的空闲/工具计时）——属 c2-6；本 epic 只落「给定超时信号 → 正确归因翻终态」的核心归类。
- 不接入任何 SDK/进程/HTTP，不解析 Runtime 原生帧。
- 不新增/改写既有类型与迁移规则（`StreamSession`/`reconcilePhase`/`canTransitionPhase`/`TerminalReason`/`AgentRuntimePort`/`AbortStreamUseCase`/`ErrorClassifier`）；如需扩展走 correct-course。
- 不实现 StartStream 编排（属 c2-4，已完成）、不实现 SSE 广播/REST（属 EPIC-ACCEPT）。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿，且 `tsc --build` 在 `verbatimModuleSyntax` 下通过；禁用 import 静态守卫对新增用例/端口文件 0 命中（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`codex`/`Date.now`/`randomUUID`/`setTimeout`）。六个能力各自单测通过，重点：
- **force-abort 无条件先行（AC-4）**：spy 断言 `schedule`（安排安全网）调用序列早于 `interrupt`；interrupt 抛错时安全网仍已安排。
- **#578 端到端回归（AC-2，招牌）**：假 interrupt 永不 resolve + 假 Clock 推进 force-abort 定时器 → `AbortStreamService.abort` 走完后 `phase=terminal(aborted)`、`canAccept()=true`（真断言，非空断言）。
- **幂等（FR-3.1）**：非 active 回合 abort 为 no-op；force-abort 到期时若已 terminal 则回调 no-op。
- **reconcile 收敛（FR-3.3）**：interrupt 返回 idle/interrupted/error → 对应终态；running/null → 不纠正等安全网。
- **归因区分（AC-5）**：user-abort→ABORTED、idle-timeout→TIMEOUT、tool-timeout→PROCESS 三路 code 不同。
- **关句柄（AC-6）**：abort 编排后 interrupt 与（兜底路径）forceKillTurn 被调、turnRef.streamId 正确。

## Assumptions

- 假设 epic-c2-1 已交付并稳定：`AbortStreamUseCase` 端口、`AgentRuntimePort`（`interrupt(turnRef):Promise<string|null>` / `forceKillTurn(turnRef):void` / `TurnRef{streamId,native?}`）、`reconcilePhase`/`canTransitionPhase`、`TerminalReason`/`TerminalReasonCode`、`StreamPhase`/`isActive`/`isTerminal` 均为最终版本，本 epic 复用不改写。
- 假设 epic-c2-2 已交付：`StreamSession` 的 `abort`/`markSettling`/`complete`/`fail`/`canAccept`/`snapshot` 为最终版本（abort 已无条件同步翻终态、幂等），本 epic 经值 import 使用、不改写；c2-2-3 已在聚合根级复现 #578，本 epic 在编排级更进一步。
- 假设 epic-c2-4 已交付：`StreamSessionRegistry`（get/getActiveBySession/delete）可用；AbortStream 经 registry.get(streamId) 取回合。
- 假设 SK 已交付 `ErrorClassifier`（AbortError→ABORTED、含 timeout 语义→TIMEOUT、spawn/process→PROCESS）、`Clock`、`ClassifiedError`（含 ABORTED）端口，本 epic 经 `import type` 引用接口、经构造注入使用。
- 假设 `AgentRuntimePort`（interrupt/forceKillTurn 具体实现）与 `ForceAbortScheduler` 的 setTimeout 生产实现留待后续（c2-6/c2-7）；本 epic 全部用假件做纯单元测试。
- 假设 `packages/core` 脚手架、`npm run test` 运行器与 `tsc --build` 增量构建已就位。
