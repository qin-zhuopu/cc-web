---
title: 产品简报 — C5 Bridge IM 桥接
context: C5 · Bridge
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C5 · Bridge（IM 桥接）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)，边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的渠道插件合约见 [../c6-channel/architecture.md](../c6-channel/architecture.md)；会话用例见 [../c1-conversation/architecture.md](../c1-conversation/architecture.md)；运行时见 [../c2-agent-runtime/architecture.md](../c2-agent-runtime/architecture.md)。

## 1. 定位一句话

C5 Bridge 是把外部 IM（飞书 / Telegram / Discord / …）接入 CodePilot 会话的**编排层**：它把 C6 的渠道插件、C1 的会话、C2 的运行时组合成一条闭环——"IM 消息 → 路由到会话 → 调 AI → 投递回 IM"，并在这条链路上负责入站路由、出站投递、权限经纪、消息分片这四件编排职责。C5 本身**不实现**任何渠道协议（属 C6）、不拥有会话逻辑（调 C1）、不做 AI 生成（调 C2）——它是这三者之上的运行时胶水与生命周期编排者，是全系统**依赖最多**的上下文（迁移顺序最后一个，11/11）。

## 2. 它解决什么用户问题

CodePilot 的核心价值是"在本机跑的 AI Agent"。但用户不总是坐在电脑前——他们希望能从手机上的飞书 / Telegram 里给正在本机运行的 Claude 发指令、看回复、批权限。现有 `src/lib/bridge/` 把这件事做出来了，但四类职责在演进中相互渗透，重构必须把它们拆清：

### 痛点 A：路由、投递、权限、生命周期混在一坨，改一处牵全身
现有 `bridge-manager.ts`（生命周期 + `runAdapterLoop`）、`channel-router.ts`（IM 地址 → 会话绑定）、`conversation-engine.ts`（消费 SSE 调 AI）、`delivery-layer.ts`（分片 / 限速 / 重试 / 降级）、`permission-broker.ts`（权限转 IM 按钮）虽已分文件，但它们直接 `import` DB、直接 `import` claude-client、直接调渠道 SDK——编排逻辑与 I/O 细节缠绕。想换个会话用例、换个 Runtime、换个渠道，都得动编排核心。**C5 要把这四类编排提炼成纯逻辑用例，I/O 全推到端口后。**

### 痛点 B：渠道协议细节泄进编排，新增渠道要改路由 / 投递
`delivery-layer.ts` 里 `TelegramChunk`、`PLATFORM_LIMITS`、飞书卡片这些渠道特定的东西直接进了投递编排。新增一个渠道，投递层就得改。**C5 只应经 `C6.ChannelPluginPort` / `RenderMessageUseCase` 拿"渲染后 + 切好块的 payloads"和"发送能力"，渠道差异锁在 C6 适配器后；C5 只编排"这些块按什么顺序 / 时机 / 重试策略投出去"。**

### 痛点 C：流式卡片的 create/update/finalize 时序编排无人明确拥有
飞书流式卡片要"先 create 拿 messageId，流式中 update，结束 finalize"。这套时序既涉及 C2 的 AI 流式事件（何时有新文本 / 工具事件 / 终态），又涉及 C6 的 `CardStreamController` 接口（怎么建 / 更 / 收卡片）。现有代码把它散在 `conversation-engine` 的回调与 bridge-manager 的节流里。按边界契约，**C6 只定义 `CardStreamController` 接口 + 渠道实现，时序编排明确归 C5**——C5 消费 C2 的 `AgentStreamEvent`，决定何时调 controller 的 create/update/finalize。

### 痛点 D：权限经纪的"IM 按钮 ↔ AI 审批"闭环容易断
AI 触发需审批工具时，SSE 流会**阻塞**等待权限决议（现有 `conversation-engine.ts` 注释明说这是 deadlock 根源）。C5 必须在流消费**期间**把权限请求转成 IM 内联按钮发出去，用户点按钮 → 回调 → 定向决议回该次 Runtime 调用。这套 `permissionRequestId ↔ IM message` 映射（现有 `permission-broker.ts` + `channel_*` / `PermissionLink` 表）是 C5 拥有的经纪逻辑；它还要经 `PermissionBrokerPort` **供 C3 子 agent 复用**（引用图 `C5.PermissionBrokerPort ← C3`）。经纪判定错 / 映射丢，用户就永远批不了权限、AI 永远卡住。

## 3. 边界（拥有 / 不含 / 依赖）

摘自 `context-boundaries.md` C5 行，逐条落地：

- **拥有**：入站路由（IM 地址 → 会话绑定 + 会话解析 / 创建）、出站投递（分片顺序 + 限速 + 重试 + 降级 + dedup + 引用跟踪）、权限经纪（AI 审批 ↔ IM 内联按钮双向映射与决议）、消息分片（投递级顺序保证，非渲染级切块——渲染切块在 C6）、桥接生命周期编排（adapter loop 启停、offset 水位线推进）、流式卡片时序编排（消费 C2 事件驱动 C6 `CardStreamController`）、渠道绑定 / 偏移持久化（`channel_bindings` / `channel_offsets`）。
- **不含**：渠道协议细节（WS / 长轮询 / Bot API / 卡片 schema / Markdown→渠道渲染，**全属 C6**，C5 经 `ChannelPluginPort` / `RenderMessageUseCase` 消费）、会话 / 消息生命周期（**属 C1**，C5 调 `ManageSessionUseCase` / `AppendMessageUseCase` / `GetSessionHistoryUseCase`）、AI 调用与流式相位（**属 C2**，C5 调 `StartStreamUseCase` / `AbortStreamUseCase` 消费 `AgentStreamEvent`）、Provider 配置（属 C7）、子 agent 编排（属 C3，C3 反过来复用 C5 的 `PermissionBrokerPort`）。
- **依赖端口**：`C6.ChannelPluginPort`（取渠道插件实例 + `consumeOne`/`send`/`getCardStreamController`/`isAuthorized`）、`C6.RenderMessageUseCase`（取渲染 + 分片 payloads）、`C6.ProbeChannelUseCase`（启动前预检连通 + 能力）、`C1` 会话用例（`ManageSessionUseCase`/`AppendMessageUseCase`/`GetSessionHistoryUseCase`）、`C2` 运行时（`StartStreamUseCase`/`AbortStreamUseCase` + `AgentStreamEvent` 类型）、横切 `SK`（`ErrorClassifier`/`Redactor`/`Clock`/`IdGenerator`/`RuntimeLog`/`TranslationPort`）。
- **对外提供端口**：`RouteInboundMessageUseCase`（入站路由 + 会话闭环，驱动）、`DeliveryPort`（出站投递，出站语义端口）、`PermissionBrokerPort`（权限经纪，**供 C3 复用**，落地引用图 `C5.PermissionBrokerPort ← C3`）；补充 `ManageBridgeUseCase`（生命周期）、`ManageBindingUseCase`（绑定管理）作为对外驱动端口。

## 4. 关键设计取向

- **C5 是"编排叶子上的编排根"**：它依赖最多（C1/C2/C6/SK），但除 C3 复用它的 `PermissionBrokerPort` 外**不被其它业务上下文依赖其领域概念**。这个位置决定了 C5 的核心资产是"用例编排 + 端口组合"，领域模型相对薄（绑定 / 偏移 / 权限链接 / 投递计划 / 桥接状态），复杂度在"怎么把别人的能力串成正确的闭环"。
- **闭环拆成四段可独立测的编排**：路由（谁 → 哪个会话）、生成（会话 + 运行时产出回复流）、投递（回复流 → IM）、权限（阻塞点 ↔ IM 按钮）。每段用例只依赖端口接口，可用内存假端口跑单测，不碰真实渠道 / AI / DB。
- **反假数据红线**：桥接状态（running / connectedAt / lastMessageAt / error）、投递结果（ok / messageId / 降级原因）、权限决议状态、offset 水位线必须是**实测投影**，不冒充。渠道能力**禁止基于 channelType 名字猜**（对齐 C6 §0.1），必须经 `ProbeChannelUseCase` / `getCapabilities` 拿真值；`streaming=false` 的渠道不得走流式卡片路径。
- **offset 安全水位分离**（承接现有 bridge CLAUDE.md）：`fetchOffset`（API 拉取用）与 `committedOffset`（持久化水位）分离，**仅 handleMessage 完成后才推进 committed**——保证进程崩溃 / 重启不丢消息、不重复处理。这是 C5 的 at-least-once 交付纪律。
- **绞杀者迁移最后一棒**：C5 最后迁移，前 10 个上下文的端口已就绪。C5 重构的价值是**验证整套六边形拆解的闭环正确性**——如果 C5 能只经端口把 C1/C2/C6 串成 IM 闭环、且核心零框架 / 零 SDK / 零 DB，就证明整个拆解的依赖倒置是自洽的。

## 5. 成功标准

- **S1（闭环通）**：一条 IM 入站消息经 `RouteInboundMessageUseCase` 解析绑定 → `StartStreamUseCase` 起回合 → 消费 `AgentStreamEvent` → 经 `DeliveryPort` 投递回 IM，全程只经端口，核心不 import 渠道 SDK / claude-client / better-sqlite3 / NestJS。
- **S2（路由正确）**：`channelType + chatId` 稳定解析 / 创建同一会话绑定；未绑定自动建会话（经 C1）；绑定持久化 `channel_bindings`。
- **S3（投递可靠）**：长回复按投递级顺序分片投出、限速不超渠道上限、失败指数退避重试、彻底失败降级、dedup 防重发；at-least-once（committed offset 仅处理完成后推进）。
- **S4（权限闭环）**：AI 审批请求在流消费期间转成 IM 内联按钮；回调决议由唯一 `permissionRequestId` 定向回该次 Runtime 调用；`PermissionBrokerPort` 供 C3 复用同一套经纪。
- **S5（流式卡片时序）**：`streaming=true` 渠道消费 C2 事件驱动 C6 `CardStreamController` 的 create→update→finalize；`create` 返回空串时降级为普通分片投递（不把空 id 当有效卡片）。
- **S6（反假数据）**：桥接 / 投递 / 权限 / offset 状态均为实测投影，无假 0 / 假 connected / 名字猜能力；`streaming=false` 渠道不走卡片路径。
- **S7（边界纪律）**：C5 不重写任何渠道渲染 / 会话实体 / 流式相位 / Provider 概念；跨上下文能力只 `import type` 引用；核心包禁用 import 静态扫描 0 命中。
