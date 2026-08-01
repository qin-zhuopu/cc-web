---
title: 史诗与故事 — C6 Channel 渠道
context: C6 · Channel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C6 · Channel（渠道）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C6 核心包（domain + ports），零框架/零 SDK/ws/fs | FR-1~5 类型基础、NFR-1 |
| E2 ChannelPlugin 合约与能力 | `ChannelPlugin<T>` 合约 + 能力诚实声明 + 准入判定 | FR-1、FR-2.1 |
| E3 渠道连通性探测 | `ProbeChannelUseCase`（连通 + 能力，脱敏降级），非消费/路由 | FR-2 |
| E4 渲染核心：Markdown → IR | IR 中间表示 + 通用渲染器 + 分片纯函数 | FR-3.1/3.2/3.4/3.5 |
| E5 各渠道渲染器 | Telegram HTML（防误链）+ 飞书卡片/post + Discord | FR-3.3 |
| E6 流式卡片合约 | `CardStreamController` 接口 + 飞书实现（不编排时序） | FR-4 |
| E7 供给端口与适配器 | `ChannelPluginPort` 注册表 + 各渠道插件适配器 + 可替换验证 | FR-5 |
| E8 NestJS 接线与错误映射 | Module/Controller + 错误码→HTTP + i18n + 脱敏 + 凭据不外泄 | DI、NFR-2/5/6 |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `ChannelType` 枚举 + `isKnownChannelType` 纯函数 + `ChannelMeta`（channelType + displayName）。**AC**：类型对齐现有 `bridge/types` ChannelType。（FR-1.3）
- **S1.2** 定义 `ChannelCapabilities`（5 能力）+ `capabilitiesInvariant` 纯函数（streaming=true 必须有 controller）。**AC-3**：违规可断言暴露。（FR-2.1/§0.1）
- **S1.3** 定义 `ProbeResult`（ok/error/botName/botId），**不含凭据字段**。**AC**：类型层无 appSecret/token 字段。（FR-2.2/NFR-2）
- **S1.4** 定义 `CardStreamController` + `ToolCallInfo` 接口（create/update/finalize + 可选 updateToolCalls/setThinking）。**AC-12**：create 返回空串语义（触发降级）。（FR-4.1/4.2）
- **S1.5** 定义 `ChannelPlugin<T>` 合约接口（全必选 + 可选方法）；`InboundMessage`/`OutboundMessage`/`SendResult` 以 `import type` 引用共享消息形状。**AC-1**：合约全方法可调用。（FR-1.1/1.2）
- **S1.6** 定义结构化错误 `ChannelError`(5 类 code)，带 `messageKey`(`c6.*`)，`meta` 不含凭据。**AC**：错误无硬编码 message。（NFR-5/6）
- **S1.7** 定义驱动端口 `ProbeChannelUseCase` / `RenderMessageUseCase` 与出站端口 `ChannelPluginPort`。**AC**：核心 `index.ts` 只导出端口与领域类型。（FR-1~5）
- **S1.8** 建立禁用 import 静态扫描。**AC-14**：`channel/` 对 `@larksuiteoapi/*`/Telegram/Discord SDK/`ws`/`fs`/`path`/`os`/`better-sqlite3`/`@nestjs/*` 0 命中。（NFR-1）

## E2 · ChannelPlugin 合约与能力

- **S2.1** `ChannelPlugin<T>` 合约的必选方法契约固化（meta/loadConfig/getCapabilities/start/stop/isRunning/consumeOne/send/validateConfig/isAuthorized）。**AC-1**：假插件实现全必选方法。（FR-1.1）
- **S2.2** 可选方法优雅处理：`getCardStreamController`/`probe`/`onMessageStart`/`onMessageEnd` 缺失时消费方按可选处理不崩。**AC-1**：`getCardStreamController` 返回 null 不崩。（FR-1.2）
- **S2.3** 能力诚实声明：`getCapabilities()` 与实现同源（飞书 search=false/reactions=false/streaming=true）。**AC-3**：能力如实、streaming=true 已连接时有 controller。（FR-2.1/§0.1）
- **S2.4** 渠道准入 `isAuthorized`（承接 `feishu/policy` isUserAuthorized）：群聊按 `oc_` 前缀 + groupPolicy、私聊按 dmPolicy。**AC-2**：allowlist/disabled/open 各分支正确。（FR-1.4）

## E3 · 渠道连通性探测

- **S3.1** `ProbeChannelUseCase.probe` 契约：resolve 插件 → `plugin.probe?.()` → `{ probe, capabilities }`。**AC-4/5**：一次返回连通 + 能力。（FR-2.2/2.4）
- **S3.2** 探测失败降级：异常经 `SK.ErrorClassifier` 归类、`probe.ok=false`、error 经 `SK.Redactor` 脱敏记日志，不抛。**AC-4**：连不上→ok=false 脱敏。（FR-2.3）
- **S3.3** `listSupportedChannels`：列当前支持渠道类型 + 元信息。**AC**：枚举可配渠道。（FR-2.4/5.3）
- **S3.4** 探测边界：`probe` 只连通 + getBotInfo，**无 consumeOne 循环/无路由**。**AC-17**：断言探测不触发消息消费/路由（探测≠消费）。（FR-2.5）

## E4 · 渲染核心：Markdown → IR

- **S4.1** 迁入 `markdownToIR` 纯函数（承接 `bridge/markdown/ir.ts`）：Markdown → `MarkdownIR`（text + styleSpans + linkSpans），支持 bold/italic/strikethrough/code/code_block/blockquote/link/表格。**AC-6**：span 边界正确不越界。（FR-3.1）
- **S4.2** 迁入 `renderMarkdownWithMarkers` 通用渲染器（承接 `render.ts`）：styleMarkers + escapeText + buildLink，渠道差异只在 options。**AC-7/8**：渲染标记正确。（FR-3.2）
- **S4.3** 迁入分片纯函数 `chunkMarkdownIR` + `sliceStyleSpans`/`sliceLinkSpans`/`mergeStyleSpans`/`clamp`：切块后 span 相对块归零不越界。**AC-9**：跨块样式各自闭合。（FR-3.4）
- **S4.4** 渲染核心纯函数保证：`markdownToIR`/`renderMarkdownWithMarkers`/分片在无网络无文件环境确定运行。**AC-11**：相同输入相同输出。（FR-3.5/NFR-1）

## E5 · 各渠道渲染器

- **S5.1** Telegram 渲染器（承接 `telegram.ts`）：`markdownToTelegramHtml`（IR → HTML 子集 `<b>/<i>/<s>/<code>/<pre><code>/<blockquote>/<a>`）+ `wrapFileReferencesInHtml`（`README.md` 防误链包 `<code>`）。**AC-7**：文件引用不被 linkify 成 http。（FR-3.3）
- **S5.2** Telegram render-first 分片 `markdownToTelegramChunks`：先按 IR 文本切、渲染后 HTML 超限再二次切。**AC-10**：每块 HTML ≤ 上限。（FR-3.4）
- **S5.3** 飞书渲染器（承接 `feishu.ts`）：`hasComplexMarkdown`（代码块/表格判定）→ 复杂走 `buildCardContent`(schema 2.0)、简单走 `buildPostContent`(post)；`htmlToFeishuMarkdown`。**AC-8**：复杂度分流正确。（FR-3.3）
- **S5.4** Discord 等其余渠道渲染器同构承接（styleMarkers + escapeText + buildLink）。**AC**：新渠道渲染只提供 options。（FR-3.3/NFR-8）

## E6 · 流式卡片合约

- **S6.1** `CardStreamController` 接口固化（create/update/finalize + 可选 updateToolCalls/setThinking）。**AC-12**：finalize status 三态可分。（FR-4.1/4.2）
- **S6.2** 飞书 `CardStreamController` 实现（承接 `feishu/card-controller.ts` createCardStreamController）：作为渠道插件适配器一部分，节流内部处理。**AC-12**：create 失败返回空串。（FR-4.3）
- **S6.3** **流式时序不编排边界**：C6 只定义接口 + 渠道实现，何时 create/update/finalize 由 C5 消费决定。**AC-17**：断言 C6 无流式时序编排方法。（FR-4.3）

## E7 · 供给端口与适配器

- **S7.1** `ChannelPluginPort.resolve` 契约：按 channelType 解析插件；未知 → `unknown_channel`。**AC-13**：feishu/telegram 解析、未知报错。（FR-5.1）
- **S7.2** 实现 `ChannelPluginRegistry`（承接 `registerAdapterFactory` + `channel-plugin-adapter`）：channelType → 插件工厂注册表。**AC-13**：`listRegistered` 列已注册。（FR-5.2/5.3）
- **S7.3** 实现 `FeishuChannelPlugin` 适配器（承接 `channels/feishu/` gateway/inbound/outbound/identity/policy/card-controller 模块化拆分）：`@larksuiteoapi` WS + REST。**AC**：合约方法经真实 SDK。（FR-1/2/4）
- **S7.4** 实现 `TelegramChannelPlugin` / `DiscordChannelPlugin` 等适配器：长轮询/Bot API。**AC**：多渠道插件实现同一合约。（FR-1）
- **S7.5** 内存假 `ChannelPluginPort` + 假插件（可编程能力/连接失败/渲染）供单测。**AC-15**：全部用例跑在假端口上绿，证明核心不依赖真实适配器。（NFR-7）

## E8 · NestJS 接线与错误映射

- **S8.1** `ChannelModule`：imports SharedKernelModule，provides `ProbeChannelUseCase`/`RenderMessageUseCase`/`ChannelPluginPort` + 各渠道插件工厂，exports 三者供 C5 跨 Module 注入。**AC**：C5 可注入 `ChannelPluginPort`。（DI 章节）
- **S8.2** `ChannelController`：`GET /api/channels`（枚举 + 能力）、`POST /api/channels/:type/probe`（测试连接）、`POST /api/channels/:type/render`（渲染预览，可选）。（DI 章节）
- **S8.3** 错误码→HTTP：`ChannelError.code` → 400/404/502；`messageKey` 经 `SK.TranslationPort` 渲染。**AC**：各 code 映射正确。（NFR-5/6）
- **S8.4** 凭据不外泄接线：控制器绝不把 appSecret/token 序列化进响应；`ProbeResult` 只回 botName/botId。**AC-16**：响应/日志无凭据明文。（NFR-2）
- **S8.5** 日志脱敏：探测/渲染关键路径经 `SK.Redactor` 脱敏凭据段与绝对路径后写 `SK.RuntimeLog`（source=`c6.channel`）。**AC-16**：日志中 appSecret/用户名段不明文。（NFR-2）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S1.5, S2.1, S2.2 |
| AC-2 | S2.4 |
| AC-3 | S1.2, S2.3 |
| AC-4 | S3.1, S3.2 |
| AC-5 | S3.1 |
| AC-6 | S4.1 |
| AC-7 | S4.2, S5.1 |
| AC-8 | S4.2, S5.3 |
| AC-9 | S4.3 |
| AC-10 | S5.2 |
| AC-11 | S4.4 |
| AC-12 | S1.4, S6.1, S6.2 |
| AC-13 | S7.1, S7.2 |
| AC-14 | S1.8 |
| AC-15 | S7.5 |
| AC-16 | S8.4, S8.5 |
| AC-17 | S3.4, S6.3 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + 合约 + 渲染核心）**：E1 全部、E2 全部、E4 全部。产出零框架 C6 核心 + `ChannelPlugin<T>`/能力/`ProbeResult`/`CardStreamController` 接口 + 静态扫描门禁 + Markdown → IR → 通用渲染 + 分片纯函数（AC-1~3/6/9/11/14）。
- **Sprint 2（探测 + 各渠道渲染器 + 流式卡片合约）**：E3、E5、E6 全部。产出连通性探测（AC-4/5）、Telegram HTML 防误链 + render-first 分片（AC-7/10）、飞书卡片/post 分流（AC-8）、`CardStreamController` 合约与飞书实现（AC-12），流式时序不编排边界（AC-17），全用假端口。
- **Sprint 3（供给端口 + 适配器 + 接线）**：E7、E8 全部。产出 `ChannelPluginPort` 注册表 + Feishu/Telegram/Discord 插件适配器 + 内存假端口可替换验证（AC-15）+ NestJS Module/Controller + 错误映射 + 凭据不外泄 + 脱敏日志（AC-13/16）。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，用内存假端口，无需真实渠道 SDK / 网络）。
- 禁用 import 静态扫描 0 命中（AC-14）。
- **能力诚实断言通过**：`getCapabilities()` 如实（飞书 search=false/reactions=false）、`capabilitiesInvariant` 暴露 streaming 谎报（AC-3）。
- **渲染保真断言通过**：Telegram 文件引用防误链（AC-7）、飞书复杂度分流（AC-8）、分片 span 不越界（AC-9）、render-first HTML ≤ 上限（AC-10）。
- **凭据不外泄断言通过**：`ProbeResult` 不带 appSecret/token、`SK.RuntimeLog` 脱敏（AC-16）。
- **边界断言通过**：C6 无 route/deliver/retry/permissionBroker/流式时序编排（AC-17）、`probe` 不触发消息消费/路由；核心不 import SDK/ws/fs（AC-14）。
- 适配器可替换验证通过：核心用例跑在内存假 `ChannelPluginPort` + 假插件上全绿（AC-15）。
- 边界纪律：C6 不出现"路由/投递/重试/权限经纪/流式时序编排"/会话/AI 流式/Provider/MCP 概念。
