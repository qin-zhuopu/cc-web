---
title: 产品简报 — C6 Channel 渠道
context: C6 · Channel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C6 · Channel（渠道）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 一句话定位

C6 是 CodePilot Web 里负责**定义"一个 IM 渠道长什么样"的合约层**：它拥有 `ChannelPlugin<T>` 插件合约、渠道能力探测（`ChannelCapabilities` / `ProbeResult`）、以及**渠道特定渲染**（把 CodePilot 产生的 Markdown 经中间表示 IR 翻译成飞书卡片 / Telegram HTML 等各渠道原生格式）。它把"每个渠道的协议差异、能力差异、渲染差异"收口成一组稳定接口——但它**不做入站路由、出站投递、权限经纪、消息分片编排**（那属 C5 Bridge）。C6 只回答"这个渠道能干什么、它的消息该怎么渲染、它连不连得上"，不回答"这条消息该发给谁、什么时候发、发失败怎么重投"。

## 2. 解决什么问题

CodePilot 现有 `src/lib/channels/`（`ChannelPlugin<T>` 合约、`channel-plugin-adapter`、飞书渠道插件模块化拆分 `types/config/gateway/inbound/outbound/identity/policy/card-controller/index`）与 `src/lib/bridge/markdown/`（`ir` / `render` / `feishu` / `telegram` / `discord` 渲染器）承载了渠道抽象与渲染两条能力。重构为"本机运行的 Web 应用"后，需要把它们收口进六边形架构，让"渠道是什么"（C6 合约与渲染）与"消息怎么被路由投递"（C5 编排）彻底分离。

痛点集中在：

- **渠道能力差异散落、易被误判**：不同渠道支持的能力不同——飞书支持流式卡片（`streaming`）、话题回复（`threadReply`）、历史（`history`），但反应（`reactions`）与真正的服务端搜索（`search`）不支持；Telegram 支持不同的 HTML 子集与消息长度上限。若能力判断散落在各消费方（"这个渠道能不能流式""能不能发超过 N 字符"各写一遍），就会出现"UI 声称支持流式、实际渠道没这能力"这类**能力谎报**，直接影响 C5 该走流式卡片还是分片发送的决策。
- **渲染契约不清、Markdown 直接怼进渠道 API 会坏**：AI 产出的是通用 Markdown（粗体、代码块、表格、链接、文件引用）。飞书要的是 schema 2.0 卡片或 post 消息，Telegram 要的是特定 HTML 子集且要防 `README.md` 被误识别成域名链接。若不经统一的 IR 中间层，每个渠道各自正则处理 Markdown，就会样式错乱、链接被吞、代码块破损、超长消息被 API 拒收。现有 `markdown → IR → 渠道格式` 管线（`markdownToIR` → `renderMarkdownWithMarkers`）已经把这套解耦，C6 要把它作为**渠道渲染合约**的核心资产收口。
- **流式卡片生命周期是渠道特有能力，不能泄进编排**：飞书的 `CardStreamController`（create → update → finalize，含节流、工具调用进度、thinking 态）是渠道特有的流式 UI 能力。C5 需要用它，但不该知道飞书卡片 schema 细节；C6 用 `CardStreamController` 接口把这套生命周期抽象出来，C5 只按接口 create/update/finalize。
- **新增渠道的接入面要窄**：现有靠"实现 `BaseChannelAdapter` + `registerAdapterFactory()` 自注册"接入新渠道。重构后应让"新增一个渠道"只需实现 `ChannelPlugin<T>` 合约 + 提供渠道渲染器，不动 C5 编排、不动核心。C6 的合约质量直接决定新渠道接入成本。

## 3. 目标用户与价值

- **消费 C6 的其他上下文（唯一直接消费方是 C5 Bridge）**：C5 在做入站路由、出站投递、权限经纪、消息分片时，需要知道"当前渠道支持哪些能力"（决定流式 vs 分片）、"这段 Markdown 在这个渠道该渲染成什么"（拿到可直接投递的渠道原生格式）、"这个渠道现在连不连得上"（`ProbeChannelUseCase`）。C5 通过 C6 的 `ChannelPluginPort<T>` 拿到渠道实例与能力、通过渲染端口拿到渲染结果，然后由 **C5 自己**负责路由、投递、重试、分片、权限。C6 只供给合约、能力、渲染，不编排。
- **单机开发者用户（间接）**：用户在渠道设置页配置飞书/Telegram 等渠道、点"测试连接"（触发 `ProbeChannelUseCase`）看渠道是否连通、看渠道支持哪些能力。C6 保证用户看到的"能力清单""连接状态"来自渠道插件的真实声明与实测探测，不糊假状态。

价值主张：**把"每个渠道支持什么能力、它的消息该怎么渲染成原生格式、它连不连得上"收口成一份稳定、可探测、渲染一致的渠道合约，让 C5 拿到诚实的渠道能力与可直接投递的渲染结果，而不必了解任何单个渠道的协议细节；让新增渠道只需实现合约 + 渲染器。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C6 契约：

- **拥有**：
  - **ChannelPlugin 合约**：`ChannelPlugin<T>` 泛型接口（`meta` / `loadConfig` / `getCapabilities` / `start` / `stop` / `isRunning` / `consumeOne` / `send` / `validateConfig` / `isAuthorized` / 可选 `getCardStreamController` / `probe` / 生命周期钩子），`T` 是渠道自身配置类型。
  - **渠道能力探测**：`ChannelCapabilities`（streaming / threadReply / search / history / reactions）声明、`ProbeResult`（ok / error / botName / botId）连通性探测、`ChannelMeta`（channelType / displayName）。
  - **渠道特定渲染**：Markdown → IR（`MarkdownIR`：text + styleSpans + linkSpans）→ 渠道格式的翻译管线，以及各渠道渲染器（飞书卡片/post、Telegram HTML、Discord 等）、渲染期的消息分片（IR 级 chunk，保样式跨块）、`CardStreamController` 流式卡片生命周期合约。
- **不包含**：
  - **路由/投递编排** —— "这条入站消息该路由到哪个会话""这条出站消息该发给哪个渠道/chat""发送失败如何重投""长消息的投递级分片与顺序保证""流式卡片何时 create/update/finalize 的时序编排"全部属 **C5 Bridge**。C6 只提供渲染结果（含"渲染期已切好的 chunk"）与 `CardStreamController` 接口，不决定何时投、投给谁、失败怎么办。
  - **权限经纪与访问放行**：渠道插件的 `isAuthorized(userId, chatId)`（如飞书的 dmPolicy/groupPolicy/allowFrom）是渠道**自身配置层面的入站准入判定**，属渠道插件合约的一部分（C6 拥有）；但跨渠道的权限经纪、AI 工具调用的 canUseTool 放行属 C5.PermissionBroker + C2，C6 不做。
  - 会话/消息生命周期（C1）、AI 流式（C2）、Provider 配置（C7）、MCP/Skill（C9）。
- **依赖端口（只引用，不重写）**：
  - 契约表声明 C6 **无核心依赖**（对任何业务上下文零依赖，是最独立的上下文之一）。仅可横切使用 SK 端口：`SK.Redactor`（脱敏渲染/探测日志里的 token、appSecret、绝对路径）、`SK.ErrorClassifier`（把渠道连接/发送异常归类）、`SK.RuntimeLog`（记渠道启停/探测日志）、`SK.TranslationPort`（渠道错误文案 i18n）。均为横切注入，不重写。
- **对外提供端口**：
  - `ChannelPluginPort<T>` —— 出站端口，抽象"如何拿到某渠道类型的插件实例、它的能力、它的渲染器"，供 C5 消费。渠道插件的真实实现（飞书 gateway/WS 连接、Telegram 长轮询等）由适配器提供，不进核心。
  - `ProbeChannelUseCase` —— 驱动端口，给定渠道类型 + 配置，探测连通性（`ProbeResult`）并返回能力清单，供渠道设置页"测试连接"与 C5 启动前预检。

## 5. 与 CodePilot 现有实现的对应

| C6 概念 | 现有落点 |
|---|---|
| `ChannelPlugin<T>` 合约 + `ChannelCapabilities`/`ProbeResult`/`ChannelMeta`/`CardStreamController` | `src/lib/channels/types.ts` |
| 插件→BaseChannelAdapter 桥接（供 C5 消费的适配点） | `src/lib/channels/channel-plugin-adapter.ts`（`ChannelPluginAdapter`） |
| 飞书渠道插件（模块化拆分） | `src/lib/channels/feishu/`：`index`（编排 plugin）、`types`（FeishuConfig/CardStreamConfig）、`config`（loadConfig/validateConfig）、`gateway`（WS 连接）、`inbound`（消息解析）、`outbound`（sendMessage/reaction）、`identity`（getBotInfo）、`policy`（isUserAuthorized 访问控制）、`card-controller`（createCardStreamController 流式卡片） |
| Markdown → IR 中间表示 | `src/lib/bridge/markdown/ir.ts`（`markdownToIR` / `MarkdownIR` / `chunkMarkdownIR` IR 级分片 + 保样式） |
| IR → 渠道格式的通用渲染器 | `src/lib/bridge/markdown/render.ts`（`renderMarkdownWithMarkers`：styleMarkers + escapeText + buildLink） |
| 飞书渲染器（卡片/post/复杂度判定） | `src/lib/bridge/markdown/feishu.ts`（`hasComplexMarkdown` / `buildCardContent` schema 2.0 / `buildPostContent` / `htmlToFeishuMarkdown`） |
| Telegram 渲染器（HTML + 文件引用防误链 + render-first 分片） | `src/lib/bridge/markdown/telegram.ts`（`markdownToTelegramHtml` / `markdownToTelegramChunks` / `wrapFileReferencesInHtml`） |
| Discord 渲染器 | `src/lib/bridge/markdown/discord.ts` |

> 现有实现把"渠道合约与渲染"（`lib/channels/` + `lib/bridge/markdown/`）与"路由投递编排"（`lib/bridge/` 的 `channel-router` / `delivery-layer` / `conversation-engine` / `permission-broker` / `bridge-manager`）放在相邻甚至同一 `bridge/` 目录下，边界模糊。C6 只拥有**合约、能力、渲染**：渲染器与 IR 管线、`ChannelPlugin`/`CardStreamController` 合约归 C6；`channel-router`（路由）、`delivery-layer`（投递/重试）、`conversation-engine`（入站接会话）、`permission-broker`（权限经纪）、`bridge-manager`（生命周期编排）全部归 C5。**关键红线**：`markdown/` 渲染器现在物理位于 `bridge/` 目录下，但它是**渲染逻辑**（把 Markdown 翻成渠道格式）——按边界它属 C6，重构时从 `bridge/` 迁入 C6，C5 只调用 C6 的渲染端口拿结果。

## 6. 成功标准（可度量）

- **S1 能力诚实**：`ChannelPlugin.getCapabilities()` 返回的每一项能力（streaming/threadReply/search/history/reactions）与渠道实际支持一致；飞书 `search=false`（无 user_access_token 时只有本地过滤）、`reactions=false` 等如实声明，不谎报。C5 据此决策流式 vs 分片、能否话题回复，不出现"UI 说支持、实际不支持"。
- **S2 渲染一致且可直接投递**：同一段 Markdown 经 C6 渲染器产出的渠道格式（飞书卡片 JSON / Telegram HTML）可被对应渠道 API 直接接收，不破样式、不吞链接、不破代码块；超长内容经 IR 级分片后每块样式跨界正确（span 不越界、不错位）、渲染后仍在渠道长度上限内。
- **S3 渲染纯函数化、零 I/O**：Markdown → IR → 渠道格式的渲染核心是纯函数（吃字符串 + 选项、吐字符串/结构），可表驱动单测，不碰网络/文件/渠道 SDK。真实渠道连接（WS/长轮询/HTTP 发送）全在适配器后。
- **S4 探测真实**：`ProbeChannelUseCase` 返回的 `ProbeResult.ok`/`botName`/`botId` 来自渠道实测（如飞书 getBotInfo），失败时 `ok=false` + 脱敏 error，不显假 connected；未探测的渠道不冒充"已连通"。
- **S5 新渠道接入面窄**：新增一个渠道只需实现 `ChannelPlugin<T>` 合约 + 提供一个渠道渲染器（styleMarkers + escapeText + buildLink），无需改 C5 编排、无需改 C6 核心的 IR 管线；`ChannelPluginPort<T>` 能按 channelType 解析出新渠道插件。
- **S6 边界纯净**：C6 核心不 import 任何路由/投递/权限编排概念，不 import `@larksuiteoapi/*`/Telegram SDK/`ws`/`fs`/`@nestjs/*`；渠道 SDK 连接、发送全在适配器。C6 对任何业务上下文零依赖。
- **S7 编排归属清晰**：C6 只提供渲染结果、能力、`CardStreamController` 接口、`ProbeResult`；"何时投、投给谁、失败重投、路由到哪个会话、卡片流式时序编排、权限经纪"全部在 C5，C6 无这些逻辑（边界纪律自检通过）。

## 7. 非目标（明确排除）

- 不做**入站路由**（把某渠道来的消息映射到某会话）——属 C5.RouteInboundMessageUseCase / conversation-engine。
- 不做**出站投递编排**（决定发给哪个渠道/chat、失败重投、投递级顺序保证、投递级分片调度）——属 C5.DeliveryPort / delivery-layer。C6 只提供"渲染期切好的 chunk"作为供给。
- 不做**流式卡片的时序编排**（何时 create、以什么节奏 update、何时 finalize、与 AI 流式事件如何对齐）——那属 C5 消费 `CardStreamController` 时的编排；C6 只定义 `CardStreamController` 接口与飞书实现。
- 不做**跨渠道权限经纪与 AI 工具放行**（canUseTool、PermissionBroker）——属 C5 + C2。C6 只保留渠道插件自身的入站准入判定（`isAuthorized`，如飞书 dmPolicy/groupPolicy）作为渠道合约一部分。
- 不做会话/消息生命周期（C1）、AI 流式生成（C2）、Provider 配置（C7）、MCP/Skill（C9）。
- 不替 SK 重新实现脱敏 / 错误分类 / 日志 / i18n。

## 8. 关键风险与假设

- **风险（能力谎报）**：`getCapabilities()` 与渠道真实能力脱节。必须让能力声明与渠道实现同源（飞书 `search=false` 因为只有本地过滤而非服务端搜索，须在文档与类型注释中说明语义），C5 消费能力前不做前缀猜测。对应 PRD §0 能力语义表。
- **风险（渲染破损）**：Markdown 直接怼进渠道 API。必须强制走 IR 中间层——各渠道渲染器只提供 styleMarkers/escapeText/buildLink，不各自正则改 Markdown；Telegram 的文件引用防误链（`README.md` 不被当域名）、飞书的复杂度判定（代码块/表格走卡片、其余走 post）等渠道怪癖须收在渠道渲染器内，不泄进 IR 或 C5。
- **风险（分片错位）**：超长消息分片后样式 span 越界或错位。IR 级分片（`chunkMarkdownIR` / sliceStyleSpans / sliceLinkSpans）须保证 span 相对每块重新归零且不越界；Telegram 的 render-first 分片（先按 IR 切、渲染后若 HTML 超限再二次切）语义须完整承接。分片是**渲染期**产物，投递调度归 C5。
- **风险（凭据泄漏）**：渠道配置含 appSecret / bot token。渲染/探测日志绝不能明文带这些值；`SK.Redactor` 脱敏是最后防线；`ProbeResult` 只回 botName/botId 不回凭据。
- **假设**：本机 NestJS 进程拥有建立渠道连接（飞书 WS、Telegram 长轮询等）的网络权限；渠道配置由上层（渠道设置/C5）给定并传入。
- **假设**：`ChannelPlugin<T>` / `ChannelCapabilities` / `ProbeResult` / `CardStreamController` / `MarkdownIR` 等领域类型由 C6 拥有并从 C6 桶文件导出；现有 `channels/types.ts` 与 `bridge/markdown/ir.ts` 的类型在重构后迁入 C6 domain。
- **假设**：`InboundMessage` / `OutboundMessage` / `SendResult` / `ChannelType` 这类**入站/出站消息形状**是 C5↔C6 的共享契约。为守边界，C6 只 `import type` 引用它们（或将纯消息形状下沉到 SK/共享契约），不重写、不拥有其路由投递语义。
