---
id: SPEC-epic-c2-4
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-4 · 发起回合 StartStream（Runtime 选择 + 历史投影 + 单 active 约束 + 事件消费 + 落 C1）

## Why

C2（AgentRuntime）对外的招牌驱动能力之一是**发起一次回合**：把「用户在某会话里说的一句话」变成一次向 Runtime 的原生调用，把 Runtime 吐出的**已归一** `AgentStreamEvent` 流累积进聚合根、驱动相位迁移，回合结束时把最终产物**只经 C1 用例**落库（PRD FR-2）。

到 epic-c2-3 为止，C2 已具备全部**领域零件**：`StreamSession` 聚合根（c2-2，含四迁移方法/canAccept/apply）、14 类 `AgentStreamEvent` 与其构造/判别工具（c2-1/c2-3）、`phase_changed` 核心产出工厂（c2-3）、`buildFinalContent` 终态投影（c2-1）。端口契约也已就位：驱动端口 `StartStreamUseCase`（c2-1）、出站端口 `AgentRuntimePort`（c2-1）、C1 用例端口别名 `GetSessionHistoryUseCase`/`AppendMessageUseCase`（c2-1）、C7 只读端口 `ProviderReadPort`（c2-1）、SK 的 `Clock`/`IdGenerator`/`ErrorClassifier`。

但**编排层**还是空的：没有把这些零件串成一次回合的 `StartStreamService`，也没有承载「同一 session 至多一个 active 回合」的内存注册表。本 epic 落地这层编排（PRD FR-2 全部）：

- **StartStreamService.start** —— `streamId←IdGenerator`、`startedAt←Clock`（经 StreamSession 构造），创建 `StreamSession(active)` 注册进 registry，调 `AgentRuntimePort.run` 拿归一事件流（FR-2.1）。
- **Runtime 选择** —— 经只读 `ProviderReadPort.resolve(providerId)` 解析 `ResolvedProviderView` → 映射出 `RuntimeKind`，发起时锁定（FR-2.2）。
- **历史投影** —— 经 `C1.GetSessionHistoryUseCase.getPromptView` 拿喂模型历史，C2 绝不读 `messages` 表（FR-2.3）。
- **单 active 约束** —— `start` 前若该 session 已有 active 回合先 `abort` 旧回合，保证同一 session 至多一个 active（FR-2.4 / AC-11）。
- **事件消费与终态** —— 订阅 `AgentRuntimePort.run` 的归一事件流，每个事件 `session.apply(event)`（并转发给上层）；流正常结束→`complete`、abortSignal 触发→`abort(ABORTED)`、上游 error 事件→`fail(classified)`、idle/tool timeout→按 `TerminalReason` 归因（FR-2.1 / FR-3.6 支撑）。
- **落 C1** —— 终态经 `buildFinalContent(artifacts)` 若非 null 且非 `autoTrigger` → `C1.AppendMessageUseCase.append`；空回合不落（FR-2.5/2.6 / AC-12）。

本 epic 只落地**用例编排 + 内存注册表**这层**纯逻辑**，全部可用**假 `AgentRuntimePort` / 假 C1 用例 / 假 `ProviderReadPort` / 假 Clock/IdGenerator** 做纯单元测试。**不实现任何具体 Runtime 适配器**（属 c2-6）、不接 SDK/进程/HTTP、不接 NestJS DI（`AgentRuntimeModule`/`forwardRef`/Controller 属 c2-7）、不实现 AbortStream 完整编排（force-abort 先行/reconcile 属 c2-5）。

## Capabilities

- **CAP-1 · StreamSessionRegistry 内存注册表 + StartStreamService 发起骨架（FR-2.1）**
  - **intent:** 落地承载「活跃回合索引」的内存 `StreamSessionRegistry`（非持久层，NFR-2/AC-15）与 `StartStreamService.start` 的发起骨架：`streamId` 经注入的 `SK.IdGenerator` 生成，`StreamSession(active)` 经注入的 `SK.Clock` 取 `startedAt`（聚合根构造已封装），创建后注册进 registry。核心无 `Date.now()`/`randomUUID()` 直调（NFR-1/AC-14）。
  - **success:** 新增 `usecases/stream-session-registry.ts`（`register`/`get`/`getActiveBySession`/`delete` 等最小索引 API，纯内存 Map，不落库）与 `usecases/start-stream.ts`（`StartStreamService implements StartStreamUseCase`，构造注入 registry + 端口依赖）。单测（用假 IdGenerator/假 Clock/假 AgentRuntimePort）断言：`start` 生成的 `streamId` 来自 IdGenerator、`StreamSession` phase=active 且注册进 registry、`startedAt` 来自注入 Clock；核心零框架、无 Date/uuid 直调（对应 PRD FR-2.1、AC-14，epics-stories S4.1）。

- **CAP-2 · Runtime 选择：ProviderReadPort 解析 → RuntimeKind（FR-2.2）**
  - **intent:** 在 `start` 内经只读 `ProviderReadPort.resolve(providerId)` 拿 `ResolvedProviderView`，把 `protocol` 映射为 `RuntimeKind` 并在发起时锁定（落入 `StreamSession.runtimeKind` 与 `RuntimeRunRequest.runtimeKind`）。C2 只读消费，绝不写 Provider。
  - **success:** 提供 `protocol → RuntimeKind` 的纯映射（如 `anthropic`→`CLAUDE_SDK`、`openai-compatible`/其余 HTTP 协议→`NATIVE` 等，以 architecture §3.6 / §5.3 语义为准；无法判定时的降级路径明确、不臆造）。单测断言：不同 `protocol` 的 `ResolvedProviderView` 路由到不同 `RuntimeKind`、发起时锁定后不再改（对应 PRD FR-2.2，epics-stories S4.2）。**只读纪律**：只调 `resolve`，不调任何写方法。

- **CAP-3 · 历史投影：只经 C1.getPromptView 拿喂模型历史（FR-2.3）**
  - **intent:** 在 `start` 内经 `C1.GetSessionHistoryUseCase.getPromptView({ sessionId })` 拿喂模型历史投影（已剔除 render-only 标记），作为 `RuntimeRunRequest.promptView` 传给适配器。C2 **绝不**直读 `messages` 表 / 不持有 Repository。
  - **success:** 单测（用假 GetSessionHistoryUseCase）断言：`start` 只经 `getPromptView` 取历史、传入的 `sessionId` 正确、拿到的投影原样进 `RuntimeRunRequest.promptView`；核心不出现任何 SQL/表访问（对应 PRD FR-2.3、C1 AC-13，epics-stories S4.3）。

- **CAP-4 · 单 active 约束：新回合前先 abort 旧 active 回合（FR-2.4 / AC-11）**
  - **intent:** `start` 在创建新回合前，先查 registry 是否已有该 `sessionId` 的 active 回合；若有则先 `abort` 旧回合（翻 `terminal(aborted)`，经 `SK.ErrorClassifier` 归 `ABORTED`），保证同一 session 至多一个 active 回合。
  - **success:** 单测断言：同一 sessionId 连续两次 `start` 后，旧回合 phase ∈ terminal(aborted)、`canAccept()`=true，新回合 phase=active；registry 中该 session 的 active 回合恰为新回合（对应 PRD FR-2.4、AC-11，epics-stories S4.4）。**复用 c2-2 的 `StreamSession.abort`**，不重写迁移；本 epic 不做 force-abort 安全网/reconcile（属 c2-5）——此处旧回合 abort 是聚合根层的同步无条件翻终态。

- **CAP-5 · 事件消费与终态归因（FR-2.1 / FR-3.6 支撑）**
  - **intent:** 订阅 `AgentRuntimePort.run(request)` 的**已归一** `AgentStreamEvent` 异步流，逐事件 `session.apply(event)` 累积产物，并对外转发（作为 `StartStreamResult.events`）。据流的结束方式驱动终态：正常结束→`session.complete(tokenUsage)`；`abortSignal` 触发→`session.abort(ABORTED)`；上游 `error` 事件→`session.fail(classified)`；idle/tool timeout→走 abort/fail 按 `TerminalReason` 归因（TIMEOUT/PROCESS）。
  - **success:** 单测（用假 AgentRuntimePort 产出可控事件序列）断言各终态路径 phase 正确：正常结束→`terminal(completed)`、error 事件→`terminal(errored)` 且 `error` 为分类结果、abortSignal→`terminal(aborted)`；`result` 事件 token 投影经 `apply` 存入（无上报留空不填 0，AC-9）（对应 PRD FR-2.1/FR-3.6，epics-stories S4.5）。**归一事件消费**：本 epic 只消费**已归一**的 `AgentStreamEvent`（EventMapper 在适配器内，属 c2-6），不解析任何 SDK/SSE/JSON-RPC 原生帧。

- **CAP-6 · 落 C1：终态非空且非 autoTrigger 才经用例 append（FR-2.5/2.6 / AC-12）**
  - **intent:** 回合落终态后，经 `buildFinalContent(artifacts)` 投影最终内容；**非 null 且非 `autoTrigger`** 时经 `C1.AppendMessageUseCase.append` 落一条 assistant 消息（携带 tokenUsage 投影，无上报不填 0），并按终态映射持久 `StreamStatus`（completed/interrupted/error，§6.4）；空回合（`buildFinalContent` 返回 null）不落 assistant 消息。
  - **success:** 单测（用假 AppendMessageUseCase）断言：非空终态→恰调一次 `append`（role=assistant、content 来自 finalContent、tokenUsage 为投影或省略）、终态→C1 持久 StreamStatus 映射正确（completed→'completed'、aborted→'interrupted'、errored→'error'）；空回合→`append` 不被调用；`autoTrigger` 回合→跳过落库（FR-2）。**只经用例写**：C2 绝不直写库/持有 Repository（对应 PRD FR-2.5/2.6、AC-12，epics-stories S4.6）。

## Constraints

- **核心零框架 import（NFR-1 / AC-14）**：`packages/core/src/agent-runtime/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`、`codex` SDK；禁止直调 `Date.now()`/`new Date()`/`randomUUID()`（注释里也别连写 `Date.now(`）。`streamId` 经注入 `SK.IdGenerator`，取时经注入 `SK.Clock`（`StreamSession` 构造已封装 `startedAt`/`settledAt`）。
- **用例是纯编排，不接 SDK/进程/HTTP/DI**：本 epic 只实现 `StartStreamService` 与 `StreamSessionRegistry` 的**纯逻辑**，依赖全部经**构造注入的端口接口**（`AgentRuntimePort`/`ProviderReadPort`/C1 用例端口/`SK.*`）。**绝不** import 任何 Runtime 适配器实现、SDK、子进程、HTTP、NestJS。三适配器/RuntimeRouter 属 c2-6，`AgentRuntimeModule`/`forwardRef`/Controller 属 c2-7。
- **只消费已归一事件**：`start` 消费的是 `AgentRuntimePort.run` 产出的**已归一** `AgentStreamEvent`（EventMapper 在适配器内，属 c2-6）；本 epic 不解析任何原生 SDK/SSE/JSON-RPC 帧、不实现 EventMapper。
- **单 active 用聚合根 abort，不做 force-abort 编排**：CAP-4 的「abort 旧回合」直接调 c2-2 的 `StreamSession.abort`（同步无条件翻终态）；本 epic **不实现** AbortStream 的 force-abort 安全网先行 / best-effort interrupt / reconcilePhase（分属 epic-c2-5）。
- **registry 非持久层（NFR-2 / AC-15）**：`StreamSessionRegistry` 是活跃回合的**内存**索引（Map），绝不落库、不 import C1 持久 `StreamStatus` 做实时判断。phase 是实时内存态。
- **落 C1 只经用例、反假数据（AC-12 / AC-9）**：回合产物落库**只经** `C1.AppendMessageUseCase`，C2 不持有 Repository 直写路径、不直读 `messages` 表。tokenUsage 无 Runtime 上报时字段省略——绝不填 0、不估算。空回合（`buildFinalContent`→null）不落 assistant 消息。
- **复用既有类型/聚合根/纯函数，不重定义**：`StreamSession`（c2-2）、14 类 `AgentStreamEvent` 与构造/判别（c2-1/c2-3）、`buildFinalContent`（c2-1）、`RuntimeKind`（复用既有 enum，**不新增**）、端口契约（c2-1）全部**引用**（`import type` 用于类型，值 import 用于聚合根/纯函数），绝不重新声明。**注意** `RuntimeKind` 现存 `domain/runtime/runtime-kind.ts` 与 `ports/runtime-kind.ts` 两处同名 enum：本 epic 一律复用 `AgentRuntimePort`/`StreamSession` 已引用的那一处，绝不新增第三处、绝不改签名。
- **`verbatimModuleSyntax` 已启用**：类型-only import 必须用 `import type`，模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。对 `StreamSession`、`AgentStreamEvent`、`StartStreamInput`/`StartStreamResult`、`AgentRuntimePort`/`RuntimeRunRequest`、`ProviderReadPort`/`ResolvedProviderView`、C1 用例端口、`SK.Clock`/`IdGenerator`/`ClassifiedError`/`ErrorClassifier` 的引用都须遵守（值 import 走普通 import）。
- **纯单元可测**：`StartStreamService` 与 `StreamSessionRegistry` 必须能用假端口（假 `AgentRuntimePort` 产出可控事件序列 + 假 C1 用例 + 假 `ProviderReadPort` + 假 Clock/IdGenerator）做纯单元测试，无 dev server / 无真实 SDK-进程-网络。
- **术语中文**；用户可见文案走 `c2.*` messageKey（渲染交 SK.TranslationPort），错误文案 key 来自 SK.ErrorClassifier 的 messageKey。测试用 vitest，`*.test.ts` 同目录。

## Non-goals

- 不实现任何具体 Runtime 适配器（`ClaudeSdkRuntimeAdapter`/`NativeRuntimeAdapter`/`CodexRuntimeAdapter`）、`RuntimeRouter`、`EventMapper` 的具体实现——属 epic-c2-6。
- 不实现 AbortStream 完整编排（force-abort 安全网无条件先行 / best-effort interrupt / reconcilePhase 收敛 / 关句柄 / idle-tool timeout 归因的定时器机制）——属 epic-c2-5。本 epic 的「abort 旧 active 回合」只是聚合根层同步翻终态。
- 不接入 NestJS DI（`AgentRuntimeModule`、`forwardRef` 解 C1↔C2 环、Controller/驱动适配器）与 TitleGenerator/权限中转——属 epic-c2-7。
- 不接入任何 SDK/进程/HTTP，不解析任何 Runtime 原生帧（归一属 EventMapper/c2-6）。
- 不新增/改写既有类型（`RuntimeKind`、14 类 `AgentStreamEvent`、值对象、端口契约、`StreamSession` 迁移规则）；如需扩展须走 correct-course。
- 不实现 SSE 广播 / 事件日志文件 / REST 三件套 / 断线补发——属 EPIC-ACCEPT。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿，且 `tsc --build` 在 `verbatimModuleSyntax` 下通过；禁用 import 静态守卫对新增用例/注册表文件 0 命中（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`codex`/`Date.now`/`randomUUID`）。六个故事各自单测通过：`start` 的 `streamId` 来自注入 IdGenerator、`StreamSession(active)` 注册进 registry（无 Date/uuid 直调）；不同 `protocol` 路由到不同 `RuntimeKind` 且发起时锁定；历史只经 `C1.getPromptView` 取（不读 messages 表）；同一 session 连续 start 时旧回合翻 `terminal(aborted)`、新回合 active（AC-11）；各终态路径（complete/abort/fail）phase 正确、`result` token 投影不填 0（AC-9）；非空且非 autoTrigger 终态才经 `C1.AppendMessageUseCase.append` 落库、终态→持久 StreamStatus 映射正确、空回合不落（AC-12）。

## Assumptions

- 假设 epic-c2-1 已交付并稳定：驱动端口 `StartStreamUseCase`（`StartStreamInput`/`StartStreamResult`）、出站端口 `AgentRuntimePort`（`RuntimeRunRequest`/`TurnRef`/`AbortSignalLike`/`RuntimeRunOptions`）、`ProviderReadPort`（`ResolvedProviderView`/`ProviderProtocol`）、C1 用例端口别名（`GetSessionHistoryUseCase`/`AppendMessageUseCase`/`PromptMessage`）、`RuntimeKind` enum 均为最终版本，本 epic 复用不改写。
- 假设 epic-c2-2 已交付：`StreamSession` 聚合根（构造注入 Clock、四迁移方法幂等、canAccept、apply 累积）为最终版本，本 epic 经值 import 使用、不改写；`buildFinalContent`（c2-1）可用。
- 假设 epic-c2-3 已交付：14 类事件的构造/判别工具、`phase_changed` 工厂、result token 投影纯函数可用（本 epic 编排消费）。
- 假设 SK 已交付 `Clock`、`IdGenerator`、`ErrorClassifier`（能把 AbortError 归 `ABORTED`）、`ClassifiedError`（含 `ABORTED`）端口，本 epic 经 `import type` 引用接口、经构造注入使用。
- 假设 `AgentRuntimePort` / `ProviderReadPort` / C1 用例端口的**实现**留待后续（c2-6 适配器、c2-7 DI 接线、C1/C7 各自的模块）；本 epic 全部用假端口做纯单元测试。
- 假设 `packages/core` 脚手架、`npm run test` 运行器与 `tsc --build` 增量构建已就位。
