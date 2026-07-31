---
title: 产品简报 — C1 Conversation 会话
context: C1 · Conversation
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C1 · Conversation（会话）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 一句话定位

C1 是 CodePilot Web 里**持有"会话（ChatSession）与消息（Message）生命周期"**的限界上下文。它负责会话的创建、列表、改名、归档、删除，以及消息的追加、读取、更新与历史投影——但它**自己从不生成 AI 回复**（那是 C2 的职责），也**不知道标题文本是怎么被 AI 想出来的**（调用 C2 的 `TitleGenerator` 端口拿结果，只负责落库与来源标记）。

## 2. 解决什么问题

现有 Electron 版 CodePilot 的会话/消息逻辑散落在 `db.ts`、chat API 路由、以及若干 runtime 管理器之间，"数据模型"与"AI 编排"耦合在同一批文件里，带来几类反复出问题的耦合痛点：

- **消息 content 语义含糊**：`messages.content` 是一段 JSON 字符串（`MessageContentBlock[]`），"结构化内容块"的解析、校验、往返编解码没有单一归属，parse 失败时静默降级为纯文本，调用方各写各的 fallback。
- **流式状态与持久化混淆**：`stream_status`（streaming/completed/interrupted/error）本是消息行的**持久生命周期**，但常被当成"流式是否在跑"的实时信号读取——真正的流式相位（phase active→settling→terminal）属于 C2 的 StreamSession，两者语义必须分离（对应 CodePilot 高发的 stop/abort 卡死区）。
- **标题来源不可信**：`title` 谁写的、能不能被覆盖（`title_origin` 状态机）分散在 `updateSessionTitle` 与调用点，AI 生成标题、用户手改标题、默认标题三者的优先级容易错乱。
- **会话与 Provider/Runtime 字段纠缠**：`chat_sessions` 表堆了 `sdk_session_id`、`codex_thread_id`、`runtime_status`、`provider_id` 等大量非会话本体字段，"会话是什么"被运行时细节淹没。

C1 把"会话与消息的数据模型 + 生命周期用例"抽成一个零框架的核心上下文，让**消息内容有明确的值对象与编解码契约、标题来源有单一真相源、流式相位归 C2、持久化实现归适配器**，从而让上层（C2 消费历史、C5 桥接注入消息）拿到语义清晰、来源可追的会话数据。

## 3. 目标用户与价值

- **单机开发者用户**：在 SPA 里新建会话、在会话列表里切换/改名/归档/删除会话、逐条查看消息历史——所有操作走 C1 的用例，行为一致、历史完整。
- **接入 C1 的其他上下文**：
  - **C2 AgentRuntime**：AI 一轮结束后通过 `AppendMessageUseCase` 落 assistant 消息、更新 `stream_status`；开新会话时通过 C1 建会话；需要会话历史时通过 `GetSessionHistoryUseCase` 拿投影喂给模型。
  - **C5 Bridge**：外部 IM 消息落到某个 CodePilot 会话时，经 C1 的会话用例创建/查找会话并追加入站消息。
- **反向**：C1 生成标题时调 **C2 的 `TitleGenerator` 端口**——只拿一个字符串结果，不关心它是哪个 Runtime、哪个模型生成的。

价值主张：**把"会话与消息是什么"从散落的 DB 操作与运行时字段里剥离成一个语义清晰、来源可追、可独立测试的核心上下文。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C1 契约：

- **拥有**：
  - `ChatSession` 实体（会话本体：标题、标题来源、模式、状态、时间戳、归属工作目录等会话级元数据）
  - `Message` 实体（一条消息：角色、内容、时间、token 用量投影、持久生命周期 `stream_status`）
  - `MessageContent` 值对象（结构化内容块 `text/thinking/tool_use/tool_result/code` 的富类型表达与编解码）
  - 会话生命周期用例（创建、列表、改名、归档、删除、touch 更新时间）
  - 消息生命周期用例（追加、按会话读取历史、更新流式检查点、软删除标记等）
- **不包含**：
  - **AI 如何生成回复**、流式相位状态机、多 Runtime 抽象 —— 属 C2。C1 只存 AI 产出的消息文本与 `stream_status` 终态，不驱动生成。
  - **标题如何被 AI 生成** —— 调 C2 的 `TitleGenerator` 端口拿结果，C1 只负责落库 + `title_origin` 来源标记。
  - **持久化实现细节**（SQLite 表结构、JSON 编解码、SQL 语句）—— 归适配器（`SqliteSessionRepository` / `SqliteMessageRepository`）。
  - Provider 配置（C7）、子 agent run（C3）、Task（C10）、MCP/Skill（C9）等。
- **依赖端口（只引用，不重写）**：
  - `SK.Clock` —— 生成 `created_at` / `updated_at` 时间戳（唯一时间源，纯函数可测）。
  - `SK.IdGenerator` —— 生成 `ChatSession` / `Message` 的 id（不在核心里 import uuid）。
  - `C2.TitleGenerator` —— 由 AI 生成标题文本；C1 只消费其返回值。
- **对外提供端口**：
  - `AppendMessageUseCase` / `GetSessionHistoryUseCase` 等消息与会话生命周期用例。
  - 出站 `SessionRepository` / `MessageRepository`（持久化契约，由适配器实现；C2/C5 通过会话用例间接消费，不直接改表）。

## 5. 与 CodePilot 现有实现的对应

| C1 概念 | 现有落点 |
|---|---|
| `ChatSession` 实体 | `chat_sessions` 表、`src/types/index.ts#ChatSession`、`getSessions/getSession/createSession/deleteSession` 等 db.ts 访问器 |
| `Message` 实体 | `messages` 表、`src/types/index.ts#Message`、`getMessages/insertMessage` |
| `MessageContent` 值对象 | `src/types/index.ts#MessageContentBlock` 联合 + `parseMessageContent()`（JSON string ↔ 内容块） |
| 标题来源状态机 | `title_origin` 列 + `src/lib/conversation-title.ts#TitleOrigin` + `updateSessionTitle`（唯一写者） |
| 消息持久生命周期 | `messages.stream_status`（streaming/completed/interrupted/error）——注意与 C2 流式**相位**区分 |
| 会话历史投影 | chat API 的 `GET /messages`、`getMessages()`（含 `_rowid` 边界） |
| 标题 AI 生成 | 现耦合在 runtime 侧；重构后经 `C2.TitleGenerator` 端口，C1 只落库 |

> **语义澄清（防"5 vs 6"式歧义）**：`messages.stream_status` 是**持久的转录行生命周期**（这条 assistant 消息最终是完整/被中断/出错），是 C1 拥有的字段；C2 的 `StreamSession.phase`（active→settling→terminal）是**实时流式相位**，属 C2。二者不可混用——CodePilot 的 stop/abort 卡死高发区正源于把持久 `stream_status` 当实时相位读。此约定在 PRD 与架构文档里明确写出。

## 6. 成功标准（可度量）

- **S1 会话闭环**：用户能在 SPA 里完成会话增删改查、改名、归档，全部经 C1 用例；时间戳与 id 全部来自 `SK.Clock` / `SK.IdGenerator`（纯函数可测，无核心内 `Date.now()` / `uuid` 直调）。
- **S2 消息内容语义清晰**：`MessageContent` 值对象对 5 类内容块（text/thinking/tool_use/tool_result/code）往返编解码不丢字段；非法/legacy 纯文本按明确降级规则包成单个 text 块，降级路径有单测断言。
- **S3 标题来源单一真相**：标题写入统一经会话用例，`title_origin` 状态机决定"AI 生成"能否覆盖"用户手改"；反例断言用户手改标题不被后续 AI 生成覆盖。
- **S4 流式生命周期正确**：`AppendMessageUseCase` 支持 assistant 消息从 `streaming` 检查点推进到 `completed/interrupted/error` 终态；断言持久 `stream_status` 与 C2 相位解耦（C1 不引用 phase 概念）。
- **S5 边界纯净**：C1 核心包不 import Claude SDK / better-sqlite3 / NestJS；不出现流式相位、多 Runtime、Provider 配置、MCP 概念；标题 AI 生成只经 `C2.TitleGenerator` 端口。

## 7. 非目标（明确排除）

- 不做 AI 回复生成、不做流式相位管理、不做 Runtime 切换（C2）。
- 不自己想标题文本（调 `C2.TitleGenerator`）。
- 不做上下文压缩/摘要的 AI 生成本身（摘要文本由 C2 产出；C1 至多持有摘要落库字段，若纳入范围则在 PRD 明确，默认视为 C2 产物的存储投影）。
- 不实现 SQLite schema/迁移/SQL（归适配器）。
- 不做多租户/远程认证（单机 `~/.codepilot/`）。
- 不替 SK 重新实现 Clock / IdGenerator。

## 8. 关键风险与假设

- **假设**：C2 只通过 C1 的会话/消息用例读写会话数据（追加消息、更新 `stream_status`、读历史），不反向绕过 C1 直接改 `messages` / `chat_sessions` 表。
- **假设**：`C2.TitleGenerator` 端口已由 C2 交付并稳定（输入会话上下文 → 输出标题字符串）；C1 生成标题时该端口可用，不可用时按 `title_origin` 规则保留现有标题（降级不报错）。
- **风险**：`chat_sessions` 现表混入大量 runtime/provider/codex 字段。重构时须界定"哪些字段是 C1 会话本体、哪些是别的上下文寄存在同表的投影"——C1 领域模型只建模会话本体，运行时字段（`sdk_session_id` / `codex_thread_id` / `runtime_status` 等）不进 C1 核心领域模型，由对应上下文经端口读写或迁至独立表（此拆分在架构文档"字段归属"一节明确）。
- **风险**：`stream_status` 的"持久生命周期"与 C2"实时相位"语义容易脱节，UI 若读错会重现 stop/abort 卡死。必须在 C1 只暴露持久 `stream_status`，实时相位查询一律回 C2，且为每个用户可见状态字段写 source breadcrumb（见 PRD 反假数据条款）。
</content>
</invoke>
