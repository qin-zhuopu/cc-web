---
id: SPEC-epic-c2-3
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-3 · EventMapper 契约 + 事件构造编解码 + result token 投影 + phase_changed 核心产出

## Why

C2（AgentRuntime）的招牌之一是把多种异构 Runtime（本期 ClaudeCode SDK 消息 / 其他预留扩展点协议的原生事件，未具名）的原生事件**归一**成一套统一事件模型，核心只消费归一后的事件，绝不感知任何 SDK/协议细节（PRD FR-4）。epic-c2-1 已把 14 类 `AgentStreamEvent` 判别联合与其值对象（`ToolUseInfo`/`ToolResultInfo`/`TokenUsage`/`ContextUsage`/`PermissionRequest`/`RateLimitInfo`）作为**纯类型**落地（`domain/event/agent-stream-event.ts`）；epic-c2-2 已让 `StreamSession` 聚合根 `apply(event)` 消费这些事件。

但归一要真正发生，还缺三块**核心侧契约**（都在零框架核心内、都是纯类型/纯函数，具体 mapper 实现留给 c2-6 的适配器）：

- **归一目标的可用构造/判别面**：c2-1 只有类型声明，mapper 与聚合根之间还需要「如何构造一个合法事件、如何判别一个事件」的编解码工具（epics-stories S3.1 的「值对象编解码」），让 14 类事件成为**结构稳定、跨 Runtime 一致**的归一目标（AC-7）——这不是重新声明 c2-1 的联合类型。
- **EventMapper 端口契约 + 未知事件降级规则**：定义「原生事件 → `AgentStreamEvent`」的映射端口（接口/纯函数签名，可含纯函数骨架），并把「Mapper 遇未识别原生事件」的处理落成**明确、不崩**的规则（AC-8）。
- **反假数据的投影纪律**：`result` 事件的 `tokenUsage` 只承载 Runtime 真实上报值，无上报留空、绝不填 0（AC-9）；`phase_changed` 由 C2 核心在相位迁移时产出，**不来自任何 Runtime**。

本 epic 只落地上述**契约与纯函数**，复用 c2-1 的类型与 c2-2 的聚合根，**不实现任何具体 Runtime 的 mapper**（属 c2-6）、不接 SDK/进程/HTTP、不实现 StartStream/AbortStream 用例编排（属 c2-4/c2-5）、不接 NestJS DI。

## Capabilities

- **CAP-1 · 14 类事件的构造/判别编解码（归一目标的可用面，不重定义 c2-1 类型）**
  - **intent:** 在不重新声明 c2-1 已定义的 `AgentStreamEvent` 联合与值对象的前提下，补齐「值对象编解码」——为 14 类事件提供构造工厂与/或判别（type guard）工具，使 mapper 侧能以统一、结构稳定的方式产出归一事件、聚合根侧能安全判别，落地 epics-stories S3.1 的「落地 14 类 + 值对象编解码」中 c2-1 尚未覆盖的构造/校验部分。
  - **success:** 在 `domain/event/` 内新增构造/判别工具（如 `agent-stream-event-factory` / type guard 集合），**引用**（`import type`）c2-1 的联合与值对象而非重定义；每类事件有稳定的构造入口，判别函数与联合 `type` 判别键一致；单测断言构造出的事件结构与 c2-1 类型契约一致、跨 Runtime 归一目标结构统一（对应 PRD FR-4.1、AC-7，epics-stories S3.1）。**明确不重复 c2-1**：不新增/改写 14 类联合成员、不改值对象接口签名。

- **CAP-2 · EventMapper 端口契约 + 未知原生事件降级不崩**
  - **intent:** 定义 `EventMapper` 契约——「某 Runtime 原生事件 → `AgentStreamEvent`（或无归一结果）」的映射端口/纯函数签名（可含纯函数骨架），并把「遇未识别原生事件」落成明确规则：**丢弃或包 raw（不伪造内容、不静默改变已识别事件语义），一律不抛**（AC-8）。契约本身是纯类型/纯函数，**不接任何 SDK**。
  - **success:** 新增 `ports`/`domain` 侧的 `EventMapper` 契约（映射函数签名 + 未知事件降级的规约），单测用「未识别原生事件」样本断言：调用不抛、不产出伪造的已识别事件、不污染并发的合法事件归一结果（降级为「无归一结果 / 跳过」是核心侧安全路径）；契约对各 Runtime 均适用（结构与 architecture §3.5「text…file_changed 由 EventMapper 归一」一致）。**具体 mapper 实现（ClaudeSDK 及其他未具名预留扩展点）不在本 epic**（对应 PRD FR-4.2/4.3、AC-8，epics-stories S3.2）。

- **CAP-3 · result 事件 token 投影（只存不算，无上报留空不填 0）**
  - **intent:** 明确 `result` 事件 `tokenUsage` 投影的构造/归一契约：仅当 Runtime **真实上报**时才携带 `TokenUsage`，未上报时字段整体省略——**绝不填 0、不估算**；契约保证「构造 result 事件」与「投影进聚合根」两侧都遵守 AC-9 反假数据纪律。
  - **success:** result 事件构造工具（CAP-1 的一部分）对「无 tokenUsage 上报」产出的事件其 `tokenUsage` 字段为 `undefined`（省略）；单测断言：无上报 → `result.tokenUsage === undefined`、经 c2-2 的 `apply` 后 `snapshot().tokenUsage` 仍为空、UI/落库层留空而非假 0；有上报 → 各计数字段如实透传、不在此侧计算 `totalTokens`（对应 PRD FR-4.4、AC-9，epics-stories S3.3）。

- **CAP-4 · phase_changed 事件由 C2 核心产出（非 Runtime 归一）**
  - **intent:** 明确 `phase_changed` 事件的**产出方是 C2 核心相位迁移**（不来自任何 Runtime、不经 EventMapper），提供在相位迁移时把 `StreamPhase` 包装成 `phase_changed` 事件对外发的构造契约/纯函数，供后续用例编排（c2-4/c2-5）在迁移时使用。
  - **success:** 提供 `phase_changed` 事件的构造工具（携带迁移后的 `StreamPhase`），单测断言其来源为 C2 核心（输入是相位而非任何原生事件）、EventMapper 契约**不产出** `phase_changed`（该类型不属于 Runtime 归一集合）；与 architecture §3.5「phase_changed 由 C2 核心在相位迁移时产出」一致（对应 PRD FR-4.1，epics-stories S3.4）。

## Constraints

- **核心零框架 import（NFR-1 / AC-14）**：`packages/core/src/agent-runtime/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`、任何第三方 AI agent SDK（未具名），禁止直调 `Date.now()`/`new Date()`/`randomUUID()`。本 epic 全部产物为纯类型/纯函数契约，取时（如有）经注入的 `SK.Clock`，不直调系统时钟。
- **EventMapper 是契约/纯函数，不接 SDK**：本 epic 只定义映射端口签名与纯函数骨架 + 未知事件降级规约；**绝不** import 或调用任何 Runtime SDK/协议客户端。具体 mapper（`ClaudeSdkEventMapper` 及其他未具名预留扩展点的 mapper）的实现属 c2-6 的适配器层，不在本 epic。
- **未知原生事件降级不抛**：EventMapper 遇未识别原生事件必须走明确降级路径（丢弃 / 包 raw），**一律不抛异常、不伪造已识别事件内容、不静默改变已识别事件语义**（AC-8）。当前 c2-1 的 14 类联合无 raw/unknown 载体，核心侧安全路径为「返回无归一结果（跳过/丢弃）」；若需新增 raw 载体则改动 c2-1 类型，须走 correct-course，不在本 epic 擅自扩联合。
- **token 只存不算（AC-9 反假数据）**：`result` 事件的 `tokenUsage` 仅承载 Runtime 真实上报值，无上报时字段省略——绝不填 0、不估算、不在核心侧计算合计。`context_usage` 同理，无上报不发事件。
- **phase_changed 核心产出**：`phase_changed` 只能由 C2 核心相位迁移产出，不来自 Runtime、不经 EventMapper 归一；EventMapper 契约的归一集合仅覆盖 text…file_changed（13 类）。
- **phase 不落库、不与 C1 持久 StreamStatus 混用（NFR-2 / AC-15）**：`phase_changed` 携带的 `StreamPhase` 是实时内存态，本 epic 不写任何持久层、不 import/建模 C1 的 `StreamStatus`（streaming/completed/interrupted/error）做实时判断。
- **`verbatimModuleSyntax` 已启用**：类型-only import 必须用 `import type`，模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。对 c2-1 的 `AgentStreamEvent`/`ToolUseInfo`/`ToolResultInfo`/`TokenUsage`/`ContextUsage`/`PermissionRequest`/`RateLimitInfo`、`StreamPhase`、`TerminalReasonCode` 及 SK 的 `ClassifiedError` 的引用都须遵守。
- **复用 c2-1/c2-2，不重定义类型、不重写迁移规则**：CAP-1 的构造/判别工具**引用** c2-1 的联合与值对象（`import type`），不重新声明 14 类成员、不改值对象签名；`apply` 投影行为已由 c2-2 实现，本 epic 只补构造/映射契约侧。
- **纯单元可测**：EventMapper 契约、未知事件降级、事件构造与 token 投影必须能用录制的原生事件样本 + 假数据做纯单元测试（无 dev server / 无真实 SDK-进程-网络）。

## Non-goals

- 不实现任何具体 Runtime 的 EventMapper（`ClaudeSdkEventMapper` 及其他未具名预留扩展点的 mapper）与其原生事件解析——属 epic-c2-6 的适配器层。
- 不接入任何 SDK/进程/HTTP（`@anthropic-ai/*` / 任何第三方 AI agent app-server / 其他协议 `fetch`）——契约层零框架。
- 不实现 `StartStreamService`/`AbortStreamService` 用例编排、force-abort 先行、reconcile、终态落 C1——分属 epic-c2-4（StartStream）/ epic-c2-5（AbortStream）。
- 不接入 NestJS DI（`AgentRuntimeModule`、`forwardRef`、Controller）与终态→C1 `StreamStatus` 映射的实现。
- 不新增/改写 c2-1 已定义的 14 类 `AgentStreamEvent` 联合成员与值对象接口（如需 raw/unknown 载体走 correct-course）。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿，且 `tsc --build` 在 `verbatimModuleSyntax` 下通过；禁用 import 静态守卫对新增契约/工厂文件 0 命中（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`Date.now`/`randomUUID`）。四个故事各自单测通过：14 类事件构造/判别工具产出结构稳定且与 c2-1 类型契约一致（未重定义联合）；**EventMapper 契约的未知原生事件降级不崩**（不抛、不伪造、不污染已识别事件）、映射契约测试全通过；`result` 事件无 tokenUsage 上报时字段留空、经 `apply` 后 snapshot 不显假 0（AC-9）；`phase_changed` 由核心相位迁移产出、不在 EventMapper 归一集合内。

## Assumptions

- 假设 epic-c2-1 已交付并稳定：`domain/event/agent-stream-event.ts` 的 14 类 `AgentStreamEvent` 联合与 `ToolUseInfo`/`ToolResultInfo`/`TokenUsage`/`ContextUsage`/`PermissionRequest`/`RateLimitInfo` 值对象签名为最终版本，本 epic 复用不改写；`domain/stream/stream-phase.ts` 的 `StreamPhase`、`terminal-reason.ts` 的 `TerminalReasonCode` 可用。
- 假设 epic-c2-2 已交付：`StreamSession.apply(event)` 已按 §3.5 各事件字段语义消费归一事件（含 `result`→tokenUsage 投影、`context_usage`→contextUsage 投影、`phase_changed` 等旁路信号不进 TurnArtifacts）；本 epic 的构造/投影契约与其对齐，不重写 `apply`。
- 假设 SK 已交付 `ClassifiedError`（含 `ABORTED`）、`Clock`、`IdGenerator` 端口，本 epic 经 `import type` 引用其接口类型。
- 假设各 Runtime 原生事件可录制成样本用于 EventMapper 契约的表驱动/降级测试（无需真实网络/进程）；具体 mapper 实现留待 c2-6。
- 假设 `packages/core` 脚手架、`npm run test` 运行器与 `tsc --build` 增量构建已就位。
