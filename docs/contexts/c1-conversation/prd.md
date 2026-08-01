---
title: 需求文档 (PRD) — C1 Conversation 会话
context: C1 · Conversation
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C1 · Conversation（会话）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C1 有若干"用户可见的状态/计数/来源标记"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能：

| 用户可见字段 | 语义（用户会怎么理解） | 真实来源 breadcrumb | 缺失来源时的降级 |
|---|---|---|---|
| 会话标题 | 这个会话讲的是什么 | `ChatSession.title`（写者唯一：会话用例 → Repository） | 无标题时显默认 `New Chat`，不显空白 |
| 标题来源 badge | 这标题是 AI 起的还是我改的 | `ChatSession.titleOrigin`（`TitleOrigin` 状态机） | legacy 行无该字段时视为 `default`，不猜 AI |
| 消息内容块 | 这条消息里有文字/思考/工具调用/代码 | `MessageContent.blocks`（由 `content` JSON 解码） | 解码失败 → 包成单个 `text` 块（明确降级，非静默丢弃） |
| 消息生命周期 badge | 这条回复是完整/被中断/出错了 | `Message.streamStatus`（**持久**生命周期） | legacy 行无该字段时视为 `completed`，**不**当作"正在流式" |
| "是否正在流式" | 现在还在生成吗 | **不属 C1**——查 C2 `StreamSession.phase` | C1 不回答此问题；UI 需实时相位一律问 C2 |
| 会话更新时间 | 最近活跃是什么时候 | `ChatSession.updatedAt`（`SK.Clock` 写入） | 无（永远有值） |
| 历史消息计数 | 这会话有几条消息 | `MessageRepository.listBySession().length` | 无（永远可算） |
| token 用量 | 这条消息花了多少 token | `Message.tokenUsage`（C2 落库时写入的投影） | 无该字段时显"未记录"，**不显假 0** |

**原则**：没有真实来源的字段一律隐藏 / 标 unsupported / 明确写"估算"；禁止假 0、placeholder、把持久 `streamStatus` 伪装成实时流式相位。

## 1. 功能需求 (Functional Requirements)

### FR-1 会话生命周期（`ManageSessionUseCase`）
- FR-1.1 支持会话的创建（`create`）、按 id 读取（`getById`）、列表（`list`，按 `updatedAt` 倒序）、删除（`delete`，级联删除其消息，对齐现有 `ON DELETE CASCADE`）。
- FR-1.2 支持改名（`rename`）、归档/取消归档（`archive`/`unarchive`，对齐 `status ∈ {active, archived}`）。
- FR-1.3 支持 `touch`（仅更新 `updatedAt`），供追加消息等操作把会话顶到列表前列。
- FR-1.4 创建会话时 `id` 来自 `SK.IdGenerator`、`createdAt`/`updatedAt` 来自 `SK.Clock`；核心不直调 `Date`/`uuid`。
- FR-1.5 会话本体字段限定为会话级元数据：`id/title/titleOrigin/status/mode/createdAt/updatedAt/workingDirectory/projectName/source`。运行时/Provider/Codex 字段（`sdkSessionId`、`codexThreadId`、`runtimeStatus`、`providerId` 等）**不进** C1 领域模型（归属见架构文档"字段归属"节）。
- FR-1.6 列表支持按 `source` 过滤（`user`/`task`），默认过滤掉 `task` 会话（对齐现有 ChatListPanel 行为）。

### FR-2 标题与来源状态机（`SetSessionTitleUseCase`，含调用 `C2.TitleGenerator`）
- FR-2.1 标题写入统一经用例，`titleOrigin` 状态机决定覆盖优先级：`default`（系统默认，可被任何来源覆盖）< `ai`（AI 生成，可被用户覆盖）< `user`（用户手改，AI 不可覆盖）。
- FR-2.2 生成 AI 标题时调 `C2.TitleGenerator` 端口拿字符串结果，落库并标 `titleOrigin='ai'`；仅当当前 `titleOrigin ∈ {default, ai}` 时才写入（`user` 手改后不被覆盖）。
- FR-2.3 用户手改标题写入并标 `titleOrigin='user'`。
- FR-2.4 `C2.TitleGenerator` 不可用/失败时保留现有标题，不抛错、不写库（降级）。
- FR-2.5 C1 **不**自己拼 AI 标题文本；提示词/模型/Runtime 全在 C2 端口后。

### FR-3 消息内容值对象（`MessageContent`）
- FR-3.1 `MessageContent` 建模 5 类内容块：`text` / `thinking` / `tool_use` / `tool_result` / `code`，字段对齐现有 `MessageContentBlock` 联合。
- FR-3.2 提供 `encode(): string`（内容块 → JSON string，落库用）与 `decode(raw: string): MessageContent`（JSON string → 内容块，读取用）的往返编解码。
- FR-3.3 `decode` 对非 JSON / 非数组 / 解析异常输入按明确规则降级为单个 `{type:'text', text: raw}`（对齐现有 `parseMessageContent`），降级路径必须可断言，不静默吞异常。
- FR-3.4 `tool_result` 块保留 `isError` / `media` / `sources` 等可选字段的编解码往返；`tool_use` 块的 `input: unknown` 原样保留。

### FR-4 消息生命周期（`AppendMessageUseCase` / `GetSessionHistoryUseCase`）
- FR-4.1 `AppendMessageUseCase.append` 追加一条消息（`role ∈ {user, assistant}`，`content` 为 `MessageContent`），`id` 来自 `SK.IdGenerator`、`createdAt` 来自 `SK.Clock`，并 `touch` 所属会话的 `updatedAt`。
- FR-4.2 assistant 消息支持持久生命周期 `streamStatus ∈ {streaming, completed, interrupted, error}`；支持从 `streaming` 检查点推进到终态（`updateStreamStatus`）。
- FR-4.3 `streamStatus` 是**持久转录行生命周期**，与 C2 的实时流式相位（`StreamSession.phase`）**语义分离**：C1 不引用、不建模 phase；实时"是否在流式"一律由 C2 回答。
- FR-4.4 `GetSessionHistoryUseCase.getHistory(sessionId)` 返回该会话消息的有序投影（按 `createdAt` / rowid 升序），供 C2 喂模型、供 UI 渲染；支持可选分页/上限。
- FR-4.5 追加/更新消息时保存 `tokenUsage` 投影（由调用方 C2 提供），C1 只存不算；无值时字段为空，不写假 0。
- FR-4.6 支持 `is_heartbeat_ack` / `task_run_id` 等渲染侧标记的原样落库与读取（对齐现有字段），但这些标记**不进入** `GetSessionHistoryUseCase` 喂给模型的 prompt 投影（render-only join）。

### FR-5 出站持久化契约（`SessionRepository` / `MessageRepository`）
- FR-5.1 `SessionRepository` 是 C1 会话的出站持久化端口（listAll/getById/save/delete/touch/setTitle 等），由适配器实现。
- FR-5.2 `MessageRepository` 是 C1 消息的出站持久化端口（listBySession/append/updateStreamStatus/deleteBySession 等）。
- FR-5.3 领域模型用富类型（`MessageContent` 对象、枚举），JSON string ↔ 对象、SQLite 行 ↔ 实体的编解码在**适配器边界**完成，核心不碰 SQL / JSON.parse 之外的持久化细节。
- FR-5.4 C2/C5 对会话/消息的读写通过 C1 的用例进行；不得绕过用例直接持有 Repository 做写操作（读投影可经用例暴露）。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/conversation/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`，禁止直接用 `process`/`fs`、`Date.now()`、`crypto.randomUUID()`；时间/id 经 `SK.Clock`/`SK.IdGenerator`，标题 AI 生成经 `C2.TitleGenerator`。
- NFR-2 **无流式相位泄漏**：C1 核心不出现 `phase` / `active` / `settling` / `terminal` / `StreamSession` 概念；对 `streamStatus` 只做持久生命周期语义。
- NFR-3 **编解码健壮**：`MessageContent.decode` 对任意脏输入永不抛出，按 FR-3.3 降级；`encode∘decode` 对合法内容块幂等。
- NFR-4 **可测**：会话/消息用例可用假出站端口（内存 `FakeSessionRepository`/`FakeMessageRepository`）+ 假 `Clock`/`IdGenerator`/`TitleGenerator` 做纯单元测试，无需真实 DB / AI。
- NFR-5 **i18n**：C1 自身产生的用户可见文案（默认标题、来源 badge 文案 key 等）经 `SK.TranslationPort`，C1 只贡献自己的 message keys（`c1.*`）；默认标题 `New Chat` 通过 key 而非硬编码中文/英文。
- NFR-6 **可观测**：会话/消息关键写路径经 `SK.RuntimeLog` 记（脱敏后）source=`c1.session` / `c1.message`。
- NFR-7 **一致性**：删除会话级联删除消息（对齐现有 `ON DELETE CASCADE`）；追加消息与 touch 会话在同一逻辑操作内保持一致（要么都成功要么都不生效）。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.1/1.4）会话 CRUD 全通，`id`/`createdAt`/`updatedAt` 来自注入的假 `IdGenerator`/`Clock`（断言核心内无 `Date.now()`/`uuid` 直调）。
- AC-2（FR-1.2/1.6）归档会话不出现在默认 active 列表；`source='task'` 会话默认被过滤（反例：显式请求 task 会话能取到）。
- AC-3（FR-2.1/2.2）`titleOrigin='user'` 的会话调 AI 生成标题**不被覆盖**；`titleOrigin='default'` 的会话被 AI 标题覆盖并标 `ai`（两条路径断言结果不同——反例 smoke）。
- AC-4（FR-2.4）`C2.TitleGenerator` 抛错时标题保持不变、不写库、用例不抛（降级断言）。
- AC-5（FR-3.2/3.3）`MessageContent`：5 类内容块 `encode∘decode` 往返不丢字段；喂入非 JSON 字符串 → 降级为单个 text 块（断言不抛、内容等于原串）。
- AC-6（FR-3.4）`tool_result` 带 `isError/media/sources` 往返一致；`tool_use.input` 任意 JSON 值原样保留。
- AC-7（FR-4.1）`append` 追加消息后所属会话 `updatedAt` 被 touch 更新（断言 touch 发生，且用同一 `Clock` 值）。
- AC-8（FR-4.2/4.3）assistant 消息从 `streaming` → `completed`/`interrupted`/`error` 可推进；断言 C1 代码/类型中**不含** phase 概念（静态断言 NFR-2）。
- AC-9（FR-4.4）`getHistory` 返回按时间升序的消息投影；带 `task_run_id`/`is_heartbeat_ack` 的渲染标记**不进入**喂模型投影（反例：两种投影内容不同）。
- AC-10（FR-4.5）无 `tokenUsage` 的消息读取后该字段为空/undefined，**不显示 0**（反假数据断言）。
- AC-11（NFR-1）对 `conversation/` 核心包做禁用 import 静态扫描（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`、`Date.now`、`randomUUID`），0 命中。
- AC-12（NFR-7）删除会话后其消息经 `MessageRepository` 亦不可读（级联一致性，用假 Repository 断言）。
- AC-13（FR-5.4）C2/C5 侧对会话/消息的写必须经 C1 用例；文档与类型层面可验证（C2 不持有直写 Repository 的写端口路径）。

## 4. 依赖与假设

- 依赖 SK 已交付：`Clock` / `IdGenerator` / `TranslationPort` / `RuntimeLog` 端口稳定（见 SK architecture 第 4 节）。
- 依赖 C2 交付 `TitleGenerator` 端口：输入会话上下文（近期消息/首条用户消息），输出标题字符串；C1 只消费返回值，不关心其 Runtime/模型/提示词（对齐边界契约图 `C2.TitleGenerator ← C1`）。
- 假设 `chat_sessions` 现表中的运行时/Provider/Codex 字段由对应上下文经各自端口读写，或在迁移中拆到独立表；C1 领域模型只建模会话本体，不为这些字段负责（详见架构文档"字段归属"节）。
- 假设 `tokenUsage` / 上下文摘要文本等由 C2 产出并在落库时提供给 C1；C1 只存投影不生成。
</content>
