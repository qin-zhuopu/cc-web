---
title: 产品简报 — C2 AgentRuntime 智能体运行时
context: C2 · AgentRuntime
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C2 · AgentRuntime（智能体运行时）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)；C1 的持久 StreamStatus 与 C2 实时 phase 的语义分离见 [../c1-conversation/architecture.md](../c1-conversation/architecture.md)。

## 1. 一句话定位

C2 是 CodePilot Web 里**持有"一次 AI 流式回合（StreamSession）的实时生命周期与多 Runtime 抽象"**的领域边界。它负责：接受一次发送请求 → 选中某个 Runtime（本期为 ClaudeCode SDK；其他 AI agent 运行时为未具名预留扩展点）→ 把该 Runtime 的原生事件流归一化成统一的 `AgentStreamEvent` → 维护这次回合的实时相位状态机（`active → settling → terminal`）→ 支持中断（abort/interrupt）。它**自己不持久化会话与消息**（回合产物经 C1 用例落库），也**不做子 agent 编排**（那是 C3，复用 C2 的 `AgentRuntimePort`）。

## 2. 解决什么问题

C2 对应的是现有 Electron 版 CodePilot **bug 最密集**的模块——`stream-session-manager.ts`、`claude-client.ts`、`conversation-registry.ts`、以及若干外部 AI agent 的 app-server/runtime 适配文件。这批文件的核心痛点是"实时流式状态"被散落成一堆可变字段与定时器，语义没有被固化成领域不变量，导致同一类中断 / 卡死问题反复出现：

- **相位（phase）不是不变量，是散字段**：`snapshot.phase`（`active`/`completed`/`stopped`/`error`）散落在多处被手动赋值，abort 分支多、每条分支都要记得把 phase 翻到终态。一旦某条中断路径漏翻，phase 停在 `active`，UI 永远以为还在流式。
- **isStreaming gate ≡ phase===active 的耦合是隐式的**：composer 的"能否发送"闸门等价于 `phase==='active'`（见 `stream-session-manager.ts` 注释与 `isStreamActive()`）。GitHub #578 的根因正是：`/api/chat/interrupt` 挂起 → 原代码把 force-abort 排在 interrupt 的 `.finally()` 里 → interrupt 永不 settle → force-abort 永不触发 → phase 停 `active` → 复合发送被 isStreaming 队列 gate 卡死。
- **多 Runtime 的差异污染核心**：不同 AI agent 走不同调用形态（ClaudeCode 走 `@anthropic-ai/claude-agent-sdk` 的 `Query` 句柄；HTTP 协议 agent 走 SSE；子进程类 agent 走本机 app-server + JSON-RPC）。它们的中断语义、进程管理、僵死处理各不相同，现在这些差异直接混在流式主循环里，改一处易踩另一处。
- **子进程类 agent 的进程管理/中断/僵死是独立难题**：现有 `app-server-manager` 类文件里 binary 发现、版本选择、fatal config stderr 快失败、僵死 kill、orphan 进程规避——这些进程级复杂度不应污染"一次回合是什么"的核心逻辑。
- **中断后 thread/turn 状态残留**：各 agent 的 thread/turn、ClaudeCode 的 `Query` 句柄（`conversation-registry.ts` 的 `lockId` 归属令牌）中断后若未关闭，下一轮发送语义错乱。

C2 把"一次回合的实时生命周期"抽成一个零框架核心：**phase 成为 StreamSession 实体的不变量**（只能经领域方法迁移，abort 保证翻终态）、**isStreaming gate 成为领域方法 `canAccept()`**（而非散落的 `phase==='active'` 比较）、**每个 Runtime 一个适配器 + EventMapper**（本期实现 ClaudeSdkRuntimeAdapter；`AgentRuntimePort` 作为未具名预留扩展点，将来加新 AI agent 时各补一个适配器，把原生事件归一成 `AgentStreamEvent`，差异隔离在适配器内）。目标是让"CodePilot 高发的 stop/abort 卡死"在类型与不变量层面被切断，而不是靠每条分支的人工纪律。

## 3. 目标用户与价值

- **单机开发者用户**：在 SPA 里发消息、看流式输出、随时点"停止"——停止后 composer 立刻能再次发送，不会被卡在"仍在流式"的假象里；本期接 ClaudeCode SDK，将来切到其他 AI agent 体验一致。
- **接入 C2 的其他上下文**：
  - **C1 Conversation**：调 C2 的 `TitleGenerator` 端口拿标题字符串（C1 只落库，不关心哪个 Runtime 生成）；回合结束后 C2 经 C1 的 `AppendMessageUseCase` 落 assistant 消息、经 `updateStreamStatus` 推进持久生命周期。
  - **C3 SubagentOrchestration**：复用 C2 的 `AgentRuntimePort` 发起子 agent 的 AI 调用——C3 不重新实现 AI 调用，只编排 run/attempt。
  - **C5 Bridge**：外部 IM 消息经 C5 路由后，最终经 C2 发起一次回合。
  - **C7 ProviderManagement**：C2 **只读消费** `C7.ProviderRepository` 拿 Provider 配置（endpoint / auth / model），不自己管理 Provider。

价值主张：**把"一次 AI 流式回合的实时相位"从散落的可变字段与定时器里固化成领域不变量，把三个 Runtime 的差异隔离进各自适配器，让 stop/abort 卡死不再靠人工纪律而靠类型与状态机保证。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C2 契约：

- **拥有**：
  - `StreamSession` 实体（一次回合的实时生命周期，含 phase 状态机 `active → settling → terminal`、`canAccept()` 领域方法、`abort()` 保证翻终态）
  - `AgentStreamEvent`（统一的流式事件模型：text / thinking / tool_use / tool_result / tool_output / status / result / error / permission-request / phase-changed 等）
  - 多 Runtime 抽象（`AgentRuntimePort` + 本期实现 `ClaudeSdkRuntimeAdapter`；其余为未具名预留扩展点，各带 `EventMapper` 把原生事件归一）
- **不包含**：
  - **会话/消息如何持久化** —— 属 C1。C2 只在回合结束时经 C1 的 `AppendMessageUseCase` / `updateStreamStatus` 落产物，不直接写 `messages` / `chat_sessions`。
  - **子 agent 编排（logical run / attempt / RunPhase）** —— 属 C3。C3 复用 C2 的 `AgentRuntimePort`，C2 不感知子 agent 概念。
  - **Provider 配置/诊断** —— 属 C7。C2 只读消费 `C7.ProviderRepository`。
  - **权限 UI/经纪** —— 属 C5。C2 只产出 `permission-request` 事件并接收决议回传，不做经纪逻辑。
  - **MCP server 注册 / Skill 加载** —— 属 C9。C2 消费其端口（若纳入范围）但不注册。
  - **持久转录行生命周期 `StreamStatus`（streaming/completed/interrupted/error）** —— 属 **C1**（见下方语义澄清）。
- **依赖端口（只引用，不重写）**：
  - `SK.ErrorClassifier` —— 把各 Runtime 的原生异常归一成 16 类结构化错误（含 `ABORTED` 独立类，用于把"用户主动中断"与真实错误在 UI 上区分）。
  - `SK.Clock` / `SK.IdGenerator` / `SK.RuntimeLog` / `SK.TranslationPort`（横切）。
  - `C1.AppendMessageUseCase` / `C1.GetSessionHistoryUseCase`（回合产物落库、读历史喂模型；只 `import type`）。
  - `C7.ProviderRepository`（只读消费 Provider 配置；只 `import type`）。
- **对外提供端口**：
  - `StartStreamUseCase`（发起一次回合）、`AbortStreamUseCase`（中断一次回合）。
  - `AgentRuntimePort`（供 C3 复用 AI 调用能力）。
  - `TitleGenerator`（供 C1 生成标题）。

## 5. 与 CodePilot 现有实现的对应

| C2 概念 | 现有落点 |
|---|---|
| `StreamSession` 实体 + phase 状态机 | `stream-session-manager.ts` 的 `ActiveStream` + `snapshot.phase`（`active`/`completed`/`stopped`/`error`）——现为散字段，C2 固化为实体不变量 |
| `canAccept()` 领域方法 | `isStreamActive()` / composer 的 `isStreaming` gate（≡ `phase==='active'`）——现为散落比较，C2 收敛成领域方法 |
| `abort()` 翻终态 + force-abort 安全网 | `stopStreamWith()` 的"force-abort FIRST、unconditional"逻辑（GitHub #578 修复）——C2 把它做成 phase 状态机不变量 |
| `AgentStreamEvent` | `consumeSSEStream` 的 `onText`/`onThinking`/`onToolUse`/`onToolResult`/`onToolOutput`/`onStatus`/`onResult`/`onError`/`onPermissionRequest` 等回调 —— C2 归一成一个事件联合 |
| `ClaudeSdkRuntimeAdapter`（本期实现） | `claude-client.ts` + `conversation-registry.ts`（`Query` 句柄 + `lockId` 归属 + `abortConversation`） |
| 未具名预留扩展点（HTTP SSE 协议类） | 现有走 HTTP SSE 协议的 provider 流路径（本期不实现，预留） |
| 未具名预留扩展点（子进程类 agent） | 现有外部 agent 的 `app-server-manager` + `runtime` 事件映射（本期不实现，预留） |
| `TitleGenerator` | 现耦合在 runtime 侧的标题生成；重构后 C2 独占，C1 只经端口消费 |

> **语义澄清（防"持久 vs 实时"混用，对齐 CLAUDE.md stop/abort 高发区）**：C1 的 `StreamStatus`（`streaming`/`completed`/`interrupted`/`error`）是**持久的转录行生命周期**——回答"这条 assistant 消息最终是完整/被中断/出错"，落在 `messages.stream_status`。C2 的 `StreamSession.phase`（`active → settling → terminal`）是**实时流式相位**——回答"现在这一刻还在生成吗"，是内存态、不落库。两者**不可混用**：把持久 `StreamStatus` 当实时相位读，正是 CodePilot stop/abort 卡死的根因。C2 拥有 phase，C1 拥有 StreamStatus，二者在类型层面分属两个上下文，物理上也不共存（phase 是 C2 内存实体字段，不进 C1 的 `messages` 表）。

## 6. 成功标准（可度量）

- **S1 phase 是不变量而非散字段**：`StreamSession.phase` 只能经领域方法（`markSettling` / `terminate` / `abort`）迁移；`active → settling → terminal` 的合法迁移有单测覆盖，非法迁移（如 `terminal → active` 回退）被拒绝。**任何 abort 路径结束后 phase 必然是 terminal 子态之一，绝不停在 active。**
- **S2 abort 卡死在结构上被切断**：`AbortStreamUseCase` 的 force-abort 安全网**无条件先行**（不排在 interrupt 的 `.finally` 后），复现 GitHub #578 场景（interrupt 挂起）时 phase 仍能翻终态，`canAccept()` 立刻返回 true。有针对该反例的 smoke。
- **S3 isStreaming gate 收敛成领域方法**：composer 的"能否发送"不再散落 `phase==='active'` 比较，统一走 `StreamSession.canAccept()`；`canAccept()` ≡ `phase !== active` 有单测断言，且文档写明这是 #578 队列卡死的唯一判据。
- **S4 Runtime 差异隔离**：本期 `ClaudeSdkRuntimeAdapter` 一个适配器 + EventMapper；核心的 `StreamSession` / 用例代码不出现 `@anthropic-ai/*`、`child_process`、HTTP SSE 等适配器私有细节。`AgentRuntimePort` 作为未具名预留扩展点，将来接入新 AI agent 时其进程管理/中断/僵死锁在该 agent 自己的适配器内。
- **S5 中断与真实错误在语义上可分**：abort 经 `SK.ErrorClassifier` 归为 `ABORTED` 独立错误类，与 `NETWORK`/`SERVER`/`TIMEOUT` 等真实错误区分；UI 可据此不把"用户主动停止"显示成"出错了"。
- **S6 边界纯净**：C2 核心包不 import better-sqlite3 / NestJS；不建模会话/消息持久化、子 agent、Provider 配置管理；持久 `StreamStatus` 只经 `C1.AppendMessageUseCase` 端口写回，不在 C2 内建模。

## 7. 非目标（明确排除）

- 不持久化会话/消息（经 C1 用例），不实现 `messages`/`chat_sessions` 的 SQL/迁移。
- 不做子 agent 编排（C3 复用 `AgentRuntimePort`）。
- 不管理 Provider 配置/诊断（只读消费 `C7.ProviderRepository`）。
- 不做权限经纪逻辑（只产 `permission-request` 事件、收决议；经纪在 C5）。
- 不建模持久转录行生命周期 `StreamStatus`（属 C1）——C2 只在回合终态时经 C1 端口把终态推进。
- 不替 SK 重实现 ErrorClassifier / Clock / IdGenerator。
- 不做多租户/远程认证（单机 `~/.codepilot/`）。

## 8. 关键风险与假设

- **假设**：C1 已交付 `AppendMessageUseCase`（含 `updateStreamStatus`）与 `GetSessionHistoryUseCase`（`getPromptView` 喂模型投影）；C7 已交付只读 `ProviderRepository`。C2 只 `import type` 这些端口，实现经 NestJS DI 注入。
- **风险（C1↔C2 环）**：C1 依赖 `C2.TitleGenerator`，C2 依赖 `C1.AppendMessageUseCase`——双向。必须在 NestJS Module 层用 `forwardRef` 打破循环，核心包之间只单向 `import type` 接口，无实现级环。
- **风险（phase 泄漏成持久态）**：若 C2 的 phase 被误落库或被 C1 当 StreamStatus 读，会重现 stop/abort 卡死。C2 的 phase 是内存实体字段、不落库；跨上下文传递回合结果时只传 `StreamStatus` 终态映射（terminal 子态 → C1 的 completed/interrupted/error），不传 phase 本身。
- **风险（子进程类 agent 进程僵死）**：将来若接入本机子进程类 agent（如 app-server 形态），可能出现 fatal config stderr 后 linger ~30s、spawn EINVAL（Windows `.cmd` shim）、stop 后进程僵死等问题。这些必须锁在该 agent 自己的适配器内部并 fail-fast，不让"一个 Runtime 的进程病"卡死整个 C2 的回合生命周期。本期未接入此类 agent，风险暂不触发。
- **风险（中断后 turn/thread 残留）**：ClaudeCode 的 `Query` 句柄（`lockId` 归属）中断后需显式关闭；将来接入的子进程类 agent 的 thread/turn 同理。C2 的 `abort()` 不变量必须包含"通知对应适配器关闭其 Runtime 侧 turn"，否则下一轮发送语义错乱（对齐 CLAUDE.md 优先排查方向第 4 点）。
