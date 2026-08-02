---
title: 需求文档 (PRD) — C2 AgentRuntime 智能体运行时
context: C2 · AgentRuntime
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C2 · AgentRuntime（智能体运行时）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C2 有大量"用户可见的实时状态/相位/中断标记/token 用量"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能：

| 用户可见字段 | 语义（用户会怎么理解） | 真实来源 breadcrumb | 缺失来源时的降级 |
|---|---|---|---|
| "正在生成中" / 转圈 | 现在这一刻还在流式吗 | `StreamSession.phase === 'active'`（**实时相位**，内存态） | 无 phase 记录（回合已 GC）→ 视为非流式，不显转圈 |
| composer"能否发送" | 我现在能不能再发一条 | `StreamSession.canAccept()`（≡ `phase !== active`，领域方法） | 无 StreamSession → `canAccept()=true`（无活跃回合即可发） |
| "已停止" / "生成停止" | 是我点了停止 | `terminate(reason=ABORTED)` → phase=`terminal(aborted)`；错误经 `SK.ErrorClassifier` 归 `ABORTED` 类 | 不得把 `ABORTED` 显示成"出错了"（与真实错误区分） |
| "出错了" + 错误文案 | AI 回合失败了，什么原因 | `StreamSession.error: ClassifiedError`（`SK.ErrorClassifier.classify` 结果，16 类） | 无法归类 → `UNKNOWN` 类，显通用文案，不猜具体原因 |
| 流式文本 / 思考 / 工具块 | AI 输出的正文/推理/工具调用 | `AgentStreamEvent`（由各 Runtime 的 EventMapper 从原生事件归一） | Mapper 无法识别的原生事件 → 丢弃或包 `raw`，不伪造内容 |
| 当前 Runtime | 这轮是哪个 Runtime 在跑 | `StreamSession.runtimeKind`（本期仅 `claude-sdk`；其他 AI agent 运行时为未具名预留扩展点），发起时锁定 | 无（发起时必有） |
| Runtime 可用性 | 对应 AI agent 能不能用 | `AgentRuntimePort.availability()`（本期 ClaudeSdkRuntimeAdapter 探 SDK 可用性；不启进程） | 探测失败 → `unavailable` + 原因，不显假 `ready` |
| token 用量 | 这轮花了多少 token | `result` 事件里 Runtime 上报的 `TokenUsage` | Runtime 未上报 → 字段为空，**不显假 0**（经 C1 落库时也留空） |
| 上下文用量 | 上下文窗口用了多少 | `contextUsage` 事件（Runtime 上报的实测投影） | 未上报 → 隐藏指示器，不显固定估算值 |

**原则**：`phase` 是 C2 实时内存态，绝不落库、绝不与 C1 持久 `StreamStatus` 混用；`ABORTED` 与真实错误在 UI 上必须可分；token/上下文用量无实测来源时留空而非假 0。

## 1. 功能需求 (Functional Requirements)

### FR-1 StreamSession 实体与 phase 状态机（领域不变量）
- FR-1.1 `StreamSession` 是一次 AI 回合的实时聚合根，持有 `id`、`sessionId`（关联 C1 会话）、`runtimeKind`、`phase`、累积产物（text/thinking/tool_uses/tool_results）、`tokenUsage`、`error` 等。
- FR-1.2 `phase` 是状态机 `active → settling → terminal`，`terminal` 有子态 `{ completed, aborted, errored }`。phase **只能经领域方法迁移**（`markSettling` / `complete` / `abort` / `fail`），不允许外部直接赋值。
- FR-1.3 合法迁移：`active → settling`、`active → terminal`、`settling → terminal`；非法迁移（任意 `terminal → *`、`terminal → active` 回退）必须被拒绝（抛或 no-op，需固定并单测）。
- FR-1.4 **abort 不变量（核心）**：任意 abort 路径执行后，phase **必然**落在 `terminal` 子态（`aborted` 或已到 `completed`/`errored`），**绝不停在 `active`**。这是 CodePilot stop/abort 卡死的类型级切断。
- FR-1.5 `settling` 相位表示"已请求中断/上游已发终止信号，但产物收尾/turn 关闭尚未完成"——用于把"用户已点停止"与"仍在正常生成"区分，同时不立刻丢弃收尾产物。
- FR-1.6 `StreamSession.canAccept(): boolean` 是领域方法，语义 ≡ `phase !== 'active'`（`settling`/`terminal` 均可接受新发送）。composer 的 isStreaming gate 统一走此方法，不再散落 `phase==='active'` 比较（切断 GitHub #578 复合发送排队卡死）。

### FR-2 发起回合（`StartStreamUseCase`）
- FR-2.1 `StartStreamUseCase.start(input)` 接受一次发送请求（`sessionId`、`content`、`mode`、`model`、`providerId`、可选 `files`/`mentions`/`effort`/`thinking`/`context1m`/`selectedSkills` 等），选中 Runtime，创建 `StreamSession(phase=active)`，返回其 id + 事件流句柄。
- FR-2.2 Runtime 选择基于 `providerId` 对应的 Provider 协议（经只读 `C7.ProviderRepository`）：**本期仅支持 anthropic 协议 → `CLAUDE_SDK`**，发起时锁定 `runtimeKind`；其他协议本期 unsupported，将来由新 agent 适配器自声明。
- FR-2.3 发起前经 `C1.GetSessionHistoryUseCase.getPromptView` 拿喂模型的历史投影（剔除 render-only 标记），C2 不自己读 `messages` 表。
- FR-2.4 若 session 已有 `active` 回合，`start` 前先 `abort` 旧回合（对齐现有 `startStream` 的"abort old stream first"），保证同一 session 至多一个 active 回合。
- FR-2.5 回合终态时经 `C1.AppendMessageUseCase.append` 落 assistant 消息、经 `updateStreamStatus` 把持久 `StreamStatus` 推进（terminal 子态 → C1 的 `completed`/`interrupted`/`error` 映射）；C2 不直接写库。
- FR-2.6 空回合（无 text/thinking/tool）终态不落 assistant 消息（对齐现有 `buildFinalMessageContent` 返回 null 的语义）。

### FR-3 中断回合（`AbortStreamUseCase`）
- FR-3.1 `AbortStreamUseCase.abort(streamId)` 请求中断：若 `phase !== active` 直接返回（幂等，无活跃回合无需中断）。
- FR-3.2 **force-abort 安全网无条件先行**：先无条件安排 force-abort 定时器（到期若仍 `active` 则强制翻终态），**再**发 best-effort 优雅 interrupt。force-abort **绝不**排在 interrupt 的 `.finally`/`.then` 之后（GitHub #578 根因：interrupt 挂起 → `.finally` 不执行 → 永不 abort → phase 停 active）。
- FR-3.3 优雅 interrupt 返回 Runtime 的权威状态（如外部 agent 适配器的 runtime_status），若上游已确认终态则在微任务里 `reconcile` 把 phase 收敛到 terminal（不等 reader reject）；`running`/未知状态不纠正（force-abort 网仍兜底）。
- FR-3.4 abort 经 `SK.ErrorClassifier` 归为 `ABORTED` 独立错误类（非真实错误），phase 落 `terminal(aborted)`。
- FR-3.5 abort 必须通知对应 Runtime 适配器**关闭其 Runtime 侧 turn/thread/Query 句柄**（本期 ClaudeCode 的 `Query` + `lockId` 归属），避免残留导致下一轮发送语义错乱。
- FR-3.6 idle-timeout（回合长时间无事件）与 tool-timeout 走同一 abort 路径翻终态，但归类不同（idle/tool timeout 归 `TIMEOUT`/`PROCESS`，非 `ABORTED`），供 UI 区分"我停的" vs "超时了"。

### FR-4 AgentStreamEvent 统一事件模型
- FR-4.1 定义 `AgentStreamEvent` 联合，覆盖：`text` / `thinking` / `tool_use` / `tool_result` / `tool_output` / `status` / `result`（含 tokenUsage） / `error` / `permission_request` / `permission_resolved` / `context_usage` / `rate_limit` / `phase_changed` / `file_changed` / `task_update` 等（对齐现有 `consumeSSEStream` 回调集合）。
- FR-4.2 每个 Runtime 适配器带一个 `EventMapper`，把该 Runtime 的原生事件（本期 ClaudeCode SDK 消息）归一成 `AgentStreamEvent`。核心只消费归一后的事件。
- FR-4.3 Mapper 无法识别的原生事件按明确规则处理（丢弃或包成 `raw`/`unknown` 事件），不伪造内容、不静默改变已识别事件语义。
- FR-4.4 `result` 事件携带 `TokenUsage` 投影（Runtime 上报的实测值）；无上报时字段为空，C2 不估算、不填 0。

### FR-5 多 Runtime 抽象（`AgentRuntimePort` + 适配器）
- FR-5.1 `AgentRuntimePort` 是 C2 定义的出站端口：`run(request): AsyncIterable<AgentStreamEvent>`（或等价的订阅式）、`interrupt(turnRef)`、`availability()`。**本期仅 `ClaudeSdkRuntimeAdapter` 一个实现**；`AgentRuntimePort` 是未具名的预留扩展点，将来加新 AI agent 时再各自实现一个适配器，不在本期预设具体实现。
- FR-5.2 `ClaudeSdkRuntimeAdapter`（本期实现）：封装 `@anthropic-ai/claude-agent-sdk` 的 `Query`，管理 `Query` 句柄注册 + `lockId` 归属（late-unregister no-op，对齐 `conversation-registry.ts`）、`abortConversation` + `Query.interrupt()` 组合中断。
- FR-5.3 **预留扩展点（未具名）**：将来若接入走 HTTP SSE 协议的新 AI agent，由其专属适配器封装该 provider 的 SSE 流 + `AbortController` 中断 + SSE 帧 `EventMapper`。本期不实现、不预设具体 provider/agent 名。
- FR-5.4 **预留扩展点（未具名）**：将来若接入需要本机子进程 + JSON-RPC 的新 AI agent，由其专属适配器封装 binary 发现/spawn/僵死处理/orphan 规避/thread 中断，**进程级复杂度全部隔离在该适配器内、不得泄漏到核心**。本期不实现、不预设具体 agent 名。
- FR-5.5 `AgentRuntimePort` 供 **C3** 复用（引用图 `C2.AgentRuntimePort ← C3`）：C3 发起子 agent AI 调用时注入本端口，C2 不感知子 agent 概念。

### FR-6 TitleGenerator（供 C1）
- FR-6.1 `TitleGenerator.generateTitle(input)` 接受会话上下文（近期消息纯文本），用某个 Runtime 生成标题字符串返回；C1 只消费返回值（落地引用图 `C2.TitleGenerator ← C1`）。
- FR-6.2 C2 独占标题生成的提示词/模型/Runtime 选择；失败时可抛（由 C1 用例就地降级，见 C1 FR-2.4）。
- FR-6.3 `generateTitle` 是**非流式一次性**调用（不产生用户可见 StreamSession / 不进 composer gate），与主回合流式路径隔离。

### FR-7 权限与决议中转（不做经纪）
- FR-7.1 C2 把 Runtime 产出的权限请求归一成 `permission_request` 事件对外发出（携带 `permissionRequestId`、工具名、输入、可选 `approvalToken`/`suggestions`）。
- FR-7.2 C2 接收上层（经 C5 经纪后）的决议回传（allow/allow_session/deny + 可选 updatedInput/denyMessage），转发给对应 Runtime 适配器。
- FR-7.3 C2 **不做**权限经纪判定（自动批准策略、超时自动拒绝的策略归 C5）；C2 只负责事件产出与决议转发的忠实中转。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/agent-runtime/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process` 等框架/SDK/进程模块；禁止直接 `Date.now()`/`randomUUID()`。SDK/进程/HTTP 细节全锁在适配器层。
- NFR-2 **phase 不落库、不泄漏**：`StreamSession.phase` 是内存实时态，不写任何持久层；C2 不建模 C1 的持久 `StreamStatus`（只经 `C1.AppendMessageUseCase` 端口把终态映射写回）。类型层面 C2 不 import C1 的 `StreamStatus` 做实时判断。
- NFR-3 **abort 健壮性**：force-abort 安全网无条件先行；`StreamSession` 与 abort 逻辑可用假 Runtime 端口 + 假 Clock 做纯单元测试，可复现 #578（interrupt 永不 settle）并断言 phase 仍翻终态。
- NFR-4 **Runtime 故障隔离**：任一 Runtime 的进程僵死/spawn 失败/init 失败必须 fail-fast 并归一成 `ClassifiedError`，不阻塞其他 Runtime、不卡死 C2 的回合生命周期。将来接入的子进程类 agent 适配器若出现 30s linger 类问题，必须由其适配器内部提前 stderr 快失败切断。
- NFR-5 **可测**：本期 `ClaudeSdkRuntimeAdapter` 与其 `EventMapper` 可用录制的原生事件样本做表驱动归一测试；核心用例用假 `AgentRuntimePort` 测，无需真实 SDK/进程/网络。
- NFR-6 **可观测**：回合关键路径（发起/中断/终态/Runtime 选择）经 `SK.RuntimeLog` 记（脱敏后）source=`c2.stream`/`c2.runtime.<adapter>` 等。
- NFR-7 **i18n**：C2 产生的用户可见文案（状态行、错误提示、中断提示）经 `SK.TranslationPort`，C2 只贡献 `c2.*` message keys；错误文案 key 来自 `SK.ErrorClassifier` 的 `messageKey`。
- NFR-8 **一致性**：回合终态与 C1 落库在语义上对齐——terminal(completed)→StreamStatus.completed、terminal(aborted)→interrupted、terminal(errored)→error；不出现"C2 说完成、C1 存 streaming"的漂移。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.2/1.3）phase 状态机：`active→settling→terminal` 合法迁移单测通过；非法迁移（`terminal→active` 等）被拒绝。断言 phase 只能经领域方法改。
- AC-2（FR-1.4，**核心反例 smoke**）任意 abort 路径后 phase ∈ terminal 子态，**绝不停 active**：注入"interrupt 永不 resolve"的假 Runtime，abort 后经 force-abort 网 phase 仍翻 `terminal(aborted)`（复现并回归 GitHub #578）。
- AC-3（FR-1.6）`canAccept()` ≡ `phase !== active`：active 时 `false`、settling/terminal 时 `true`；断言 composer gate 唯一走此方法（静态：核心内无散落 `phase==='active'` 判断被 gate 复用）。
- AC-4（FR-3.2）force-abort 无条件先行：用 spy 断言 `scheduleForceAbort` 在 `requestInterrupt` 之前调用，且不依赖 interrupt 的 resolve；interrupt 抛错/超时时 force-abort 仍已安排。
- AC-5（FR-3.4/3.6，反例）abort 归 `ABORTED`、idle-timeout 归 `TIMEOUT`、tool-timeout 归 `PROCESS`/`TIMEOUT`——三条路径归类不同，UI 可区分"我停的"vs"超时"vs"出错"（断言 `ClassifiedError.code` 不同）。
- AC-6（FR-3.5）abort 后对应适配器的 turn/thread/Query 关闭被调用：假适配器断言 `interrupt(turnRef)` / 句柄注销被触发；ClaudeCode 侧 late-unregister（旧 lockId）为 no-op。
- AC-7（FR-4.1/4.2）本期 ClaudeSdkRuntimeAdapter 的录制原生事件样本经其 EventMapper 归一成 `AgentStreamEvent` 序列（表驱动）；将来新 agent 适配器各自补充其原生样本归一测试。
- AC-8（FR-4.3）Mapper 遇未知原生事件按规则降级（丢弃/包 raw），断言不抛、不污染已识别事件。
- AC-9（FR-4.4/0 反假数据）Runtime 未上报 tokenUsage 时 `result` 事件该字段为空，落 C1 时亦留空，断言 UI 层不出现假 `0`。
- AC-10（FR-5.3/5.4）适配器隔离：核心包禁用 import 扫描对 `child_process`/`@anthropic-ai/*` 等 0 命中。本期仅 `ClaudeSdkRuntimeAdapter`，其故障归一成 `ClassifiedError`；将来新 agent 适配器的 fail-fast（如外部 agent 进程僵死）由该适配器自测，不在本期预设。
- AC-11（FR-2.4）同一 session 已有 active 回合时 `start` 先 abort 旧回合，断言旧回合 phase 翻终态、新回合 active，同一 session 至多一个 active。
- AC-12（FR-2.5/NFR-8）终态→C1 落库映射：completed/aborted/errored 分别映射 C1 的 completed/interrupted/error，断言无"C2 完成但 C1 存 streaming"漂移；经假 `AppendMessageUseCase` 验证只经端口写、不直写库。
- AC-13（FR-6/NFR-2）`TitleGenerator` 非流式：调用不创建用户可见 StreamSession、不影响 composer gate；失败可抛供 C1 降级。
- AC-14（NFR-1）对 `agent-runtime/` 核心包做禁用 import 静态扫描（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`Date.now`/`randomUUID`），0 命中。
- AC-15（NFR-2）静态断言 C2 核心不把 C1 `StreamStatus` 用于实时判断、phase 不出现在任何持久化路径。

## 4. 依赖与假设

- 依赖 SK 已交付：`ErrorClassifier`（16 类含 `ABORTED`）、`Clock`/`IdGenerator`/`RuntimeLog`/`TranslationPort` 端口稳定（见 SK architecture 第 4 节）。
- 依赖 C1 已交付：`AppendMessageUseCase`（含 `append` + `updateStreamStatus`）、`GetSessionHistoryUseCase`（`getPromptView`）；C2 只 `import type`，经 DI 注入。
- 依赖 C7 已交付：只读 `ProviderRepository`（C2 消费 Provider 协议/endpoint/auth/model）；C2 不写 Provider。
- 假设 C3 复用 `AgentRuntimePort`（C2 不感知子 agent）；C5 做权限经纪与 IM 路由（C2 只中转权限事件/决议）。
- 假设 C1↔C2 循环依赖（C1 依赖 `C2.TitleGenerator`、C2 依赖 `C1.AppendMessageUseCase`）在 NestJS Module 层用 `forwardRef` 解，核心包只单向 `import type`。
- 假设各 Runtime 的原生事件可被录制成样本用于 Mapper 表驱动测试（无需真实网络/进程）。
