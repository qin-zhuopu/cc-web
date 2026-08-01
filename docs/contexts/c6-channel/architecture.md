---
title: 架构 — C6 Channel 渠道
context: C6 · Channel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C6 · Channel（渠道）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS ChannelController
                     (HTTP: GET /api/channels, POST /api/channels/:type/probe,
                            POST /api/channels/:type/render (预览渲染，可选))
               ↓ 调用驱动端口
        [驱动端口] ProbeChannelUseCase / RenderMessageUseCase
               ↓
        [应用核心] Domain Model + Use Cases（纯逻辑，零框架，零 SDK/ws/fs）
               ↓ 依赖倒置，只依赖接口
        [出站端口] ChannelPluginPort<T>
               +   （横切）SK: Redactor / ErrorClassifier / RuntimeLog / TranslationPort
               ↓ 由适配器实现
        [被驱动适配器] FeishuChannelPlugin（@larksuiteoapi WS + REST）
                       TelegramChannelPlugin（长轮询 + Bot API）
                       DiscordChannelPlugin / QQ / WeixinChannelPlugin ...
                       ChannelPluginRegistry（channelType → 插件工厂，承接 registerAdapterFactory）
```

依赖方向永远指向核心。C6 核心**只依赖 `ChannelPluginPort<T>` 接口与横切 SK 端口**，绝不 import `@larksuiteoapi/*`/Telegram/Discord SDK/`ws`/`fs`/`path`/`os`/框架/DB。按边界契约，C6 **无核心依赖**（对任何业务上下文零依赖，是最独立的上下文之一），仅横切用 SK；其对外产物由 **C5 Bridge 消费**（渠道插件实例 + 能力清单 + 渲染结果 + 探测状态 + `CardStreamController` 接口）。

**编排归属红线（最关键的一条边界）**：C6 只到"合约、能力、渲染、探测"为止——回答"这个渠道能干什么、它的消息该渲染成什么、它连不连得上、流式卡片接口长什么样"。"这条入站消息路由到哪个会话""这条出站消息发给哪个渠道/chat""发失败如何重投""长消息投递级顺序保证""流式卡片何时 create/update/finalize 的时序编排""跨渠道权限经纪"全部属 **C5 Bridge**。C6 的 `ChannelPlugin.probe` 是**连通性能力探测**（连一下、报是哪个 bot、报支持什么能力），不是运行时消息消费/路由。C6 的渲染只产出"渲染后的格式 + 渲染期切好的 chunk"，不决定投递顺序/时机。这条线若守不住，C6 会越界成"Bridge 运行时"，与 C5 职责重叠。

> **注意**：现有 `src/lib/bridge/markdown/`（IR + 各渠道渲染器）物理位于 `bridge/` 目录，但按边界它是**渲染逻辑**属 C6，重构时迁入 `packages/core/channel/rendering/`；`src/lib/bridge/` 其余（channel-router / delivery-layer / conversation-engine / permission-broker / bridge-manager）属 C5。

## 2. 目录结构

```
packages/core/channel/
├── domain/
│   ├── plugin/
│   │   ├── channel-plugin.ts          # ChannelPlugin<T> 合约接口（对外，供 C5）
│   │   ├── channel-meta.ts            # ChannelMeta 值对象（channelType + displayName）
│   │   ├── channel-type.ts            # ChannelType 枚举 + isKnownChannelType 纯函数
│   │   ├── channel-capabilities.ts    # ChannelCapabilities 值对象（5 能力）+ capabilitiesInvariant 校验
│   │   ├── probe-result.ts            # ProbeResult 值对象（ok/error/botName/botId）
│   │   └── card-stream-controller.ts  # CardStreamController + ToolCallInfo 接口（流式卡片合约）
│   ├── message/
│   │   ├── channel-message.ts         # InboundMessage/OutboundMessage/SendResult/MessageAddress（C5↔C6 共享消息形状；import type 或下沉共享契约）
│   │   └── attachment.ts              # FileAttachment 引用（承接 @/types，渠道无关形状）
│   ├── rendering/
│   │   ├── markdown-ir.ts             # MarkdownIR + StyleSpan + LinkSpan + MarkdownStyle 类型
│   │   ├── ir-parser.ts               # markdownToIR / chunkMarkdownIR 纯函数（承接 ir.ts）
│   │   ├── ir-renderer.ts             # renderMarkdownWithMarkers 纯函数（承接 render.ts）
│   │   ├── span-slicing.ts            # sliceStyleSpans / sliceLinkSpans / mergeStyleSpans / clamp 纯函数
│   │   └── channel-renderers/
│   │       ├── telegram-renderer.ts   # markdownToTelegramHtml / markdownToTelegramChunks / wrapFileReferencesInHtml 纯函数
│   │       ├── feishu-renderer.ts     # hasComplexMarkdown / buildCardContent / buildPostContent / htmlToFeishuMarkdown 纯函数
│   │       └── discord-renderer.ts    # markdownToDiscord ... 纯函数
│   ├── error/
│   │   └── channel-error.ts           # ChannelError + ChannelErrorCode
│   └── message-keys.ts                # C6 自身 i18n 键（c6.*）
├── ports/
│   ├── driving/
│   │   ├── probe-channel-usecase.ts   # ProbeChannelUseCase 驱动端口（契约对外）
│   │   └── render-message-usecase.ts  # RenderMessageUseCase 驱动端口（渲染预览/供 C5 取渲染结果）
│   └── driven/
│       └── channel-plugin-port.ts     # ChannelPluginPort<T> 出站端口（契约对外，供 C5 消费）
├── usecases/
│   ├── probe-channel.ts               # ProbeChannelService（实现 driving 端口）
│   └── render-message.ts             # RenderMessageService（选渠道渲染器 + 分片）
└── index.ts                           # 桶文件：仅导出端口与领域类型
```

> 具体渠道插件适配器（`FeishuChannelPlugin`/`TelegramChannelPlugin`/...）与 `ChannelPluginRegistry` 位于 `apps/api` 适配器层，不在核心包内。渲染层（IR 解析、IR 渲染、各渠道渲染器、分片）**全是纯函数放核心**（吃字符串/结构、吐字符串/结构），真正的 WS 连接/长轮询/HTTP 发送/getBotInfo 归适配器——见 §7 归属决策。

## 3. 领域模型 (Domain Model)

### 3.1 ChannelType / ChannelMeta — 渠道标识

```ts
// domain/plugin/channel-type.ts
export type ChannelType = 'feishu' | 'telegram' | 'discord' | 'qq' | 'weixin';

/** 已知渠道类型判定，纯函数（未知类型由 ChannelPluginPort 报 unknown_channel）。 */
export function isKnownChannelType(value: string): value is ChannelType;

// domain/plugin/channel-meta.ts
export interface ChannelMeta {
  readonly channelType: ChannelType;
  readonly displayName: string;              // 人读名，如 'Feishu / Lark'
}
```

> `ChannelType` 对齐现有 `bridge/types` 的 `ChannelType`。新增渠道在此扩枚举 + 提供插件 + 渲染器（NFR-8）。

### 3.2 ChannelCapabilities — 能力声明值对象（反假红线）

```ts
// domain/plugin/channel-capabilities.ts
export interface ChannelCapabilities {
  readonly streaming: boolean;      // 能否流式更新卡片（真则必须能拿到 CardStreamController，§0.1）
  readonly threadReply: boolean;    // 能否话题/回复
  readonly search: boolean;         // 能否服务端搜索（飞书=false：只有本地过滤，非 user_access_token 搜索）
  readonly history: boolean;        // 能否读历史（与 search 语义区分）
  readonly reactions: boolean;      // 能否加表情反应
}

/**
 * 能力不变量校验（纯函数）：声明 streaming=true 的插件必须能提供 CardStreamController。
 * 违规返回错误信号，供探测/加载期暴露而非静默让 C5 走死路（§0.1 红线）。
 */
export function capabilitiesInvariant(input: {
  readonly caps: ChannelCapabilities;
  readonly hasCardController: boolean;   // getCardStreamController() 是否返回非 null（已连接态）
}): { readonly ok: true } | { readonly ok: false; readonly violation: 'streaming_without_controller' };
```

> **反假数据核心契约**：能力必须与渠道实现同源。`capabilitiesInvariant` 把「`streaming=true` 却拿不到 controller」这类谎报变成可断言的违规（AC-3），而非运行时 C5 静默失败。C5 消费能力前**禁止基于 channelType 名字猜能力**。

### 3.3 ProbeResult — 连通性探测结果

```ts
// domain/plugin/probe-result.ts
export interface ProbeResult {
  readonly ok: boolean;              // 实测连通；未探测不构造此对象（不冒充 connected，§0.2）
  readonly error?: string;           // 已脱敏（经 SK.Redactor），仅诊断
  readonly botName?: string;         // 实测返回（如飞书 getBotInfo）；未连通留空
  readonly botId?: string;           // 实测返回；未连通留空
}
```

> 字段对齐现有 `channels/types.ts` 的 `ProbeResult`。`ProbeResult` **绝不含 appSecret/token**（NFR-2/AC-16）。

### 3.4 CardStreamController — 流式卡片生命周期合约

```ts
// domain/plugin/card-stream-controller.ts
export interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'complete' | 'error';
}

export interface CardStreamController {
  /** 建流式卡片；返回平台消息 id，失败返回空串（触发 C5 降级，不把空 id 当有效卡片，AC-12）。 */
  create(chatId: string, initialText: string, replyToMessageId?: string): Promise<string>;
  /** 流式更新卡片内容（内部节流）；返回 'ok'|'fail'。 */
  update(messageId: string, text: string): Promise<'ok' | 'fail'>;
  /** 收尾卡片并关流式模式；status 三态可分。 */
  finalize(messageId: string, finalText: string, status?: 'completed' | 'interrupted' | 'error'): Promise<void>;
  /** 可选：更新工具调用进度显示。 */
  updateToolCalls?(messageId: string, tools: ReadonlyArray<ToolCallInfo>): void;
  /** 可选：文本流出前设置思考态。 */
  setThinking?(messageId: string): void;
}
```

> 承接现有 `channels/types.ts` 的 `CardStreamController`。**C6 只定义接口 + 渠道实现（如飞书 card-controller），不编排 create/update/finalize 时序**——时序由 C5 消费 AI 流式事件时决定（FR-4.3/AC-17）。

### 3.5 ChannelPlugin<T> — 渠道插件合约（C6 拥有的核心合约，对外提供）

```ts
// domain/plugin/channel-plugin.ts
import type { InboundMessage, OutboundMessage, SendResult } from '../message/channel-message';

export interface ChannelPlugin<T = unknown> {
  readonly meta: ChannelMeta;

  loadConfig(): T | null;                                   // 加载并校验配置
  getCapabilities(): ChannelCapabilities;                   // 当前有效能力（可依赖配置，FR-2.1）
  validateConfig(): string | null;                          // 校验完整性，null=有效否则错误文案 key

  start(): Promise<void>;                                    // 启动（连 WS / 起轮询）
  stop(): Promise<void>;                                     // 优雅停止
  isRunning(): boolean;

  consumeOne(): Promise<InboundMessage | null>;             // 消费下一条入站（供 C5 运行时循环）
  send(message: OutboundMessage): Promise<SendResult>;      // 出站发送
  isAuthorized(userId: string, chatId: string): boolean;    // 渠道自身入站准入（FR-1.4，非 C5 权限经纪）

  getCardStreamController?(): CardStreamController | null;  // 可选：流式卡片
  probe?(): Promise<ProbeResult>;                            // 可选：连通性探测
  onMessageStart?(chatId: string): void;                     // 可选：如飞书加 Typing 反应
  onMessageEnd?(chatId: string): void;                       // 可选：去反应
}
```

> 逐方法对齐现有 `channels/types.ts` 的 `ChannelPlugin<T>`。**`consumeOne`/`send` 是 C6 提供给 C5 的运行时接口**——C5 在其运行循环（承接现有 `runAdapterLoop`）里调用它们做路由投递；C6 只提供这两个方法的合约与渠道实现，**不拥有循环/路由/投递编排本身**（那在 C5）。`isAuthorized` 是渠道配置层面的准入（承接 `feishu/policy.ts`），跨渠道权限经纪归 C5。

### 3.6 渲染领域：MarkdownIR — 渠道无关中间表示

```ts
// domain/rendering/markdown-ir.ts
export type MarkdownStyle = 'bold' | 'italic' | 'strikethrough' | 'code' | 'code_block' | 'blockquote';

export interface MarkdownStyleSpan { readonly start: number; readonly end: number; readonly style: MarkdownStyle; }
export interface MarkdownLinkSpan  { readonly start: number; readonly end: number; readonly href: string; }

export interface MarkdownIR {
  readonly text: string;                        // 纯文本（去 markdown 标记）
  readonly styles: ReadonlyArray<MarkdownStyleSpan>; // 样式区间（相对 text 偏移）
  readonly links: ReadonlyArray<MarkdownLinkSpan>;   // 链接区间
}

export interface MarkdownParseOptions {
  readonly linkify?: boolean;
  readonly headingStyle?: 'none' | 'bold';
  readonly blockquotePrefix?: string;
  readonly autolink?: boolean;
  readonly enableTables?: boolean;
}
```

> 承接现有 `bridge/markdown/ir.ts` 的 `MarkdownIR`/`MarkdownStyleSpan`/`MarkdownLinkSpan`/`MarkdownParseOptions`。IR 是**渠道无关**的：一次解析，多渠道渲染。渠道差异只体现在 `MarkdownParseOptions`（Telegram heading 走 bold、enableTables=true）与渲染器 options，不在 IR 结构。

### 3.7 结构化错误

```ts
// domain/error/channel-error.ts
export type ChannelErrorCode =
  | 'unknown_channel'        // ChannelPluginPort 解析未知 channelType
  | 'invalid_config'         // validateConfig 失败
  | 'not_connected'          // 未 start 就 send/getCardStreamController
  | 'probe_failed'           // 探测失败
  | 'capability_violation';  // capabilitiesInvariant 违规（streaming 无 controller）
export class ChannelError extends Error {
  constructor(
    public readonly code: ChannelErrorCode,
    public readonly messageKey: string,        // c6.* i18n 键，经 SK.TranslationPort 渲染
    public readonly meta?: Readonly<Record<string, unknown>>, // 绝不含凭据值
  );
}
```

> 错误只带 `code` + `messageKey`（`c6.*`），不硬编码文案（NFR-5/6）；`meta` 绝不含 appSecret/token。

## 4. 驱动端口 (Driving Ports)

### 4.1 ProbeChannelUseCase（契约对外提供）

```ts
// ports/driving/probe-channel-usecase.ts
export interface ProbeChannelResult {
  readonly probe: ProbeResult;                  // 连通性实测（FR-2.2）
  readonly capabilities: ChannelCapabilities;   // 该渠道当前能力（FR-2.4 一次性拿两者）
}

export interface ProbeChannelUseCase {
  /**
   * 给定渠道类型 + 配置，探测连通性并返回能力清单。
   * 失败 → probe.ok=false + 脱敏 error（不抛，FR-2.3）；未知类型 → ChannelError('unknown_channel')。
   */
  probe<T>(channelType: ChannelType, config: T): Promise<ProbeChannelResult>;

  /** 列出当前支持的渠道类型（供设置页 / C5 枚举，FR-5.3）。 */
  listSupportedChannels(): ReadonlyArray<ChannelMeta>;
}
```

### 4.2 RenderMessageUseCase（渲染，供 C5 取渲染结果 / 设置页预览）

```ts
// ports/driving/render-message-usecase.ts
export interface RenderedMessage {
  readonly channelType: ChannelType;
  /** 渲染后可直接投递的格式：Telegram=HTML 串；飞书=卡片/ post JSON 串。 */
  readonly payloads: ReadonlyArray<string>;      // 已按渠道长度上限做渲染期分片（FR-3.4）
  readonly renderKind: 'telegram_html' | 'feishu_card' | 'feishu_post' | 'discord';
}

export interface RenderMessageUseCase {
  /**
   * 把 Markdown 渲染为指定渠道的原生格式 + 渲染期分片。纯渲染，无投递。
   * C5 拿 payloads 后自己决定投递顺序/时机/重试（编排归 C5，AC-17）。
   */
  render(channelType: ChannelType, markdown: string): RenderedMessage;
}
```

> `RenderMessageUseCase` 是 C6 对渲染的驱动端口——既供渠道设置页"预览渲染效果"，也供 C5 在投递前取"渲染后 + 切好块"的 payloads。**它只产 payloads，不投递**。

## 5. 出站端口 (Driven Ports)

### 5.1 ChannelPluginPort<T>（契约对外提供；供 C5 消费）

```ts
// ports/driven/channel-plugin-port.ts
export interface ChannelPluginPort {
  /**
   * 按 channelType 解析出对应渠道插件实例（工厂/注册表）。
   * 未知类型 → ChannelError('unknown_channel')。承接现有 registerAdapterFactory + channel-plugin-adapter。
   */
  resolve<T>(channelType: ChannelType, config: T): ChannelPlugin<T>;

  /** 列出已注册的渠道类型（供 listSupportedChannels / C5 枚举，FR-5.3）。 */
  listRegistered(): ReadonlyArray<ChannelMeta>;
}
```

- **实现位置**：适配器 `ChannelPluginRegistry`（`apps/api`），承接现有 `channels/channel-plugin-adapter.ts` 的 `ChannelPluginAdapter` 桥接与 `registerAdapterFactory` 自注册：
  - `resolve('feishu', cfg)` → `new FeishuChannelPlugin()` + `loadConfig`；`resolve('telegram', cfg)` → Telegram 插件。
  - 各渠道插件（`FeishuChannelPlugin`/`TelegramChannelPlugin`/...）是**被驱动适配器**——它们 import 真实 SDK（`@larksuiteoapi/*`/`ws`/Telegram Bot API），核心包不 import。
- **供 C5 消费**：C5 经 `resolve` 拿插件后，在自己的运行循环（`runAdapterLoop`）里 `consumeOne`/`send`、在权限经纪里用 `isAuthorized`、在流式投递里用 `getCardStreamController`。C6 只交付插件，不接线、不循环、不投递。

## 6. 用例编排要点

```ts
// usecases/probe-channel.ts
export class ProbeChannelService implements ProbeChannelUseCase {
  constructor(
    private readonly plugins: ChannelPluginPort,   // 出站
    private readonly errors: ErrorClassifier,       // SK 横切
    private readonly redactor: Redactor,            // SK 横切
    private readonly log: RuntimeLog,               // SK 横切
  ) {}
  // probe: plugins.resolve(type,cfg) → plugin.probe?.() ?? { ok:false }
  //   成功 → { probe, capabilities: plugin.getCapabilities() }
  //   失败 → errors.classify → probe.ok=false，error 经 redactor 脱敏后 log.append({source:'c6.channel'})，不抛
  //   校验 capabilitiesInvariant（streaming vs controller），违规记 warn（暴露谎报）
}

// usecases/render-message.ts
export class RenderMessageService implements RenderMessageUseCase {
  // render: switch(channelType)
  //   telegram → markdownToTelegramChunks(markdown, TG_LIMIT) → payloads=chunks.map(c=>c.html)
  //   feishu   → hasComplexMarkdown(md) ? buildCardContent(md*) : buildPostContent(markdownToIR→post)
  //   均为纯函数调用，无 I/O
}
```

- **`ProbeChannelService.probe`**：`plugins.resolve` → `plugin.probe?.()`（可选，缺失时构造 `{ok:false}` 或按"未支持探测"降级）→ 组 `{ probe, capabilities }`；失败 `errors.classify` 归 NETWORK/AUTH/TIMEOUT → `probe.ok=false`，error 经 `redactor` 脱敏后 `log.append`，不抛。校验 `capabilitiesInvariant` 暴露 `streaming` 谎报。
- **`RenderMessageService.render`**：按 `channelType` 选渠道渲染器，全走纯函数（`markdownToIR` → 渠道渲染器 → 分片），产 `payloads`。**不投递、不决定顺序/时机**（AC-17）。
- **凭据路径**：探测时 config 含 appSecret/token 只传给适配器插件的 `loadConfig`/`probe`；`ProbeResult` 只回 botName/botId，日志经 `redactor` 脱敏（NFR-2）。

## 7. 归属决策：领域纯函数 vs 适配器 I/O（关键设计决策）

C6 既涉及**纯字符串/结构处理**（Markdown → IR → 渠道格式、分片、能力不变量、准入判定），又涉及**真实 I/O**（渠道 WS 连接、长轮询、HTTP 发送、getBotInfo 探测）。为守住"核心零 SDK/ws/fs 依赖"（NFR-1）：

- **渲染/判定逻辑（纯函数）留核心**：`markdownToIR` / `renderMarkdownWithMarkers` / `chunkMarkdownIR` / `sliceStyleSpans` / 各渠道渲染器（`markdownToTelegramHtml`/`wrapFileReferencesInHtml`/`hasComplexMarkdown`/`buildCardContent`/`buildPostContent`）/ `capabilitiesInvariant` / `isKnownChannelType`。它们只吃字符串/结构，不碰 SDK/网络/fs，可表驱动单测。飞书 `isUserAuthorized`（`feishu/policy.ts`）是纯判定，随飞书插件的领域判定放插件模块（吃 config + userId + chatId 吐 boolean）。
- **I/O 进适配器**：`FeishuChannelPlugin`（`@larksuiteoapi` WS gateway + REST：gateway/inbound/outbound/identity/card-controller 子模块）、`TelegramChannelPlugin`（长轮询 + Bot API）、`DiscordChannelPlugin` 等。适配器持有 SDK/连接，实现 `ChannelPlugin<T>` 合约。
- **渲染器为何在核心而非适配器**：现有 `bridge/markdown/*` 是纯字符串变换（Markdown → 渠道格式），零 I/O——它是**渠道渲染合约**的核心资产，放核心可被 `RenderMessageUseCase` 与 C5 共用、可表驱动测（AC-6~11）。真正的"把渲染结果发出去"是适配器 `plugin.send` 的事。
- **探测 ≠ 消费/路由**：`plugin.probe` 在适配器里连接 + getBotInfo，但**没有** `consumeOne` 循环/路由/投递——消息消费循环与路由是 C5 的事（承接 `runAdapterLoop`/`channel-router`/`delivery-layer`）。C6 提供 `consumeOne`/`send` 合约方法，但不拥有调用它们的循环（AC-17 的边界断言）。

## 8. 依赖注入接线 (NestJS 侧)

```
ChannelModule (apps/api)
  imports: [SharedKernelModule]      // 注入 Redactor / ErrorClassifier / RuntimeLog / TranslationPort
  provides:
    ProbeChannelUseCase   → ProbeChannelService(ChannelPluginPort, ErrorClassifier, Redactor, RuntimeLog)
    RenderMessageUseCase  → RenderMessageService()                    // 纯渲染，无出站依赖
    ChannelPluginPort     → ChannelPluginRegistry(...channel plugin factories)  // 承接 registerAdapterFactory
    // 渠道插件工厂（被驱动适配器，注册进 Registry）：
    //   FeishuChannelPlugin  (@larksuiteoapi WS + REST)
    //   TelegramChannelPlugin (长轮询 + Bot API)
    //   DiscordChannelPlugin / QqChannelPlugin / WeixinChannelPlugin
  exports:
    ProbeChannelUseCase        // 契约对外（供 ChannelController / C5 预检）
    RenderMessageUseCase       // 契约对外：供 C5 取渲染结果 + 设置页预览
    ChannelPluginPort          // 契约对外：供 C5 取渠道插件（跨 Module 注入）
  controllers:
    ChannelController
      GET   /api/channels                       → listSupportedChannels（枚举可配渠道 + 能力）
      POST  /api/channels/:type/probe  { config } → probe（测试连接，返回 probe + capabilities）
      POST  /api/channels/:type/render { markdown } → render（渲染预览，可选）
      // 控制器负责：ChannelError.code → HTTP 400/404/502，SK.TranslationPort 渲染 messageKey，
      //            SK.Redactor 脱敏日志；绝不把 appSecret/token 序列化进任何响应。
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。`ChannelPluginPort`/`RenderMessageUseCase`/`ProbeChannelUseCase` **需 export**——C5 跨 Module 注入它们取渠道插件、渲染结果、探测能力（落地引用图 `C6.ChannelPluginPort ← C5`）。

**C5 消费方式（澄清接线，不越界）**：C5 的 `BridgeModule` `imports: [ChannelModule]`，注入 `ChannelPluginPort.resolve`（取插件）/ `RenderMessageUseCase.render`（取渲染 payloads）/ `ProbeChannelUseCase`（启动前预检）。C5 拿到插件后，**自己**在 `runAdapterLoop` 里 `consumeOne`/`send`、路由到 C1 会话、编排 `CardStreamController` 流式时序、做投递重试与权限经纪——这些都在 C5，不回流到 C6。C6↔C5 是单向依赖（C5 依赖 C6），无环，无 forwardRef 需求。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `ChannelPluginPort<T>` | C6 对外提供（出站，供 C5 消费） | context-boundaries.md：C6「对外提供端口：ChannelPluginPort<T>」——由 ChannelPluginRegistry + 各渠道插件实现 |
| `ProbeChannelUseCase` | C6 对外提供（驱动） | C6「对外提供端口：ProbeChannelUseCase」 |
| `RenderMessageUseCase` | C6 对外提供（本上下文补充驱动端口） | 支撑「渠道特定渲染」边界的对外取用，不越 C6「拥有：渠道特定渲染」 |
| `CardStreamController` | C6 对外提供（接口合约，供 C5 编排消费） | C6「拥有：ChannelPlugin 合约」的一部分——C6 定义接口 + 渠道实现，时序编排归 C5 |
| `SK.Redactor/ErrorClassifier/RuntimeLog/TranslationPort` | C6 依赖 SK（横切） | 契约 C6「依赖端口：无核心依赖」——仅横切 SK |

**边界纪律自检**：
- C6 不含"路由/投递编排"：无 `route`/`deliver`/`retry` 方法、无投递顺序保证、无 `bridge-manager` 生命周期编排、无流式卡片 create/update/finalize 的时序编排——那属 C5。C6 `probe` 只做连通性能力探测，`render` 只产渲染 payloads（AC-17）。
- C6 不做跨渠道权限经纪：只保留渠道插件自身的 `isAuthorized`（渠道配置准入，承接 `feishu/policy`）；跨渠道 PermissionBroker + AI canUseTool 放行归 C5/C2。
- C6 不含会话/消息生命周期（C1，`consumeOne` 只产 InboundMessage 形状，接入会话是 C5 的 conversation-engine）、AI 流式（C2）、Provider 配置（C7）、MCP/Skill（C9）。
- **能力与实现同源**：`getCapabilities()` 如实声明，`capabilitiesInvariant` 暴露 `streaming` 谎报（AC-3）；C5 禁止基于名字前缀猜能力。
- C6 不 import `@larksuiteoapi/*`/Telegram/Discord SDK/`ws`/`fs`/`path`/`os`/`better-sqlite3`/`@nestjs/*`：全部 SDK/网络 I/O 锁在渠道插件适配器后（AC-14 静态扫描）。
- **凭据不外泄**：appSecret/token 只在渠道插件适配器内出现，不进 `ProbeResult`/`ChannelCapabilities` 可见字段、不进日志明文（NFR-2/AC-16）。
- **消息形状共享而不重写**：`InboundMessage`/`OutboundMessage`/`SendResult`/`ChannelType` 由 C6 `import type` 引用（或下沉为共享契约），C6 不拥有其路由投递语义（那在 C5）。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，用假 `ChannelPluginPort`/假插件）：
  - 渲染纯函数表驱动：`markdownToIR`（bold/italic/code/code_block/link/表格 span 边界，AC-6）、`markdownToTelegramHtml`（HTML 标记 + 文件引用防误链 `README.md`→`<code>`，AC-7）、`hasComplexMarkdown`/`buildCardContent`/`buildPostContent`（复杂度分流，AC-8）。
  - 分片纯函数：`chunkMarkdownIR` span 相对块归零不越界（AC-9）、Telegram render-first 二次切分 HTML ≤ 上限（AC-10）；相同输入相同输出（AC-11）。
  - 能力与探测：`getCapabilities` 如实（飞书 search=false/reactions=false，AC-3）、`capabilitiesInvariant` 暴露 streaming 谎报、`probe` 连通/失败/脱敏（AC-4）、一次返回 probe + capabilities（AC-5）。
  - 渠道准入：`isUserAuthorized` 群聊/私聊/allowlist/disabled 表驱动（AC-2）。
  - 插件解析：`ChannelPluginPort.resolve` feishu/telegram 解析、未知 → `unknown_channel`（AC-13）。
- 反例 smoke（安全触发路径）：
  - 凭据脱敏：含 appSecret 的飞书配置探测，`SK.RuntimeLog` 脱敏、`ProbeResult` 不带 appSecret（AC-16）。
  - 边界断言：C6 无 route/deliver/retry/permissionBroker/流式时序编排方法（AC-17）——用类型/接口断言证明缺失。
  - 流式卡片降级：假 `CardStreamController.create` 返回空串 → 消费方走降级（AC-12）。
- 适配器可替换（AC-15）：全部用例跑在内存假 `ChannelPluginPort` + 假插件上全绿，证明核心不依赖真实渠道插件。
- 静态检查（AC-14）：对 `channel/` 核心包做禁用 import 扫描（`@larksuiteoapi/*`/Telegram/Discord SDK/`ws`/`fs`/`path`/`os`/`better-sqlite3`/`@nestjs/*`）0 命中。
- 集成 smoke（真实渠道，可选）：真实飞书/Telegram 测试 bot 配置，端到端验证 controller 返回的 `ProbeResult.ok`、botName/botId、能力清单，以及渲染 payloads 被渠道 API 接收。
