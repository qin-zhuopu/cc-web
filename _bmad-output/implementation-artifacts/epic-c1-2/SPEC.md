---
id: SPEC-epic-c1-2
companions:
  - docs/contexts/c1-conversation/architecture.md
  - docs/contexts/c1-conversation/prd.md
  - docs/contexts/c1-conversation/epics-stories.md
sources:
  - docs/contexts/c1-conversation/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C1-2 · MessageContent 值对象（5 类内容块 + 编解码往返 + 脏输入降级）

## Why

C1-1 地基故事里，`Message.content` 引用的 `MessageContent` 只是一个 `export type MessageContent = unknown` 的最小占位（见 `packages/core/src/conversation/domain/message/message-content.ts`）——足以让 `Message` 实体定型，但既不能落库、也不能被 UI 渲染。本 epic 把这个占位落成**真正的富类型值对象**：5 类内容块的判别联合、JSON string ↔ 值对象的编解码往返，以及脏输入永不抛的降级路径。它是持久化（`SqliteMessageRepository` 的 `content` ↔ `MessageContent` 编解码，属 c1-6）与 UI/prompt 投影的共同前提。

它要一次性钉死两条现有代码库反复出问题的语义契约。

其一是 **消息内容块的类型完整性**：一条消息里可能有文字、模型思考、工具调用、工具结果、代码块五种成分（architecture §3.4）。现状把 `content` 当裸 JSON 传递，读写两端对「有哪些块、每块有哪些字段」没有类型约束，`tool_use.input`（任意 JSON）与 `tool_result` 的 `isError`/`media`/`sources` 可选字段极易在往返中丢失。本 epic 用判别联合 + `encode∘decode` 幂等把它钉死（PRD FR-3.1/3.2/3.4、AC-5/6）。

其二是 **脏输入的明确降级 vs 静默吞异常**。现有 `parseMessageContent` 面对 legacy 行、非 JSON 串、非数组结构时行为不确定。PRD 的反假数据契约（§0）要求：解码失败必须**明确降级为单个 `text` 块**（`{type:'text', text: raw}`），而非静默丢弃或抛错崩溃。本 epic 让 `decodeContent` **对任意脏输入永不抛**，降级路径可断言（FR-3.3、NFR-3、AC-5）。

本 epic 承 c1-1（领域/端口骨架已 done）、启 c1-3（会话生命周期）之前，是 C1 迁移链上「让消息内容真正可存可读」的必经一站；其产物被 c1-6 的 `MessageRepository` 适配器与 C2 的落库路径直接依赖，必须优先且正确交付。

## Capabilities

- **CAP-1 · ContentBlock 5 类内容块判别联合**
  - **intent:** 上层可用富类型 `ContentBlock` 判别联合表达一条消息里的五种成分（文字/思考/工具调用/工具结果/代码），`type` 字段作判别标签，每类块字段与 architecture §3.4 逐字一致。
  - **success:** `domain/message/content-block.ts` 定义 `ContentBlock` 联合，含 5 个成员：`{type:'text'; text:string}`、`{type:'thinking'; thinking:string}`、`{type:'tool_use'; id:string; name:string; input:unknown}`、`{type:'tool_result'; toolUseId:string; content:string; isError?:boolean; media?:ReadonlyArray<MediaRef>; sources?:ReadonlyArray<ExternalSourceRef>}`、`{type:'code'; language:string; code:string}`，全字段 `readonly`；`MediaRef`/`ExternalSourceRef` 辅助类型一并定义。签名与 architecture §3.4 一致；语义契约说明 5 类块类型完整、`type` 为判别标签（对齐 PRD FR-3.1、AC-5）。

- **CAP-2 · encodeContent/decodeContent 编解码往返**
  - **intent:** 上层（适配器落库/读取）可用 `encodeContent` 把 `MessageContent` 序列化为 JSON string，用 `decodeContent` 反序列化回值对象，合法内容块经 `encode∘decode` 往返不丢字段、且幂等。
  - **success:** `domain/message/message-content.ts` 定义 `MessageContent` 接口（`readonly blocks: ReadonlyArray<ContentBlock>` + `toPlainText(): string`）、`encodeContent(content: MessageContent): string`（→ 落库 JSON string，对齐现有 `messages.content`）、`decodeContent(raw: string): MessageContent`、`textContent(text: string): MessageContent` 便捷构造，签名与 architecture §3.4（第 156-166 行）一致；语义契约说明 5 类块 `encode∘decode` 往返不丢字段、合法块幂等（对齐 PRD FR-3.2、NFR-3、AC-5）。

- **CAP-3 · decodeContent 脏输入永不抛降级为单 text 块**
  - **intent:** `decodeContent` 面对任意脏输入（非 JSON 串 / 非数组结构 / `JSON.parse` 异常）**永不抛**，按固定规则降级为单个 `{type:'text', text: raw}`，降级路径可断言、不静默吞异常。
  - **success:** `decodeContent` 实现遵循 architecture §3.4 语义注释（第 169 行）：尝试 `JSON.parse` → 若为数组则逐块归一化（未知块类型的处理规则在实现中固定并单测）→ 任何异常/非数组 → `{ blocks: [{type:'text', text: raw}] }`；喂入非 JSON 字符串断言不抛、结果内容等于原串（对齐 PRD FR-3.3、NFR-3、AC-5）。

- **CAP-4 · tool_use / tool_result 输入保真**
  - **intent:** `tool_use` 块的 `input:unknown`（任意 JSON 值）与 `tool_result` 块的 `isError`/`media`/`sources` 可选字段在 `encode∘decode` 往返中原样保留、一个字段不丢。
  - **success:** 编解码实现对 `tool_use.input` 任意 JSON（对象/数组/标量/嵌套）原样保留，对 `tool_result` 的 `isError:boolean`、`media:ReadonlyArray<MediaRef>`、`sources:ReadonlyArray<ExternalSourceRef>` 可选字段往返一致；表驱动单测断言带全部可选字段的 `tool_result` 与带任意 JSON input 的 `tool_use` 往返不丢字段（对齐 PRD FR-3.4、AC-6）。

- **CAP-5 · MessageContent.toPlainText 纯文本投影**
  - **intent:** `MessageContent.toPlainText()` 把内容块拼接为纯文本（`text`/`code` 块），供列表预览与标题上下文投影（喂 `C2.TitleGenerator` 的 recentMessages 纯文本、供 UI 列表预览）。
  - **success:** `toPlainText()` 实现按固定规则拼接 `text` 与 `code` 块产出稳定纯文本（拼接顺序、块间分隔、非文本块 thinking/tool_use/tool_result 的处理规则在实现中固定并单测）；混合块输入产出稳定可断言的纯文本（对齐 PRD FR-4.4 支撑、architecture §3.4 第 159 行注释）。

## Constraints

- **核心包铁律（零框架 import）**：`packages/core/.../conversation/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`，禁止直调 `Date.now()`/`new Date()`/`crypto.randomUUID()`。本 epic 产物是纯值对象 + 纯函数编解码，**无任何 I/O**（不读文件、不查库、不发网络）；`encodeContent`/`decodeContent`/`textContent`/`toPlainText` 皆为确定性纯函数。守卫（c1-1-7 已建）应保持 0 命中。
- **`verbatimModuleSyntax` 已启用**（见 CLAUDE.md）：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。`message-content.ts` 引用 `ContentBlock`（及 `MediaRef`/`ExternalSourceRef`）时须遵守；`Message` 实体现有对 `MessageContent` 的引用不改结构、只落地类型。
- **decodeContent 永不抛 + 脏输入降级为单 text 块**：任意非 JSON / 非数组 / 解析异常输入一律降级为 `{ blocks: [{type:'text', text: raw}] }`，降级路径可断言、不静默吞异常（PRD FR-3.3、AC-5、反假数据契约 §0）。
- **encode∘decode 往返保真 + 幂等**：5 类合法内容块经编解码不丢字段，`tool_use.input` 任意 JSON、`tool_result` 的 `isError`/`media`/`sources` 可选字段原样保留（PRD FR-3.4、NFR-3、AC-6）。
- **本 epic 只落地内容值对象与编解码**：不碰会话/消息用例。`ManageSessionService`（c1-3）、`SetSessionTitleService`（c1-4）、`AppendMessageService`/`GetSessionHistoryService`（c1-5）的逻辑均不在范围；不改 `Message` 实体结构（只把 `content` 引用的 `MessageContent` 从占位落成富类型）。新增/变更需求走 correct-course。

## Non-goals

- 不实现会话生命周期用例（create/getById/list/archive/touch/delete 属 epic-c1-3）。
- 不实现标题状态机用例（setByUser/generateByAi 与 TitleGenerator 降级属 epic-c1-4）。
- 不实现消息生命周期用例（append/updateStreamStatus/getHistory/getPromptView 属 epic-c1-5）；本 epic 只为其提供 `content` 内容类型与编解码，不实现追加/投影逻辑。
- 不接 NestJS DI / Controller / SQLite 适配器（`content` ↔ `MessageContent` 的 SQLite 行编解码接线属 epic-c1-6）；本 epic 只给核心纯函数，不给适配器。
- 不改 `Message` 实体结构（c1-1 已定型），只把 `Message.content` 引用的 `MessageContent` 从 `unknown` 占位落成 5 类内容块联合 + 编解码。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿：`ContentBlock` 5 类判别联合与 `MessageContent`/`encodeContent`/`decodeContent`/`textContent`/`toPlainText` 在 `verbatimModuleSyntax` 下 `tsc --build` 通过；表驱动单测覆盖 5 类块 `encode∘decode` 往返不丢字段与幂等（AC-5）、`tool_use.input` 任意 JSON 与 `tool_result` 可选字段保真（AC-6）、`decodeContent` 喂非 JSON/非数组/异常输入断言不抛且降级为单 text 块（AC-5）、`toPlainText` 混合块产出稳定纯文本，全通过。c1-1-7 已建的禁用 import 静态守卫对 conversation 核心包保持 0 命中（本 epic 无新增框架/DB/SDK/I/O 依赖）。

## Assumptions

- 假设 architecture §3.4（第 146-169 行）的 `ContentBlock` 联合、`MessageContent` 接口、`encodeContent`/`decodeContent`/`textContent` 签名与语义注释为最终版本；字段增删或改名走 correct-course 而非本 epic 内擅自扩展。
- 假设 `MediaRef` / `ExternalSourceRef`（`tool_result` 的 `media`/`sources` 元素类型）在 C1 领域内定义——architecture §3.4 引用但未逐字给出字段明细，本 epic 以「够 `tool_result` 往返保真」为准落地最小形状（如 `MediaRef` 含媒体引用标识、`ExternalSourceRef` 含外部来源引用），若与现有 `MessageContentBlock` legacy 形状有出入以现有落库结构对齐，冲突走 correct-course。
- 假设 `decodeContent` 对「数组中的未知块类型」的归一化规则（丢弃 or 包成 text）需在实现中固定并单测——architecture §3.4 第 169 行明确要求「需在实现中固定规则并单测」，本 epic 选定一条规则落地即可，不留待决。
- 假设 `Message.content` 现有对 `MessageContent` 类型的引用（c1-1-2 已建）在本 epic 把占位落成富类型后自动收敛，无需改 `Message` 实体其它字段。
- 假设 `packages/core` 脚手架、`conversation/domain/message/` 目录与 `npm run test` 运行器已由前序冲刺就位（现状：`message-content.ts` 占位、`content-block.ts` 待建于同目录）。
