---
title: 需求文档 (PRD) — C6 Channel 渠道
context: C6 · Channel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C6 · Channel（渠道）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C6 存在大量"消费方（C5）与用户可见的能力清单、连接状态、渲染结果"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能。C6 最容易误导的是 **渠道能力（capabilities）** 与 **探测状态（ProbeResult）**——它们必须来自渠道插件的真实声明与实测，绝不能靠名字/前缀猜测或填假默认值。

### 0.1 渠道能力语义（`ChannelCapabilities`，头号反假面）

C5 会据能力清单决策"走流式卡片还是分片文本发送""能不能话题回复""能不能搜索历史"。若能力谎报，直接导致投递策略选错。每个能力字段的语义与来源：

| 能力字段 | 消费方（C5）会怎么理解 | 真实来源 breadcrumb | 语义红线 |
|---|---|---|---|
| `streaming` | 这个渠道能不能流式更新一张卡片（边生成边刷） | `ChannelPlugin.getCapabilities().streaming` + `getCardStreamController()` 是否返回非 null | 声明 `streaming=true` 必须真能拿到 `CardStreamController`；否则 C5 会尝试流式失败后无降级 |
| `threadReply` | 能不能以话题/回复形式发送 | 渠道插件声明（如飞书 threadSession 能力） | 不支持须 `false`，C5 不发 replyTo |
| `search` | 能不能服务端搜索历史消息 | 渠道插件声明 | **飞书 `search=false`**：只有本地过滤、无 user_access_token 的真服务端搜索——不得因"能列历史"就谎报 search=true |
| `history` | 能不能读历史消息 | 渠道插件声明 | 与 search 语义区分：history=能读、search=能查 |
| `reactions` | 能不能加表情反应 | 渠道插件声明 | 飞书当前 `reactions=false`（onMessageStart 的 Typing 反应是内部确认机制，不作为对外能力谎报） |

**红线**：`getCapabilities()` 必须与渠道实现同源、如实声明。C5 消费能力前**禁止基于 channelType 名字猜测能力**（不得"看到 feishu 就假设支持流式"）。反例 smoke：一个声明 `streaming=true` 但 `getCardStreamController()` 返回 null 的插件视为**契约违规**，必须在探测/加载期暴露而非静默让 C5 走进死路。

### 0.2 探测结果与渲染结果语义

| 用户/消费方可见字段 | 语义（会怎么理解） | 真实来源 breadcrumb | 缺失/不确定来源时的降级 |
|---|---|---|---|
| `ProbeResult.ok` | 这个渠道现在连不连得上 | `ProbeChannelUseCase` → 渠道插件 `probe()` 实测（如飞书 getBotInfo） | 未探测=不显 ok，须显式"未测试"；探测失败=`ok:false` + 脱敏 error |
| `ProbeResult.botName`/`botId` | 连上的是哪个机器人 | 探测实测返回（飞书 identity.getBotInfo） | 未连通留空，不填假名 |
| 渲染结果（卡片 JSON / HTML） | 这段内容在该渠道会长什么样 | Markdown → `markdownToIR` → 渠道渲染器实测输出 | 空 Markdown → 空结果（返回空数组/空串），不返回占位假内容 |
| 分片结果（chunks） | 超长内容被切成几块 | IR 级 `chunkMarkdownIR` + 渠道长度上限实测切分 | 未超限 → 单块（`[ir]`）；不预先假设块数 |

**原则**：没有真实来源的字段一律隐藏 / 标 unsupported / 明确写"未探测"。渠道配置里的 `appSecret` / bot token 等凭据**永不**作为可见字段返回，也不进日志明文（经 `SK.Redactor`）。

## 1. 功能需求 (Functional Requirements)

### FR-1 ChannelPlugin 合约（C6 拥有的核心合约）
- FR-1.1 定义 `ChannelPlugin<T>` 泛型接口，`T` 为渠道自身配置类型（如 `FeishuConfig`）。合约方法覆盖：`meta`（channelType + displayName）、`loadConfig(): T | null`、`getCapabilities(): ChannelCapabilities`、`start()/stop()/isRunning()`（生命周期）、`consumeOne(): Promise<InboundMessage | null>`（消费入站）、`send(msg): Promise<SendResult>`（出站发送）、`validateConfig(): string | null`、`isAuthorized(userId, chatId): boolean`（渠道自身入站准入判定）。对齐现有 `channels/types.ts`。
- FR-1.2 可选合约方法：`getCardStreamController(): CardStreamController | null`（流式卡片）、`probe(): Promise<ProbeResult>`（连通性探测）、`onMessageStart(chatId)`/`onMessageEnd(chatId)`（生命周期钩子，如飞书加/去 Typing 反应）。可选方法在渠道不支持时返回 null / 不实现，消费方按可选处理。
- FR-1.3 `ChannelMeta` 声明渠道类型与展示名：`channelType`（稳定枚举，如 `feishu`/`telegram`/`discord`）+ `displayName`（人读名，如 `Feishu / Lark`）。
- FR-1.4 合约的入站准入 `isAuthorized(userId, chatId)` 是**渠道自身配置层面**的准入判定（如飞书 dmPolicy/groupPolicy/allowFrom/groupAllowFrom），承接现有 `feishu/policy.ts` 的 `isUserAuthorized`——群聊按 `oc_` 前缀 + groupPolicy 判定、私聊按 dmPolicy 判定。这是渠道合约一部分，**不是** C5 的跨渠道权限经纪。

### FR-2 渠道能力探测（`ChannelCapabilities` + `ProbeChannelUseCase`）
- FR-2.1 `getCapabilities()` 返回 `ChannelCapabilities{ streaming, threadReply, search, history, reactions }`，每项如实反映渠道实际支持（§0.1）。能力可能依赖配置（如某渠道未配 token 时降级），须在调用时反映当前有效能力。
- FR-2.2 `ProbeChannelUseCase` 给定渠道类型 + 配置，探测连通性：调用渠道插件 `probe()`，返回 `ProbeResult{ ok, error?, botName?, botId? }`。用于渠道设置页"测试连接"与 C5 启动前预检。
- FR-2.3 探测失败优雅降级：连接异常经 `SK.ErrorClassifier` 归类（NETWORK/AUTH/TIMEOUT 等），`ProbeResult.ok=false`，error 经 `SK.Redactor` 脱敏后记 `SK.RuntimeLog`，不抛出。
- FR-2.4 `ProbeChannelUseCase` 同时返回该渠道当前能力清单（`getCapabilities()`），让设置页"测试连接"一次性拿到"连通性 + 能力"。
- FR-2.5 探测是**连通性能力探测**（连上没、是哪个 bot、支持什么），**不是**消费入站消息或路由（`consumeOne`/路由属运行时，归 C5 编排）。

### FR-3 渠道特定渲染（Markdown → IR → 渠道格式）
- FR-3.1 定义 `MarkdownIR` 中间表示：`{ text, styles: StyleSpan[], links: LinkSpan[] }`——纯文本 + 样式区间（bold/italic/strikethrough/code/code_block/blockquote）+ 链接区间。`markdownToIR(markdown, options)` 把 Markdown 解析成 IR（承接现有 `bridge/markdown/ir.ts`），options 含 linkify/headingStyle/blockquotePrefix/enableTables 等渠道差异开关。
- FR-3.2 定义 IR → 渠道格式的通用渲染器 `renderMarkdownWithMarkers(ir, options)`：options 提供 `styleMarkers`（每种 style 的 open/close 标记）+ `escapeText`（渠道转义）+ `buildLink`（链接渲染）。承接现有 `render.ts`。渠道差异只在 options，不在渲染器逻辑。
- FR-3.3 各渠道渲染器（C6 拥有）：
  - **Telegram**：`markdownToTelegramHtml` / `markdownToTelegramChunks`——IR → HTML 子集（`<b>/<i>/<s>/<code>/<pre><code>/<blockquote>/<a>`），并做文件引用防误链（`README.md` 等含 TLD 后缀的裸文件名不被 linkify 成 `http://README.md`，包 `<code>`），承接现有 `telegram.ts`。
  - **飞书**：复杂度判定 `hasComplexMarkdown`（含代码块/表格 → 走 schema 2.0 卡片 `buildCardContent`；其余 → 走 post 消息 `buildPostContent`），`htmlToFeishuMarkdown`（命令响应 HTML → 飞书 markdown），承接现有 `feishu.ts`。
  - **Discord** 等其余渠道渲染器同构承接。
- FR-3.4 渲染期消息分片（IR 级）：`chunkMarkdownIR(ir, limit)` 按文本长度上限切分 IR，切分后每块的样式 span / 链接 span 相对该块重新归零且不越界（`sliceStyleSpans`/`sliceLinkSpans`）；Telegram 的 render-first 分片（先按 IR 文本切，渲染成 HTML 后若超 HTML 长度上限再二次切）语义完整承接现有 `renderTelegramChunksWithinHtmlLimit`。**分片是渲染期产物**（把长内容切成渠道可接收的块），投递级的顺序/重试调度归 C5。
- FR-3.5 渲染核心为**纯函数**：`markdownToIR` / `renderMarkdownWithMarkers` / 各渠道渲染器 / 分片函数只吃字符串 + 选项、吐字符串/结构，不碰网络/文件/渠道 SDK，可表驱动单测。

### FR-4 流式卡片生命周期合约（`CardStreamController`）
- FR-4.1 定义 `CardStreamController` 接口：`create(chatId, initialText, replyToMessageId?): Promise<string>`（建卡片，返回平台消息 id，失败返回空串触发降级）、`update(messageId, text): Promise<'ok'|'fail'>`（流式更新，内部节流）、`finalize(messageId, finalText, status?): Promise<void>`（收尾，status=completed/interrupted/error）。承接现有 `channels/types.ts` 的 `CardStreamController`。
- FR-4.2 可选流式增强：`updateToolCalls?(messageId, tools: ToolCallInfo[])`（工具调用进度显示）、`setThinking?(messageId)`（文本流出前的思考态）。
- FR-4.3 渠道提供 `getCardStreamController()` 返回实现（如飞书 `createCardStreamController(client, cardStreamConfig)`）或在不支持/未连接时返回 null。**C6 只定义接口与渠道实现，不编排 create/update/finalize 的时序**——何时建卡、以什么节奏更新、何时收尾由 C5 消费时决定（FR 边界）。

### FR-5 渠道插件供给端口（`ChannelPluginPort<T>`，供 C5 消费）
- FR-5.1 `ChannelPluginPort<T>` 出站端口：给定 channelType，解析出对应渠道插件实例（`ChannelPlugin<T>`），供 C5 拿到能力、渲染器、`CardStreamController`、`consumeOne`/`send` 接口。
- FR-5.2 端口抽象"如何拿到某渠道类型的插件"（注册表/工厂），由适配器实现（承接现有 `registerAdapterFactory` 自注册 + `channel-plugin-adapter` 桥接）。C5 通过该端口取插件，不直接 new 渠道插件、不了解飞书 gateway/WS 细节。
- FR-5.3 端口能列出"当前支持哪些渠道类型"（供 C5 与设置页枚举可配置渠道）。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/channel/` 禁止 import `@larksuiteoapi/*`/Telegram/Discord/QQ SDK、`ws`、`fs`/`path`/`os`、`better-sqlite3`、`@nestjs/*`；渠道 SDK 连接、WS/长轮询、发送全经 `ChannelPluginPort` 注入的适配器。Markdown → IR → 渠道格式渲染、分片等**纯字符串逻辑**以纯函数放核心。
- NFR-2 **安全（凭据）**：渠道配置里的 `appSecret` / bot token 等凭据只在渠道插件适配器内存在，绝不进 `ChannelCapabilities`/`ProbeResult` 等可见返回体、不进 `SK.RuntimeLog` 明文、不跨上下文广播。日志中出现的凭据段与绝对路径经 `SK.Redactor` 脱敏。
- NFR-3 **能力诚实**：`getCapabilities()` 与渠道实现同源、如实声明（§0.1）；C5 禁止基于名字前缀猜能力；`streaming=true` 必须真能拿到 `CardStreamController`。
- NFR-4 **渲染保真**：渲染结果可被对应渠道 API 直接接收，不破样式/不吞链接/不破代码块；分片后 span 不越界/不错位、渲染后在渠道长度上限内。渠道怪癖（Telegram 文件引用防误链、飞书代码块走卡片）收在渠道渲染器内。
- NFR-5 **错误统一**：渠道连接/发送/探测底层异常经 `SK.ErrorClassifier` 归类；C6 自身业务错误用稳定 code + i18n messageKey（`c6.*`），消费方拿 code 而非裸 message。
- NFR-6 **i18n**：渠道错误/探测文案经 `SK.TranslationPort`，C6 只贡献自己的 message keys（`c6.*`）。
- NFR-7 **可测**：渲染纯函数表驱动测试（各 style/link/表格/代码块/分片场景）；`ChannelPlugin` 合约可用内存假插件（可编程能力、可编程连接失败、可编程渲染）做纯单元测试，无需真实渠道 SDK / 网络。`ProbeChannelUseCase` 用假插件测连通/失败/脱敏路径。
- NFR-8 **可扩展**：新增渠道只需实现 `ChannelPlugin<T>` + 提供渠道渲染器（styleMarkers/escapeText/buildLink），核心 IR 管线与 C5 编排零改动（S5）。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.1/1.2）给定一个实现 `ChannelPlugin<T>` 的假插件，合约全部必选方法可调用、可选方法缺失时消费方按可选优雅处理（`getCardStreamController` 返回 null 不崩）。
- AC-2（FR-1.4）**渠道准入反例**：飞书假配置 `groupPolicy='allowlist'` + `groupAllowFrom=['oc_x']`，`isAuthorized('u','oc_x')=true`、`isAuthorized('u','oc_y')=false`；`dmPolicy='disabled'` 时私聊 `isAuthorized` 恒 false（承接 policy.ts 语义）。
- AC-3（FR-2.1/§0.1）**能力诚实反例**：飞书插件 `getCapabilities()` 返回 `search=false`、`reactions=false`、`streaming=true`；断言声明 `streaming=true` 的插件 `getCardStreamController()` 在已连接时返回非 null（能力与实现同源）。
- AC-4（FR-2.2/2.3）探测一个可连渠道 → `ProbeResult.ok=true` + botName/botId 有值；探测一个连不上的渠道 → `ok=false` + 脱敏 error，不抛；探测异常经 `SK.ErrorClassifier` 归类。
- AC-5（FR-2.4）`ProbeChannelUseCase` 一次调用同时返回 `ProbeResult` 与该渠道 `ChannelCapabilities`。
- AC-6（FR-3.1）**IR 保真**：`markdownToIR` 对含 bold/italic/code/code_block/link/表格的 Markdown 产出 IR，styles/links span 边界正确、不越界。
- AC-7（FR-3.3 Telegram）**渲染 + 防误链反例**：`markdownToTelegramHtml('见 README.md')` 中 `README.md` 被包 `<code>` 而非渲染成 `<a href="http://README.md">`；bold/code_block 渲染成正确 HTML 标记。
- AC-8（FR-3.3 飞书）**复杂度分流反例**：含 ```` ``` ```` 代码块或表格的 Markdown → `hasComplexMarkdown=true` → `buildCardContent`（schema 2.0 卡片）；纯文本 → `hasComplexMarkdown=false` → `buildPostContent`（post 消息）。
- AC-9（FR-3.4）**分片 span 反例**：一段超 limit 的带样式 Markdown 经 `chunkMarkdownIR` 切成多块，每块的 styles span 相对该块从 0 起且不越出块长；跨块的样式在两块内各自闭合正确。
- AC-10（FR-3.4 Telegram）render-first 分片：一段渲染后 HTML 超 Telegram 上限的 Markdown → `markdownToTelegramChunks` 二次切分，每块渲染后 HTML 长度 ≤ 上限。
- AC-11（FR-3.5/NFR-1）渲染核心纯函数：`markdownToIR`/`renderMarkdownWithMarkers`/各渠道渲染器/分片函数在无网络无文件环境下可运行并产出确定结果（相同输入相同输出）。
- AC-12（FR-4.1/4.3）**流式卡片合约反例**：假 `CardStreamController` 的 `create` 返回空串时消费方触发降级路径（不把空 id 当有效卡片）；`finalize` 的 status 三态（completed/interrupted/error）可分。
- AC-13（FR-5.1/5.2）`ChannelPluginPort<T>` 给定 `channelType='feishu'` 解析出飞书插件、`channelType='telegram'` 解析出 Telegram 插件；未知类型 → 结构化错误 `unknown_channel`。
- AC-14（NFR-1）对 `channel/` 核心包做禁用 import 静态扫描（`@larksuiteoapi/*`/Telegram/Discord SDK/`ws`/`fs`/`path`/`os`/`better-sqlite3`/`@nestjs/*`），0 命中。
- AC-15（NFR-7）用内存假 `ChannelPluginPort`/假插件跑通全部 FR 用例，证明 C6 核心不依赖真实渠道适配器（换适配器不动核心）。
- AC-16（NFR-2）**凭据不外泄反例**：含 appSecret 的飞书配置经探测/渲染路径，`SK.RuntimeLog` 里 appSecret 经 `SK.Redactor` 脱敏、不明文；`ProbeResult` 不含 appSecret/token。
- AC-17（S7 边界反例）C6 无路由/投递/重试/权限经纪能力：断言 C6 端口无 `route`/`deliver`/`retry`/`permissionBroker` 方法；渲染只产 chunk 不决定投递顺序、`CardStreamController` 只定义接口不编排时序。

## 4. 依赖与假设

- 依赖 SK 已交付：`Redactor` / `ErrorClassifier` / `RuntimeLog` / `TranslationPort` 端口稳定（见 SK architecture §4）作为**横切**注入；契约 C6「依赖端口：无核心依赖」——C6 对任何**业务上下文**零依赖，仅横切用 SK。
- C6 的消费方是 C5 Bridge（经 `ChannelPluginPort<T>` 取插件与能力、经渲染端口取渲染结果、经 `ProbeChannelUseCase` 预检）；C6 只**供给合约/能力/渲染**，C5 负责**路由/投递/重试/权限经纪/流式时序编排**。落地引用图 `C6.ChannelPluginPort ← C5`。
- 假设渠道配置由上层（渠道设置页 / C5）给定并传入；C6 不决定"用哪个渠道配置"。
- 假设本机 NestJS 进程拥有建立渠道连接（飞书 WS、Telegram 长轮询等）的网络权限（单机形态成立）。
- 假设 `ChannelPlugin<T>`/`ChannelCapabilities`/`ProbeResult`/`CardStreamController`/`MarkdownIR` 领域类型由 C6 拥有并从 C6 桶文件导出；现有 `channels/types.ts` 与 `bridge/markdown/*` 在重构后迁入 C6 domain/渲染层。
- 假设 `InboundMessage`/`OutboundMessage`/`SendResult`/`ChannelType` 是 C5↔C6 共享的消息形状契约；C6 只 `import type` 引用（或下沉为共享契约），不拥有其路由投递语义。
