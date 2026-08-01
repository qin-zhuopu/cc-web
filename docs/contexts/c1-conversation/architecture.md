---
title: 架构 — C1 Conversation 会话
context: C1 · Conversation
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C1 · Conversation（会话）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS SessionController / MessageController (HTTP/SSE)
               ↓ 调用驱动端口
        [驱动端口] ManageSessionUseCase / SetSessionTitleUseCase
                   / AppendMessageUseCase / GetSessionHistoryUseCase
               ↓
        [应用核心] Domain Model + Use Cases（纯逻辑，零框架）
               ↓ 依赖倒置，只依赖接口
        [出站端口] SessionRepository / MessageRepository
               +   SK: Clock / IdGenerator / TranslationPort / RuntimeLog
               +   C2: TitleGenerator（跨上下文，只引用）
               ↓ 由适配器实现
        [被驱动适配器] SqliteSessionRepository / SqliteMessageRepository
                       + SK 适配器 + C2 提供的 TitleGenerator 实现
```

依赖方向永远指向核心。C1 核心**只依赖 SK 端口、C2.TitleGenerator 端口接口、以及 C1 自己的出站端口接口**，绝不 import 框架/SDK/DB。C2、C5 是 C1 的**上游消费者**（经会话/消息用例读写），C1 不依赖它们的实现——唯一的跨上下文依赖是 `C2.TitleGenerator` 这个**接口**（对齐边界图 `C2.TitleGenerator ← C1`）。

## 2. 目录结构

```
packages/core/conversation/
├── domain/
│   ├── session/
│   │   ├── chat-session.ts         # ChatSession 实体 + SessionId 值对象
│   │   ├── session-status.ts       # SessionStatus 枚举（active/archived）
│   │   ├── session-mode.ts         # SessionMode 枚举（code/plan/ask）
│   │   ├── session-source.ts       # SessionSource 枚举（user/task）
│   │   └── title-origin.ts         # TitleOrigin 值对象 + 覆盖优先级谓词
│   ├── message/
│   │   ├── message.ts              # Message 实体 + MessageId 值对象
│   │   ├── message-role.ts         # MessageRole 枚举（user/assistant）
│   │   ├── stream-status.ts        # StreamStatus 值对象（持久生命周期，非 phase）
│   │   ├── message-content.ts      # MessageContent 值对象 + encode/decode
│   │   ├── content-block.ts        # ContentBlock 联合（5 类内容块）
│   │   └── token-usage.ts          # TokenUsage 值对象（只存投影，不算）
│   └── message-keys.ts             # C1 自身 i18n 键（c1.*）
├── ports/
│   ├── driving/
│   │   ├── manage-session-usecase.ts     # ManageSessionUseCase 端口
│   │   ├── set-session-title-usecase.ts  # SetSessionTitleUseCase 端口
│   │   ├── append-message-usecase.ts     # AppendMessageUseCase 端口
│   │   └── get-session-history-usecase.ts# GetSessionHistoryUseCase 端口
│   └── driven/
│       ├── session-repository.ts   # SessionRepository 出站端口
│       ├── message-repository.ts   # MessageRepository 出站端口
│       └── title-generator.ts      # TitleGeneratorPort（C2 端口的本地引用别名）
├── usecases/
│   ├── manage-session.ts           # ManageSessionService（实现 driving 端口）
│   ├── set-session-title.ts        # SetSessionTitleService（编排 TitleGenerator + origin 状态机）
│   ├── append-message.ts           # AppendMessageService（追加 + touch 会话）
│   └── get-session-history.ts      # GetSessionHistoryService（有序投影 + prompt 视图）
└── index.ts                        # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`SqliteSessionRepository`、`SqliteMessageRepository`）位于 `apps/api` 适配器层，不在核心包内。`TitleGeneratorPort` 只是 C2 端口在 C1 侧的类型引用（`import type`），实现由 C2 Module 提供、经 DI 注入。本文件给签名，不给实现。

## 3. 领域模型 (Domain Model)

### 3.1 ChatSession 实体

```ts
// domain/session/chat-session.ts
export type SessionId = string;

export interface ChatSession {
  readonly id: SessionId;
  readonly title: string;
  readonly titleOrigin: TitleOrigin;      // 见 title-origin.ts
  readonly status: SessionStatus;         // active | archived
  readonly mode: SessionMode;             // code | plan | ask
  readonly source: SessionSource;         // user | task（默认 user）
  readonly workingDirectory: string;      // 会话归属的工作目录
  readonly projectName: string;
  readonly createdAt: number;             // epoch 毫秒，来自 SK.Clock.now()
  readonly updatedAt: number;             // epoch 毫秒，来自 SK.Clock.now()；touch 更新
}
```

> **字段归属（关键边界纪律）**：现有 `chat_sessions` 表混入大量非会话本体字段——`sdk_session_id` / `codex_thread_id` / `codex_thread_provider_id` / `codex_thread_mcp_fingerprint` / `runtime_status` / `runtime_updated_at` / `runtime_error` / `runtime_pin` / `sdk_cwd`（属 **C2 运行时**）、`provider_id` / `provider_name`（属 **C7 消费投影**）、`permission_profile`（属 **C5 权限**）、`context_summary*`（**C2 产出的摘要投影**）。C1 领域模型**只建模会话本体**（上表 10 字段）。这些寄存字段在物理层可暂留同表（迁移期），但读写归各自上下文经其端口；C1 的 `SessionRepository` 只投影会话本体，不为运行时字段负责。

### 3.2 会话枚举与标题来源

```ts
// domain/session/session-status.ts
export enum SessionStatus { ACTIVE = 'active', ARCHIVED = 'archived' }

// domain/session/session-mode.ts
export enum SessionMode { CODE = 'code', PLAN = 'plan', ASK = 'ask' }

// domain/session/session-source.ts
export enum SessionSource { USER = 'user', TASK = 'task' }

// domain/session/title-origin.ts
export enum TitleOrigin {
  DEFAULT = 'default',   // 系统默认（New Chat），可被任何来源覆盖
  AI       = 'ai',       // C2.TitleGenerator 生成，可被 user 覆盖
  USER     = 'user',     // 用户手改，AI 不可覆盖
}

/** 覆盖优先级：请求来源能否覆盖当前来源。default < ai < user。 */
export function canOverrideTitle(current: TitleOrigin, incoming: TitleOrigin): boolean;
```

### 3.3 Message 实体

```ts
// domain/message/message.ts
export type MessageId = string;

export interface Message {
  readonly id: MessageId;
  readonly sessionId: SessionId;
  readonly role: MessageRole;              // user | assistant
  readonly content: MessageContent;        // 富类型值对象（见 3.4）
  readonly createdAt: number;              // epoch 毫秒，来自 SK.Clock.now()
  readonly streamStatus: StreamStatus;     // 持久生命周期（见 3.5）；非 assistant 恒 completed
  readonly tokenUsage?: TokenUsage;        // C2 落库时提供的投影；无值=未记录，不显 0
  readonly isHeartbeatAck: boolean;        // 渲染标记，不入 prompt 投影
  readonly taskRunId?: string;             // 渲染侧 join 标记，不入 prompt 投影
}

// domain/message/message-role.ts
export enum MessageRole { USER = 'user', ASSISTANT = 'assistant' }
```

### 3.4 MessageContent 值对象与内容块

```ts
// domain/message/content-block.ts
export type ContentBlock =
  | { readonly type: 'text';       readonly text: string }
  | { readonly type: 'thinking';   readonly thinking: string }
  | { readonly type: 'tool_use';   readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result';readonly toolUseId: string; readonly content: string;
      readonly isError?: boolean; readonly media?: ReadonlyArray<MediaRef>; readonly sources?: ReadonlyArray<ExternalSourceRef> }
  | { readonly type: 'code';       readonly language: string; readonly code: string };

// domain/message/message-content.ts
export interface MessageContent {
  readonly blocks: ReadonlyArray<ContentBlock>;
  /** 纯文本投影（拼接 text/code 块），供列表预览与标题上下文。 */
  toPlainText(): string;
}

/** JSON string ↔ MessageContent 编解码（对齐现有 messages.content / parseMessageContent）。 */
export function encodeContent(content: MessageContent): string;                 // → 落库 JSON string
export function decodeContent(raw: string): MessageContent;                     // 永不抛；脏输入降级为单 text 块
export function textContent(text: string): MessageContent;                      // 便捷构造
```

> `decodeContent` 语义（FR-3.3 / AC-5）：尝试 `JSON.parse` → 若为数组则逐块归一化（未知块类型丢弃或包 text，需在实现中固定规则并单测）；任何异常/非数组 → `{ blocks: [{type:'text', text: raw}] }`。`encode∘decode` 对合法块幂等（NFR-3）。

### 3.5 StreamStatus（持久生命周期，非流式相位）

```ts
// domain/message/stream-status.ts
export enum StreamStatus {
  STREAMING    = 'streaming',    // 增量检查点：turn 尚未完成，非"成功结束"的证据
  COMPLETED    = 'completed',    // 转录行正常完成
  INTERRUPTED  = 'interrupted',  // 被用户 abort/stop 打断
  ERROR        = 'error',        // turn 出错
}

/** 合法的持久生命周期推进（防非法回退）。 */
export function canTransition(from: StreamStatus, to: StreamStatus): boolean;
```

> **边界纪律（NFR-2 / 对齐 CLAUDE.md stop/abort 高发区）**：`StreamStatus` 是**持久的转录行生命周期**，回答"这条 assistant 消息最终是完整/被中断/出错"。它**不是** C2 的实时流式相位 `StreamSession.phase`（active→settling→terminal）。C1 核心**不 import、不建模** phase；UI 想知道"现在还在生成吗"必须查 C2。把持久 `streamStatus` 当实时相位读，正是现有 stop/abort 卡死的根因，C1 在类型层面切断这条误用。

## 4. 驱动端口 (Driving Ports)

### 4.1 ManageSessionUseCase

```ts
// ports/driving/manage-session-usecase.ts
export interface CreateSessionInput {
  title?: string;                 // 缺省 → 默认标题（key: c1.session.defaultTitle），origin=default
  mode?: SessionMode;             // 缺省 code
  source?: SessionSource;         // 缺省 user
  workingDirectory?: string;
  projectName?: string;
}

export interface ListSessionsQuery {
  sources?: ReadonlyArray<SessionSource>;   // 缺省 [user]（过滤 task）
  status?: SessionStatus;                   // 缺省不限；常用 active
  limit?: number;
}

export interface ManageSessionUseCase {
  create(input: CreateSessionInput): Promise<ChatSession>;
  getById(id: SessionId): Promise<ChatSession | undefined>;
  /** 按 updatedAt 倒序；默认过滤 source='task'（FR-1.6）。 */
  list(query?: ListSessionsQuery): Promise<ReadonlyArray<ChatSession>>;
  rename(id: SessionId, title: string): Promise<ChatSession>;      // 走 SetSessionTitleUseCase(user)
  archive(id: SessionId): Promise<void>;
  unarchive(id: SessionId): Promise<void>;
  /** 仅更新 updatedAt（追加消息后把会话顶前）。 */
  touch(id: SessionId): Promise<void>;
  /** 级联删除其消息（对齐 ON DELETE CASCADE）。 */
  delete(id: SessionId): Promise<void>;
}
```

### 4.2 SetSessionTitleUseCase

```ts
// ports/driving/set-session-title-usecase.ts
export interface SetSessionTitleUseCase {
  /** 用户手改：写入并标 titleOrigin='user'（AI 不可再覆盖）。 */
  setByUser(id: SessionId, title: string): Promise<ChatSession>;
  /**
   * AI 生成：调 C2.TitleGenerator 拿标题，仅当当前 origin ∈ {default, ai} 时写入并标 'ai'。
   * TitleGenerator 失败/不可用 → 保留现有标题，不抛、不写库（FR-2.4）。
   */
  generateByAi(id: SessionId): Promise<ChatSession>;
}
```

### 4.3 AppendMessageUseCase

```ts
// ports/driving/append-message-usecase.ts
export interface AppendMessageInput {
  sessionId: SessionId;
  role: MessageRole;
  content: MessageContent;
  streamStatus?: StreamStatus;          // assistant 首次流式可传 'streaming'；user 恒 completed
  tokenUsage?: TokenUsage;              // C2 提供的投影，可缺省
  isHeartbeatAck?: boolean;             // 缺省 false
  taskRunId?: string;
}

export interface AppendMessageUseCase {
  /** 追加消息（id←IdGenerator, createdAt←Clock）并 touch 会话 updatedAt（同一逻辑操作，FR-4.1/NFR-7）。 */
  append(input: AppendMessageInput): Promise<Message>;
  /** 推进 assistant 消息的持久生命周期：streaming → completed/interrupted/error（FR-4.2）。 */
  updateStreamStatus(messageId: MessageId, status: StreamStatus, tokenUsage?: TokenUsage): Promise<void>;
}
```

### 4.4 GetSessionHistoryUseCase

```ts
// ports/driving/get-session-history-usecase.ts
export interface HistoryQuery { sessionId: SessionId; limit?: number; beforeRowId?: number; }

export interface GetSessionHistoryUseCase {
  /** 完整消息投影（按 createdAt/rowid 升序），供 UI 渲染。 */
  getHistory(query: HistoryQuery): Promise<ReadonlyArray<Message>>;
  /**
   * 喂给模型的 prompt 视图：剔除 render-only 标记（isHeartbeatAck / taskRunId 关联的 marker），
   * 只保留真正进入上下文的消息（FR-4.6 / AC-9）。
   */
  getPromptView(query: HistoryQuery): Promise<ReadonlyArray<Message>>;
}
```

## 5. 出站端口 (Driven Ports)

### 5.1 SessionRepository

```ts
// ports/driven/session-repository.ts
export interface SessionRepository {
  listAll(query?: ListSessionsQuery): Promise<ReadonlyArray<ChatSession>>;
  getById(id: SessionId): Promise<ChatSession | undefined>;
  save(session: ChatSession): Promise<void>;      // upsert 会话本体字段
  touch(id: SessionId, updatedAt: number): Promise<void>;
  setTitle(id: SessionId, title: string, origin: TitleOrigin): Promise<void>;
  setStatus(id: SessionId, status: SessionStatus): Promise<void>;
  delete(id: SessionId): Promise<void>;           // 级联由适配器/DB FK 保证
}
```
- **实现位置**：适配器 `SqliteSessionRepository`（读写 `chat_sessions` 的**会话本体列**；SQLite 行 ↔ 实体编解码，`title_origin` ↔ `TitleOrigin`）。运行时/Provider/Codex 列不由本端口负责。

### 5.2 MessageRepository

```ts
// ports/driven/message-repository.ts
export interface MessageRepository {
  listBySession(query: HistoryQuery): Promise<ReadonlyArray<Message>>;
  append(message: Message): Promise<void>;
  updateStreamStatus(id: MessageId, status: StreamStatus, tokenUsage?: TokenUsage): Promise<void>;
  deleteBySession(sessionId: SessionId): Promise<number>;   // 供级联/清理
}
```
- **实现位置**：适配器 `SqliteMessageRepository`（读写 `messages` 表；`content` ↔ `MessageContent`（`encode/decodeContent`）、`token_usage` JSON ↔ `TokenUsage`、`stream_status` ↔ `StreamStatus`；`SELECT *, rowid as _rowid` 提供 `beforeRowId` 分页边界）。

### 5.3 TitleGeneratorPort（C2 端口的本地引用）

```ts
// ports/driven/title-generator.ts
// C1 仅引用 C2 定义的端口类型；实现由 C2 Module 提供并注入。
export interface TitleGenerationInput {
  sessionId: SessionId;
  recentMessages: ReadonlyArray<{ role: MessageRole; text: string }>;  // 由 C1 从历史投影出纯文本
}
export interface TitleGeneratorPort {
  /** 返回 AI 生成的标题字符串；失败可抛，由 C1 用例降级处理（FR-2.4）。 */
  generateTitle(input: TitleGenerationInput): Promise<string>;
}
```
- **契约来源**：边界契约 `C1 依赖端口：C2.TitleGenerator`，引用图 `C2.TitleGenerator ← C1`。C1 只 `import type` 该接口，绝不 import C2 实现，也绝不自己拼提示词/调模型。

## 6. 用例编排要点

- `ManageSessionService.create` —— `id←IdGenerator.next()`、`now←Clock.now()`、`title` 缺省用 `c1.session.defaultTitle` key + `origin=default` → `SessionRepository.save`。
- `SetSessionTitleService.generateByAi` —— 读会话 → 若 `titleOrigin===USER` 直接返回（不覆盖，AC-3）→ 否则从 `GetSessionHistoryUseCase.getPromptView` 投影 `recentMessages` → `TitleGeneratorPort.generateTitle` → 成功则 `setTitle(title, AI)`；catch 则记 `RuntimeLog.warn` 并返回原会话（降级，AC-4）。
- `SetSessionTitleService.setByUser` —— `canOverrideTitle(current, USER)` 恒 true → `setTitle(title, USER)`。
- `AppendMessageService.append` —— `id←IdGenerator`、`createdAt←Clock` → `MessageRepository.append` → `SessionRepository.touch(sessionId, createdAt)`（同一 `now`，保证一致，AC-7）。
- `GetSessionHistoryService.getPromptView` —— 取 `listBySession` → 过滤 `isHeartbeatAck` 与 `taskRunId` 关联的 render-only 消息（不入模型上下文，AC-9）。
- 所有用户可见文案用 `messageKey`，渲染交 `SK.TranslationPort`；关键写路径经 `SK.RuntimeLog`（source=`c1.session`/`c1.message`）。C1 无异常分类需求（不依赖 SK.ErrorClassifier）；`TitleGenerator` 异常由 C1 用例就地降级，不对外抛结构化错误。

## 7. 依赖注入接线 (NestJS 侧)

```
ConversationModule (apps/api)
  imports: [SharedKernelModule,        // 注入 Clock/IdGenerator/TranslationPort/RuntimeLog
            AgentRuntimeModule]        // 仅为拿 C2 提供的 TitleGeneratorPort（forwardRef 打破 C1↔C2 潜在环）
  provides:
    ManageSessionUseCase     → ManageSessionService(SessionRepository, MessageRepository, Clock, IdGenerator, RuntimeLog)
    SetSessionTitleUseCase   → SetSessionTitleService(SessionRepository, GetSessionHistoryUseCase, TitleGeneratorPort, Clock, RuntimeLog)
    AppendMessageUseCase     → AppendMessageService(MessageRepository, SessionRepository, Clock, IdGenerator, RuntimeLog)
    GetSessionHistoryUseCase → GetSessionHistoryService(MessageRepository)
    SessionRepository        → SqliteSessionRepository(Database)
    MessageRepository        → SqliteMessageRepository(Database)
  exports:
    ManageSessionUseCase, SetSessionTitleUseCase, AppendMessageUseCase, GetSessionHistoryUseCase
    // 供 C2/C5 import 后经用例读写会话/消息；不导出 Repository 写端口给外部直写
  controllers:
    SessionController  (REST: GET/POST /api/sessions, PATCH /api/sessions/:id (rename/archive), DELETE /api/sessions/:id, POST /api/sessions/:id/title:generate)
    MessageController  (REST: GET /api/sessions/:id/messages, POST /api/sessions/:id/messages, PATCH /api/messages/:id (stream-status))
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。**C1↔C2 环处理**：C1 依赖 `C2.TitleGenerator`，C2 消费 C1 会话用例——用 NestJS `forwardRef` 在 Module 层打破循环，核心包之间仍只经接口单向引用（C1 `import type` C2 端口，C2 `import type` C1 用例端口），无实现级环。

## 8. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `SK.Clock` | C1 依赖 SK | context-boundaries.md：C1「依赖端口：SK.Clock」；SK 对外端口清单含 Clock |
| `SK.IdGenerator` | C1 依赖 SK | C1「依赖端口：SK.IdGenerator」；SK 端口清单含 IdGenerator |
| `SK.TranslationPort/RuntimeLog` | C1 依赖 SK（横切） | SK 对外端口清单（横切全上下文） |
| `C2.TitleGenerator` | C1 依赖 C2 | C1「依赖端口：C2.TitleGenerator」；引用图 `C2.TitleGenerator ← C1` |
| `AppendMessageUseCase` / `GetSessionHistoryUseCase` | C1 对外提供 | C1「对外提供端口」 |
| `ManageSessionUseCase` / `SetSessionTitleUseCase` | C1 对外提供 | C1「对外提供端口」（会话生命周期用例） |
| `SessionRepository` / `MessageRepository` | C1 出站 | C1「对外提供端口：出站 SessionRepository、MessageRepository」 |
| C1 会话用例 ← C5 | C5 消费 C1 | 引用图 `C1 会话用例 ← C5` |

**边界纪律自检**：
- C1 未定义/未重写任何 SK 概念（Clock/IdGenerator/Translation 只引用）；未定义 C2 的 TitleGenerator，只 `import type`。
- C1 核心**不含**流式相位（phase/active/settling/terminal/StreamSession）、多 Runtime、Provider 配置、MCP、子 agent 概念；`streamStatus` 仅持久生命周期语义（NFR-2）。
- C1 不 import Claude SDK / better-sqlite3 / NestJS；不自己拼 AI 标题提示词（锁在 `C2.TitleGenerator` 后）。
- 运行时/Provider/Codex 寄存字段不进 C1 领域模型（见 3.1 字段归属），由各自上下文负责，避免"会话是什么"被运行时细节淹没。
- 无实现级循环依赖：C1↔C2 的双向关系经 NestJS `forwardRef` 在接线层解，核心包只单向 `import type` 接口。

## 9. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层）：
  - `MessageContent` 表驱动：5 类块 `encode∘decode` 往返（AC-5/6）；脏输入降级为单 text 块断言不抛（AC-5）；`tool_use.input` 任意 JSON 保真（AC-6）。
  - `TitleOrigin.canOverrideTitle` 全矩阵单测；`generateByAi` 对 `user`/`default`/`ai` 三态断言覆盖行为不同（AC-3，反例 smoke）。
  - `StreamStatus.canTransition` 合法/非法推进单测；静态断言 C1 无 phase 概念（AC-8 / NFR-2）。
  - 用例用假出站端口（`FakeSessionRepository`/`FakeMessageRepository` 内存实现）+ 假 `Clock`（固定时刻）/`IdGenerator`（序列）/`FakeTitleGenerator`。
- 反例 smoke：
  - `TitleGenerator` 抛错 → 标题不变、不写库、不抛（AC-4）。
  - `append` 后会话 `updatedAt` 被 touch（AC-7）；`getHistory` vs `getPromptView` 对含 `taskRunId` 消息返回不同（AC-9）。
  - 无 `tokenUsage` 消息读回字段为空，断言不出现 `0`（AC-10，反假数据）。
  - 删除会话后 `MessageRepository.listBySession` 空（AC-12，级联一致性）。
- 静态检查（AC-11 / NFR-1）：对 `conversation/` 核心包做禁用 import 扫描（`@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`Date.now(`、`randomUUID(`、`crypto`）0 命中。
- 契约层（AC-13 / FR-5.4）：文档与类型断言 C2/C5 侧只能经 C1 用例写会话/消息（Module 不导出 Repository 写端口给外部直写）。
</content>
