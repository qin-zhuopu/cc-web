---
id: SPEC-epic-c1-5
companions:
  - docs/contexts/c1-conversation/architecture.md
  - docs/contexts/c1-conversation/prd.md
  - docs/contexts/c1-conversation/epics-stories.md
sources:
  - docs/contexts/c1-conversation/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C1-5 · 消息生命周期用例（append+touch / updateStreamStatus / getHistory / getPromptView / tokenUsage 只存不算）

## Why

C1-1 摆出了 `Message` 实体（`id/sessionId/role/content/createdAt/streamStatus/tokenUsage?/isHeartbeatAck/taskRunId?`）、`StreamStatus`+`canTransition`、`TokenUsage`、`MessageContent`，C1-2 把内容落成可存可读的富类型，C1-3 落地了会话生命周期用例（含 `touch`），C1-4 落地了标题状态机。但 `AppendMessageUseCase`（`packages/core/src/conversation/ports/driving/append-message-usecase.ts`）与 `GetSessionHistoryUseCase`（`packages/core/src/conversation/ports/driving/get-session-history-usecase.ts`）至今仍只是空签名骨架——没有任何用例逻辑能真正把一条消息追加进会话、推进它的持久生命周期、或把历史投影出来喂 UI / 喂模型。

本 epic 落地 C1 领域的**最后一块纯核心**：消息生命周期用例服务 `AppendMessageService implements AppendMessageUseCase` 与 `GetSessionHistoryService implements GetSessionHistoryUseCase`。它是「存消息 + 接着聊」这条产品能力的核心——用户发一句、AI 回一段，都要落成持久转录行并把会话顶到列表前列；UI 要能按时间顺序把历史渲染出来；C2 要能拿到一份剔除了渲染噪音的纯净 prompt 视图去喂模型。C1-3 的 `touch`、C1-4 的 `getPromptView` 消费点都在这里闭合，C1-6 的 NestJS 接线与上游 C2 消费者直接依赖这两个服务。

它要钉死几条现有代码库反复出问题的编排纪律。

其一是 **追加消息与会话 touch 的原子一致**：`append` 用 `id←SK.IdGenerator`、`createdAt←SK.Clock`，并在**同一逻辑操作、同一 now**里 `touch` 所属会话的 `updatedAt`——消息的 `createdAt` 与会话被 touch 的 `updatedAt` 必须是同一个 `Clock.now()` 取值，保证「消息落库」与「会话顶前」不脱节（architecture §6、PRD FR-4.1/NFR-7/AC-7）。

其二是 **streamStatus 推进必经 `canTransition` 守卫**：`updateStreamStatus` 只允许 `streaming → completed/interrupted/error`（及 `streaming→streaming` 幂等），任一终态迁出一律拒绝；C1 只记持久转录行生命周期，绝不引用、不建模 C2 的实时流式相位 `phase`（PRD FR-4.2/4.3/NFR-2/AC-8）。

其三是 **prompt 视图剥离 render-only 标记**：`getPromptView` 必须剔除渲染侧噪音消息（`isHeartbeatAck` 心跳应答、`taskRunId` 关联的 render-only join marker），只保留真正进入模型上下文的消息；`getHistory` 与 `getPromptView` 对含这些标记的消息**返回不同**（PRD FR-4.6/AC-9）。

其四是 **token 用量只存不算、无值不落假 0**：`tokenUsage` 是 C2 落库时提供的投影，C1 只透传存储、绝不自己计算或补 0；无值一律保持 `undefined`（PRD FR-4.5/AC-10，反假数据）。

本 epic 只落地消息生命周期用例的编排逻辑，持久化交由 `MessageRepository`/`SessionRepository` 出站端口（测试用内存假实现），不接 NestJS/SQLite、不做真实 DB、不实现 C2 运行时。

## Capabilities

- **CAP-1 · append + touch（id←IdGenerator、createdAt←Clock，同一 now 原子 touch 会话）**
  - **intent:** 上游可经 `AppendMessageService.append(input)` 追加一条消息（`role ∈ {user, assistant}`、`content` 为 `MessageContent`）并拿回构造好的 `Message`；`id` 来自注入的 `IdGenerator.next()`、`createdAt` 来自注入的 `Clock.now()`，追加的同时把所属会话 `updatedAt` 顶到同一 now，保证消息落库与会话顶前不脱节。
  - **success:** `append` 用 `id←IdGenerator.next()`、`now←Clock.now()`（`createdAt=now`）构造 `Message`：`streamStatus` 缺省对 user 恒 `completed`、assistant 首次流式可传 `streaming`（透传 `input.streamStatus`，缺省落合理默认）；`isHeartbeatAck` 缺省 `false`；`tokenUsage`/`taskRunId` 无值保持 `undefined`（不预填假 0/假空串）→ `MessageRepository.append(message)` → `SessionRepository.touch(sessionId, now)`（**同一 now**，对齐 architecture §6「AppendMessageService.append ... 然后 touch 会话 updatedAt=同一 now」、§4.3 `AppendMessageInput` 缺省语义）。语义契约：追加后所属会话 `updatedAt` 被 touch 更新且等于消息 `createdAt`（同一 `Clock` 值，PRD FR-4.1/NFR-7/AC-7、epics-stories S5.1）。用内存 `FakeMessageRepository` + `FakeSessionRepository` + `FrozenClock`（固定时刻）+ `SequentialIdGenerator`（序列）断言 `message.id`/`message.createdAt` 来自注入端口、`SessionRepository.touch` 被以同一 now 调用。

- **CAP-2 · updateStreamStatus + canTransition 守卫（合法推进通过、非法回退拒绝，tokenUsage 可选透传）**
  - **intent:** 上游可经 `updateStreamStatus(messageId, status, tokenUsage?)` 把 assistant 消息的持久生命周期从 `streaming` 检查点推进到终态（`completed`/`interrupted`/`error`）；非法推进（终态迁出）被拒绝，收尾时可选透传 `tokenUsage` 投影。
  - **success:** `updateStreamStatus` 先读回消息现有 `streamStatus`，用 `domain/message/stream-status.ts` 的 `canTransition(from, to)` 判定——合法（`streaming → 任一终态` 或 `streaming→streaming` 幂等）则委托 `MessageRepository.updateStreamStatus(id, status, tokenUsage)`；非法（任一终态迁出）拒绝（不写库，按用例约定表达拒绝——抛错或 no-op，在实现中固定并单测）。`tokenUsage` 缺省则不更新用量（不落假 0，对齐 architecture §4.3、§5.2 `MessageRepository.updateStreamStatus`）。语义契约：`streaming→completed/interrupted/error` 可推进、终态回退被拒（PRD FR-4.2/4.3/AC-8、epics-stories S5.2）；C1 代码/类型中不含 phase 概念（静态断言 NFR-2）。覆盖判定必须复用 `canTransition`，不得在用例重写迁移规则。用内存 `FakeMessageRepository` 假替身断言合法推进落库、非法推进被拒且不写库。

- **CAP-3 · getHistory（按 createdAt/rowid 升序 + 分页）**
  - **intent:** 上游可经 `GetSessionHistoryService.getHistory(query)` 拿到某会话消息的完整有序投影（按 `createdAt`/rowid 升序），供 UI 渲染与 C2 喂模型的基础；支持 `limit`/`beforeRowId` 分页。
  - **success:** `getHistory` 透传 `HistoryQuery`（`sessionId`/`limit?`/`beforeRowId?`）委托 `MessageRepository.listBySession(query)`，返回按 `createdAt`/rowid 升序的完整 `Message` 投影（对齐 architecture §4.4、§5.2 `listBySession`，分页边界 `beforeRowId` 由适配器以 rowid 提供，用例透传）。语义契约：投影按时间升序（PRD FR-4.4/AC-9、epics-stories S5.3）。用内存 `FakeMessageRepository`（`Map<SessionId, Message[]>`）假替身断言返回顺序升序、`limit`/`beforeRowId` 分页参数被透传。

- **CAP-4 · getPromptView（剥离 render-only 字段，只留真正进入上下文的消息）**
  - **intent:** 上游（C2 喂模型、C1-4 标题投影）可经 `getPromptView(query)` 拿到一份剔除了渲染噪音的纯净 prompt 视图——剥离 `isHeartbeatAck` 心跳应答与 `taskRunId` 关联的 render-only join marker，只保留真正进入模型上下文的消息。
  - **success:** `getPromptView` 取 `MessageRepository.listBySession(query)` 的有序投影后，过滤掉 render-only 标记消息——`isHeartbeatAck === true` 的心跳应答消息、以及 `taskRunId` 关联的 render-only join marker 消息（不入模型上下文），只保留真正进入 prompt 的消息（对齐 architecture §4.4/§6「过滤 isHeartbeatAck 与 taskRunId 关联的 render-only 消息」）。语义契约：`getHistory` 与 `getPromptView` 对含 `taskRunId`/`isHeartbeatAck` 的消息**返回不同**（反例 smoke，PRD FR-4.6/AC-9、epics-stories S5.4）。用内存 `FakeMessageRepository` 假替身注入含 render-only 标记的消息，断言两种投影内容不同、prompt 视图已剥离这些消息。

- **CAP-5 · tokenUsage 只存不算（无值不落假 0）**
  - **intent:** 消息追加/推进时若 C2 提供了 `tokenUsage` 投影，C1 只透传存储；无值时字段一律 `undefined`，绝不自己计算、绝不补假 0。
  - **success:** `append`/`updateStreamStatus` 对 `tokenUsage` 只做透传——有值则原样落 `MessageRepository`，无值则保持 `undefined` 不写、不补 0（C1 只存投影不生成，对齐 architecture §3.3 投影字段纪律、§6「token 用量只存不算」、PRD FR-4.5）。语义契约：无 `tokenUsage` 的消息读回后该字段为空/`undefined`，断言不出现 `0`（反假数据，PRD AC-10、epics-stories S5.5）。用内存 `FakeMessageRepository` 假替身断言：追加不带 `tokenUsage` 的消息、`getHistory` 读回后 `tokenUsage === undefined`（断言不显 0）；带 `tokenUsage` 的消息原样保真。

## Constraints

- **核心包铁律（零框架 import）**：`packages/core/.../conversation/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`，禁止直调 `Date.now()`/`new Date()`/`crypto.randomUUID()`；时间/id 一律经注入的 `SK.Clock`/`SK.IdGenerator`。本 epic 产物是纯逻辑用例服务，持久化交出站端口，无任何框架/DB/SDK 绑定；c1-1-7 已建的禁用 import 静态守卫应保持 0 命中。
- **`verbatimModuleSyntax` 已启用**（见 CLAUDE.md）：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。`AppendMessageService`/`GetSessionHistoryService` 引用 `AppendMessageUseCase`/`AppendMessageInput`、`GetSessionHistoryUseCase`/`HistoryQuery`、`Message`/`MessageId`/`MessageRole`、`MessageContent`、`StreamStatus`、`TokenUsage`、`SessionId`、`MessageRepository`/`SessionRepository`、SK 的 `Clock`/`IdGenerator`/`RuntimeLog` 等类型时均须遵守；`canTransition` 为运行时函数（值 import）。
- **append 用 IdGenerator/Clock 且同一 now 原子 touch 会话**：`append` 的 `message.id←IdGenerator.next()`、`message.createdAt←now=Clock.now()`，随后 `SessionRepository.touch(sessionId, now)` 必须用**同一个** `now` 取值（不得对 touch 再取一次 `Clock.now()`）——保证消息 `createdAt` 与会话 `updatedAt` 一致（AC-7/NFR-7）。无事务的取舍：核心层用「同一 now + 先 append 后 touch 两步」表达一致性语义，真正的事务原子由适配器层（SQLite，c1-6）兜底；用假 Repository 断言两步用同一 now 发生。
- **streamStatus 推进必经 canTransition、非法推进拒绝**：`updateStreamStatus` 不得裸写状态——一律先读现值、用 `domain/message/stream-status.ts` 的 `canTransition(from, to)` 判定，合法才委托 `MessageRepository.updateStreamStatus`，非法（终态迁出）拒绝且不写库（拒绝的表达方式——抛错或 no-op——在实现中固定并单测）；不得在用例重写迁移规则（PRD FR-4.2/AC-8）。
- **getPromptView 必须剥离 render-only 字段**：prompt 视图必须剔除 `isHeartbeatAck === true` 的心跳应答消息与 `taskRunId` 关联的 render-only join marker 消息，只保留真正进入模型上下文的消息；`getHistory` 与 `getPromptView` 对含这些标记的消息返回不同（PRD FR-4.6/AC-9、architecture §4.4/§6）。
- **token 只存不算、无值 undefined 不落假 0**：`tokenUsage` 只透传存储，C1 绝不计算、绝不补 0；无值一律 `undefined`（PRD FR-4.5/AC-10，反假数据）。
- **禁 phase**：消息生命周期只做持久转录行状态（`streamStatus`），不引用、不建模 C2 实时流式相位（`phase`/`active`/`settling`/`terminal`/`StreamSession`）；这些一律属 C2（NFR-2）。
- **依赖倒置 + 构造注入**：`AppendMessageService` 经构造函数注入 `MessageRepository`、`SessionRepository`（供同一 now touch）、`SK.Clock`、`SK.IdGenerator`（可再注 `SK.RuntimeLog` 记写路径 source=`c1.message`，对齐 architecture §7 接线 `AppendMessageService(MessageRepository, SessionRepository, Clock, IdGenerator, RuntimeLog)`）；`GetSessionHistoryService` 经构造函数注入 `MessageRepository`（对齐 §7 `GetSessionHistoryService(MessageRepository)`）。核心不 `new` 具体实现、不直调 `Date.now()`/`randomUUID()`。

## Non-goals

- 不接 NestJS DI / Controller / SQLite 适配器（`ConversationModule` forwardRef 解环、`MessageController` 的 `GET/POST /api/sessions/:id/messages` 与 `PATCH /api/messages/:id`、`SqliteMessageRepository` 的 rowid 分页/编解码属 epic-c1-6）；本 epic 只给核心用例服务与内存/假出站端口测试。
- 不做真实 DB / 持久化接线：测试用内存 `FakeMessageRepository`（`Map<SessionId, Message[]>`，可提供有序/含 render-only 标记的消息）+ `FakeSessionRepository`（`Map<SessionId, ChatSession>`，可断言 `touch`）+ `FrozenClock`（固定时刻）+ `SequentialIdGenerator`（序列）假替身，无需真实 SQLite；`beforeRowId` rowid 游标语义由适配器实现，用例只透传、测试用假实现模拟。
- 不实现 C2 运行时：`tokenUsage` 的产出、实时流式相位（`phase`/`StreamSession`）、模型调用与事件流一律属 C2；C1 只**存** C2 落库时提供的 `tokenUsage` 投影、只记**持久** `streamStatus`，不生成、不追踪实时相位。
- 不实现会话生命周期与标题状态机（`ManageSessionService` 属 c1-3 已 done、`SetSessionTitleService` 属 c1-4 已 done）；本 epic 只**复用** `SessionRepository.touch` 出站端口做同一 now touch，不重写会话用例。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿：`AppendMessageService implements AppendMessageUseCase` 与 `GetSessionHistoryService implements GetSessionHistoryUseCase` 在 `verbatimModuleSyntax` 下 `tsc --build` 通过；用假出站端口（内存 `FakeMessageRepository`/`FakeSessionRepository`）+ 假 `Clock`（固定时刻）/`IdGenerator`（序列）的用例单测全通过——`append` 用注入的 id/时间构造消息且以同一 now touch 会话 `updatedAt`（AC-7）；`updateStreamStatus` 合法推进（`streaming→终态`）落库、非法推进（终态迁出）被拒且不写库（AC-8，经 `canTransition`）；`getHistory` 返回按 `createdAt`/rowid 升序的投影且透传 `limit`/`beforeRowId`（AC-9 基础）；`getPromptView` 剥离 `isHeartbeatAck`/`taskRunId` render-only 消息、与 `getHistory` 对含标记消息返回不同（AC-9 反例 smoke）；无 `tokenUsage` 的消息读回 `tokenUsage===undefined`、断言不显 0（AC-10 反假数据）。c1-1-7 已建的禁用 import 静态守卫对 conversation 核心包保持 0 命中（本 epic 无新增框架/DB/SDK 依赖，无 `Date.now`/`randomUUID` 直调、无 phase 概念）。

## Assumptions

- 假设用例服务落 architecture §2 给出的 `packages/core/src/conversation/usecases/append-message.ts`（承载 `AppendMessageService`）与 `packages/core/src/conversation/usecases/get-session-history.ts`（承载 `GetSessionHistoryService`），与 `manage-session.ts`/`set-session-title.ts` 平级；若前序冲刺固化为其它目录名以现有落地为准，冲突走 correct-course。
- 假设 `AppendMessageUseCase`/`AppendMessageInput`（`ports/driving/append-message-usecase.ts`，c1-1-6 已落地）与 `GetSessionHistoryUseCase`/`HistoryQuery`（`ports/driving/get-session-history-usecase.ts`，c1-1-6 已落地）端口签名为最终版本：`append(input): Promise<Message>`、`updateStreamStatus(messageId, status, tokenUsage?): Promise<void>`、`getHistory(query): Promise<ReadonlyArray<Message>>`、`getPromptView(query): Promise<ReadonlyArray<Message>>`；本 epic 只实现其 service，不改端口签名。
- 假设 `MessageRepository`（`ports/driven/message-repository.ts`，c1-1-6 已落地）签名为最终版本：`listBySession(query): Promise<ReadonlyArray<Message>>`、`append(message): Promise<void>`、`updateStreamStatus(id, status, tokenUsage?): Promise<void>`、`deleteBySession(sessionId): Promise<number>`；`SessionRepository.touch(id, updatedAt): Promise<void>`（c1-1-6 已落地、c1-3 已消费）为最终签名。本 epic 消费其签名。
- 假设 `Message` 实体（`domain/message/message.ts`，c1-1-2 已 done）字段为最终版本：`id/sessionId/role/content/createdAt/streamStatus/tokenUsage?/isHeartbeatAck/taskRunId?`；`MessageRole` 权威定义为 `'user' | 'assistant'`（`append-message-usecase.ts` 注释中提及的 `system` 非权威，以 `message.ts`/architecture §3.3 为准）；本 epic 构造消息以此为准。
- 假设 `StreamStatus`/`canTransition`（`domain/message/stream-status.ts`，c1-1-3 已 done）为最终版本：`'streaming' | 'completed' | 'interrupted' | 'error'`、`streaming` 可迁任一终态（含 `streaming→streaming` 幂等）、终态不可迁出；本 epic 复用 `canTransition` 做推进守卫，不重写、不改签名。
- 假设 `TokenUsage`（`domain/message/token-usage.ts`，c1-1-2 已 done）与 `MessageContent`（c1-2 已 done）为最终版本；`tokenUsage` 由 C2 落库时提供，C1 只存投影不生成（PRD §4 依赖假设）。
- 假设 SK 已交付并稳定：`Clock.now(): number`（epoch 毫秒）、`IdGenerator.next(): string`、`RuntimeLog`（SK-2/SK-3 已 done，`packages/core/src/ports/`）端口签名为最终版本；`AppendMessageService` 对 SK 端口的 `import type` 引用以其为准，`RuntimeLog` 为可选可观测依赖（不阻塞纯逻辑单测）。
