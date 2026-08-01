---
title: 需求 — C5 Bridge IM 桥接
context: C5 · Bridge
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 需求：C5 · Bridge（IM 桥接）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。依赖端口签名见 C6/C1/C2/SK 各 architecture.md。

## 0. 语义契约（先读，防"管道通了但状态不是用户以为的意思"）

C5 的用户可见 / 跨上下文可见字段必须有明确语义与 source breadcrumb。没有真实来源的字段隐藏或标 unsupported，不得显示假值。

| 字段 | 语义（用户/消费者怎么理解） | source breadcrumb | 缺失 / 降级 |
|---|---|---|---|
| `BridgeStatus.running` | 桥接运行时**当前是否**在跑 adapter loop | `bridge-runtime.state.running`（内存实测，非配置意图） | 未启动=false，不冒充 |
| `AdapterStatus.connectedAt` | 该渠道 adapter **实测**连上的时刻 | `C6.ProbeChannelUseCase` / adapter start 成功回时 | 未连=null，不填 now |
| `AdapterStatus.lastMessageAt` | 该渠道**最后一次**收到入站的实测时刻 | `runAdapterLoop` 收到 `consumeOne` 非空时 `Clock.now()` | 从未收=null |
| `AdapterStatus.error` | 该渠道最近一次**实测**失败（脱敏） | `SK.ErrorClassifier` 归类 + `SK.Redactor` 脱敏 | 无错=null，不填占位串 |
| `ChannelCapabilities.streaming` | 该渠道**能否**流式卡片（决定走卡片 or 分片） | `C6.ProbeChannelUseCase`/`plugin.getCapabilities()`（实现同源） | **禁止按 channelType 名字猜**；缺失按 false 降级 |
| `DeliveryResult.ok` | 这批 payload **实测**是否投递成功 | `C6.ChannelPlugin.send` 返回 `SendResult.ok` | 失败=false + 分类 error，不冒充 ok |
| `DeliveryResult.messageId` | 平台返回的**实测**消息 id | `SendResult.messageId` | 无=undefined，不造 id |
| `committedOffset` | 已**处理完成**的水位线（at-least-once 边界） | `channel_offsets` 表，仅 handleMessage 完成后推进 | 崩溃恢复读回上次 committed，宁可重复不丢 |
| `PermissionLink.status` | 该权限请求的**实测**决议（allow/deny/pending） | IM 回调 → `resolvePermission`；未回=pending | pending 不冒充 allow/deny |
| `ChannelBinding.codepilotSessionId` | 该 IM chat 绑定的**真实** C1 会话 id | `channel_bindings` 表 + `ManageSessionUseCase` | 未绑定→路由时创建，不指向不存在会话 |
| `cardMessageId`（流式卡片 id） | 流式卡片的**平台消息 id** | `CardStreamController.create` 返回值 | **空串=create 失败**→降级普通分片，不当有效卡片 |

**反假数据红线**：`streaming` 能力必须来自 C6 实测（S6 / AC-13）；`committedOffset` 只在处理完成后推进（S3 / AC-6）；`DeliveryResult.ok` 不冒充（AC-8）；`PermissionLink.status` 不把 pending 当已决议（AC-11）；`cardMessageId` 空串走降级（AC-14）。

## 1. 功能需求 (Functional Requirements)

### FR-1 入站路由（RouteInboundMessageUseCase）
- **FR-1.1** 给定 `InboundMessage`（渠道地址 + 文本 + 附件 + 可选 callbackData），按 `channelType + chatId` 解析 `ChannelBinding`；未绑定则经 `C1.ManageSessionUseCase.create` 创建会话 + 建绑定（承接现有 `channel-router.resolve` / `createBinding` / `bindToSession`）。
- **FR-1.2** 渠道自身准入：入站先经 `C6.ChannelPlugin.isAuthorized(userId, chatId)` 过滤（渠道配置层准入，非跨渠道权限经纪）；未授权丢弃 + 记审计。
- **FR-1.3** callback query（IM 内联按钮回调）分流：`callbackData` 携带权限决议 → 走权限经纪回传（FR-4），不当普通消息路由。
- **FR-1.4** 路由后经 `C2.StartStreamUseCase.start` 发起回合（绑定的 provider/model/mode/workingDirectory 作为参数），拿到 `AgentStreamEvent` 流交投递 + 卡片时序编排。
- **FR-1.5** 一个绑定同一时刻单活跃回合：新入站到达时若该会话有 active 回合，按策略排队或提示忙（承接现有 session lock `Session is busy`）——lock 语义由 C2/C1 负责，C5 只消费其结果不重造锁。
- **FR-1.6** 用户消息与 AI 回复经 `C1.AppendMessageUseCase` 落库（复用 web 端同一 `<!--files:JSON-->` 附件格式），C5 不直写 `messages`。

### FR-2 出站投递（DeliveryPort）
- **FR-2.1** 取渲染 payloads：经 `C6.RenderMessageUseCase.render(channelType, markdown)` 拿"渲染后 + 渲染期切好块"的 `payloads`；C5 **不做** Markdown→渠道渲染（属 C6），只做投递级编排。
- **FR-2.2** 投递级顺序保证：多 payload 按序投递，块间插入 `INTER_CHUNK_DELAY_MS` 防限速乱序（承接现有 `delivery-layer.deliver`）。
- **FR-2.3** 限速：每 chat 令牌桶限速（现有 `ChatRateLimiter` 20 msg/min），超限排队不丢。
- **FR-2.4** 重试：`send` 失败指数退避重试（`MAX_RETRIES`=3、`BASE_DELAY_MS` + jitter），错误经 `SK.ErrorClassifier` 归类决定是否可重试（4xx 不重试）。
- **FR-2.5** 降级：彻底失败或渠道能力不支持时降级（如流式卡片 create 失败 → 普通分片文本投递），降级路径记 `RuntimeLog`。
- **FR-2.6** dedup + 引用跟踪：出站按内容 / 消息 id dedup 防重发（现有 `checkDedup`/`insertDedup`）；记 `insertOutboundRef` / `insertAuditLog` 供审计（经 `DeliveryLogPort` 出站，不直写 DB）。

### FR-3 流式卡片时序编排
- **FR-3.1** 仅当绑定渠道 `ChannelCapabilities.streaming=true`（经 C6 实测能力）才走卡片路径；否则走普通分片投递（FR-2）。
- **FR-3.2** 消费 `C2.AgentStreamEvent` 驱动 `C6.CardStreamController`：首个 `text` → `create(chatId, initialText, replyTo)`；后续 `text` 增量 → `update(cardMessageId, fullText)`（C5 侧节流合并，承接现有 `StreamingPreviewState` 节流 + `degraded` 标记）；`thinking` → 可选 `setThinking`；`tool_use`/`tool_result` → 可选 `updateToolCalls`；终态 → `finalize(cardMessageId, finalText, status)`（`completed`/`interrupted`/`error` 三态映射自 C2 终态）。
- **FR-3.3** `create` 返回空串 → 判定卡片建失败，降级为 FR-2 普通分片投递，不把空 id 当有效卡片（AC-14）。
- **FR-3.4** 节流内部化：`update` 有节流（现有 `throttleTimer` + `lastSentAt`），一次 API 失败后置 `degraded=true` 跳过后续 preview，终态仍走 `finalize`。C5 拥有节流时序，C6 controller 拥有实际 API 调用。

### FR-4 权限经纪（PermissionBrokerPort，供 C3 复用）
- **FR-4.1** 消费流期间的 `permission_request` 事件（C2 归一自 Runtime），**在流阻塞期间**把请求转成 IM 内联按钮 `OutboundMessage`（allow/deny + 可选 AskUserQuestion 选项）发出去（承接现有 `forwardPermissionRequest`，破解 deadlock）。
- **FR-4.2** 建立 `permissionRequestId ↔ IM message` 映射（现有 `PermissionLink` + `channel_permission_links` 表，经 `PermissionLinkRepository` 出站）。
- **FR-4.3** IM 回调携带决议 `callbackData` → 按唯一 `permissionRequestId` **定向**决议回该次 Runtime 调用（现有 `handlePermissionCallback` / `handleAskUserQuestionCallback`），不串会话。
- **FR-4.4** 交互式工具不支持时明确拒绝并给理由（现有 `isBridgeUnsupportedInteractiveTool` + `AskUserQuestionRejectReason`）。
- **FR-4.5** 会话被中断 / 结束时自动批准 / 清理该会话的 pending 权限（现有 `autoApprovePendingForSession`），避免悬挂。
- **FR-4.6** `PermissionBrokerPort` 供 **C3 子 agent** 复用（引用图 `C5.PermissionBrokerPort ← C3`）：C3 把子 agent 权限请求经此端口转交、消费决议——C5 不感知调用方是主会话还是子 agent。

### FR-5 桥接生命周期与绑定管理
- **FR-5.1** `ManageBridgeUseCase`：start / stop / restart / status（承接现有 `bridge-manager`）。start 后对每个启用渠道起 `runAdapterLoop`（`consumeOne` 循环）；stop 优雅关闭全部 adapter。
- **FR-5.2** `runAdapterLoop`：`while(running) { msg = await plugin.consumeOne(); if (msg) route(msg); commitOffset(); }`——**offset 安全水位分离**：`fetchOffset`（拉取用）与 `committedOffset`（持久化）分离，**仅 route 处理完成后推进 committed**（承接现有 offset 约定，at-least-once）。
- **FR-5.3** 启动前预检：经 `C6.ProbeChannelUseCase` 探测连通 + 能力，探测失败的渠道不起 loop，状态记 `error`（脱敏）。
- **FR-5.4** `ManageBindingUseCase`：列 / 建 / 改 / 删 `ChannelBinding`（`channel_bindings` 表，经 `BindingRepository` 出站）；改绑定的 provider/model/mode/workingDirectory。
- **FR-5.5** HMR / 单例协调：dev 环境防 adapter loop 重复起（承接现有 `globalThis.bridgeModeActive` 标志），生产进程正常单实例。

## 2. 非功能需求 (NFRs)

- **NFR-1（零框架 / 零 SDK / 零 DB 核心）**：`packages/core/bridge/` 禁止 import `@larksuiteoapi/*` / Telegram / Discord SDK / `ws` / `@anthropic-ai/*` / `better-sqlite3` / `@nestjs/*` / `node:*`。所有渠道 I/O 经 `C6.ChannelPluginPort`、AI 经 `C2` 用例、会话 / 绑定 / offset / 权限链接持久化经 C5 出站端口，静态扫描 0 命中（AC-15）。
- **NFR-2（凭据 / PII 不外泄）**：入站 `raw`、渠道凭据、用户 displayName 等在日志经 `SK.Redactor` 脱敏；审计日志只存 summary 不存全文；错误只带 `code` + `messageKey`（`c5.*`），`meta` 不含凭据。
- **NFR-3（at-least-once 交付）**：committed offset 仅处理完成后推进；进程崩溃 / 重启从上次 committed 恢复，宁可重复处理（靠 dedup 兜底）也不丢消息（AC-6）。
- **NFR-4（渠道故障隔离）**：一个渠道 adapter 崩 / 连不上不影响其它渠道 loop；`runAdapterLoop` 内错误经 `ErrorClassifier` 归类记录，可重连的重连、不可恢复的标 error 停该 loop，不 crash 整个桥接。
- **NFR-5（i18n）**：用户可见文案（含 IM 发出的提示 / 权限按钮文本 / 忙提示）用 `c5.*` messageKey 经 `SK.TranslationPort` 渲染，同步 `en.ts`/`zh.ts`，不硬编码。
- **NFR-6（错误分类）**：投递 / 探测 / 路由错误经 `SK.ErrorClassifier` 归一（NETWORK/AUTH/TIMEOUT/RATE_LIMIT 等），决定重试 / 降级策略；不自造错误分类。
- **NFR-7（可测性）**：全部用例可在内存假端口（假 `ChannelPluginPort` + 假插件、假 C1/C2 用例、假 Repository）上跑单测，无需真实渠道 SDK / AI / 网络 / DB（AC-16）。
- **NFR-8（新渠道零核心改动）**：新增渠道只在 C6 加插件 + 渲染器；C5 的路由 / 投递 / 权限编排经端口消费，不因新渠道改核心（能力经 `getCapabilities` 消费，不按名字分支）。

## 3. 验收标准 (Acceptance Criteria)

- **AC-1** 入站路由：`channelType+chatId` 稳定解析同一绑定；未绑定自动经 `C1.ManageSessionUseCase` 建会话 + 绑定，二次入站命中同一会话（FR-1.1）。
- **AC-2** 渠道准入：`isAuthorized=false` 的入站丢弃不路由，记审计；`=true` 正常路由（FR-1.2）。
- **AC-3** callback 分流：权限决议 callbackData 走经纪回传、不当普通消息起回合（FR-1.3，反例：普通文本 vs callback 走不同路径）。
- **AC-4** 闭环：假 `StartStreamUseCase` 发 `text...result` 事件序列 → 经 `DeliveryPort` 投出，断言 IM 收到分片文本（FR-1.4/FR-2）。
- **AC-5** 单活跃回合：会话有 active 回合时新入站按 busy 处理（消费 C2/C1 lock 结果），不并发起两回合（FR-1.5）。
- **AC-6（反假数据 / at-least-once）** offset 水位：route 处理**成功后**才推进 committed；模拟处理中崩溃 → committed 不推进，重启从上次 committed 重放（FR-5.2/NFR-3）。
- **AC-7** 投递顺序 + 限速：多 payload 按序投出、块间有延迟、超速排队不丢（FR-2.2/2.3）。
- **AC-8（反假数据）** 投递结果：`send` 失败 → `DeliveryResult.ok=false` + 分类 error，不冒充 ok；成功才带 `messageId`（FR-2.4）。
- **AC-9** 重试 + 降级：可重试错误指数退避重试、4xx 不重试；彻底失败降级记日志（FR-2.4/2.5）。
- **AC-10** dedup：相同内容 / 消息 id 重复投递被 dedup 拦截不重发（FR-2.6）。
- **AC-11（反假数据）** 权限映射：`permissionRequestId ↔ IM message` 唯一映射；回调按 id 定向决议回对应 Runtime 调用，不串会话；未回状态为 pending 不冒充（FR-4.2/4.3）。
- **AC-12** 权限 deadlock 破解：假 `permission_request` 在流阻塞期间被转成 IM 按钮发出（流消费**期间**而非返回后），回调决议后流继续（FR-4.1，反例：不转发则流永久阻塞）。
- **AC-13（反假数据 / 能力同源）** 流式卡片能力：`streaming=true`（经 C6 实测）走卡片、`streaming=false` 走普通分片；断言 C5 **不按 channelType 名字猜** streaming（FR-3.1，反例：假插件谎报 vs 实测）。
- **AC-14** 卡片降级：假 `CardStreamController.create` 返回空串 → 降级普通分片投递，不把空 id 当有效卡片调 update/finalize（FR-3.3）。
- **AC-15（静态检查）** `bridge/` 核心包禁用 import 扫描（`@larksuiteoapi/*`/Telegram/Discord SDK/`ws`/`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`node:*`）0 命中（NFR-1）。
- **AC-16（可替换）** 全部用例跑在内存假 `ChannelPluginPort` + 假 C1/C2 用例 + 假 Repository 上全绿，证明核心不依赖真实渠道 / AI / DB（NFR-7）。
- **AC-17** 渠道故障隔离：一个渠道 loop 抛错 → 该 loop 标 error 停，其它渠道 loop 继续；桥接不整体 crash（NFR-4，反例）。
- **AC-18（C3 复用）** `PermissionBrokerPort` 被 C3 子 agent 消费：假 C3 调用方经同一端口转交子 agent 权限、消费决议，C5 编排不区分主会话 / 子 agent 调用方（FR-4.6）。
- **AC-19（边界断言）** C5 无渠道渲染方法（无 `markdownToTelegramHtml` 等）、无会话 / 消息实体定义、无 `StreamPhase` / `StreamSession`、无 Provider 配置——只 `import type` 引用（NFR-1，接口断言证明缺失）。

## 4. 依赖与约束

- 依赖 `C6.ChannelPluginPort` / `RenderMessageUseCase` / `ProbeChannelUseCase` / `CardStreamController`（渠道能力，只引用不重写）。
- 依赖 `C1.ManageSessionUseCase` / `AppendMessageUseCase` / `GetSessionHistoryUseCase`（会话 / 消息，经用例读写不直写 DB）。
- 依赖 `C2.StartStreamUseCase` / `AbortStreamUseCase` + `AgentStreamEvent` 类型（AI 运行时，消费事件不重造流式相位）。
- 依赖横切 `SK`：`ErrorClassifier` / `Redactor` / `Clock` / `IdGenerator` / `RuntimeLog` / `TranslationPort`。
- 承接现有 CodePilot `src/lib/bridge/`：`bridge-manager`（生命周期 + `runAdapterLoop`）、`channel-router`（路由 / 绑定）、`conversation-engine`（消费 SSE，重构为经 C2 用例）、`delivery-layer`（分片 / 限速 / 重试 / dedup）、`permission-broker`（权限转 IM 按钮）、`channel-adapter`（`registerAdapterFactory`——注意：适配器合约 `BaseChannelAdapter`/插件实现属 **C6**，C5 只经 `ChannelPluginPort` 消费），以及 `channel_bindings` / `channel_offsets` / dedup / 审计 / 权限链接表。
