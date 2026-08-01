---
id: SPEC-epic-c1-3
companions:
  - docs/contexts/c1-conversation/architecture.md
  - docs/contexts/c1-conversation/prd.md
  - docs/contexts/c1-conversation/epics-stories.md
sources:
  - docs/contexts/c1-conversation/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C1-3 · 会话生命周期用例（create/getById/list/archive/unarchive/delete/touch）

## Why

C1-1 摆出了会话/消息的领域类型与端口骨架，C1-2 把消息内容落成了可存可读的富类型。到这里，`ManageSessionUseCase`（`packages/core/src/conversation/ports/driving/manage-session-usecase.ts`）还只是一个空签名接口——没有任何用例逻辑能真正创建、读取、列出、归档、删除会话。本 epic 落地**第一个可运行的会话生命周期用例服务** `ManageSessionService implements ManageSessionUseCase`：它是 C1 迁移链上「会话真正能被创建并被上游读写」的首个可用里程碑，其产物被 C1-4（标题状态机）、C1-5（消息生命周期，追加消息后 `touch` 会话）、C1-6（NestJS 接线）与上游 C2/C5 消费者直接依赖。

它要钉死几条现有代码库反复出问题的编排纪律。

其一是 **时间/id 的来源纪律**：会话的 `id`、`createdAt`、`updatedAt` 必须分别来自注入的 `SK.IdGenerator` 与 `SK.Clock`，核心不直调 `Date.now()`/`crypto.randomUUID()`（architecture §6、PRD FR-1.4/AC-1）。本 epic 用构造函数注入把这条纪律钉死，让用例逻辑可用假替身（`FrozenClock`/`SequentialIdGenerator`）纯逻辑单测。

其二是 **列表的默认过滤语义**：`list` 按 `updatedAt` 倒序，默认只返回 `source='user'` 会话、过滤掉 `task` 会话（对齐现有 ChatListPanel 行为，PRD FR-1.6/AC-2）；显式请求 `task` 源仍可取到（反例可断言）。

其三是 **删除的级联一致性**：删除会话必须级联删除其消息（对齐现有 `ON DELETE CASCADE`，PRD NFR-7/AC-12），删会话后经 `MessageRepository.listBySession` 不可再读到其消息。

本 epic 只落地会话生命周期用例的编排逻辑，持久化交由 `SessionRepository`/`MessageRepository` 出站端口（测试用内存假实现），不接 NestJS/SQLite、不做真实 DB。

## Capabilities

- **CAP-1 · create + getById（id←IdGenerator、时间←Clock、缺省标题走 defaultTitle key）**
  - **intent:** 上游可经 `ManageSessionService.create(input)` 创建一条会话本体并立即经 `getById(id)` 读回；`id` 来自注入的 `IdGenerator.next()`、`createdAt`/`updatedAt` 来自注入的 `Clock.now()`，核心不直调 `Date`/`uuid`。
  - **success:** `create` 用 `id←IdGenerator.next()`、`now←Clock.now()`（`createdAt=updatedAt=now`）构造 `ChatSession`：`title` 缺省时用 `C1_MESSAGE_KEYS.sessionDefaultTitle`（`c1.session.defaultTitle`）+ `titleOrigin=default`，`mode` 缺省 `code`、`source` 缺省 `user`、`status=active`，随后 `SessionRepository.save`（对齐 architecture §6「create」编排规则、§4.1 `CreateSessionInput` 缺省语义）。`getById(id)` 透传 `SessionRepository.getById`，不存在返回 `undefined`（不抛）。语义契约：CRUD 用注入的假 `Clock`/`IdGenerator`，断言核心内无 `Date.now()`/`randomUUID()` 直调（对齐 PRD FR-1.1/1.4、AC-1、epics-stories S3.1）。

- **CAP-2 · list（按 updatedAt 倒序 + source 过滤，默认过滤 task）**
  - **intent:** 上游可经 `list(query?)` 拿到按 `updatedAt` 倒序排列的会话；缺省 `query` 或缺省 `sources` 时默认只返回 `source='user'` 会话（过滤 `task`），显式传 `sources` 含 `task` 时仍可取到 task 会话。
  - **success:** `list` 把 `ListSessionsQuery` 的默认语义落地——`sources` 缺省为 `[user]`（过滤 `task`，FR-1.6），透传 `status`/`limit`，结果按 `updatedAt` 倒序，委托 `SessionRepository.listAll(query)`（对齐 architecture §4.1 `ListSessionsQuery`、§5.1 `SessionRepository.listAll`）。语义契约：`task` 会话默认不出现于列表，显式请求 `task` 源能取到（反例可断言）；归档会话按 `status` 过滤不入默认 active 列表（对齐 PRD FR-1.6、AC-2、epics-stories S3.2）。

- **CAP-3 · archive / unarchive / delete（级联删消息）**
  - **intent:** 上游可经 `archive(id)`/`unarchive(id)` 切换会话 `status ∈ {active, archived}`，经 `delete(id)` 删除会话并级联删除其消息。
  - **success:** `archive` 委托 `SessionRepository.setStatus(id, archived)`、`unarchive` 委托 `setStatus(id, active)`；`delete` 级联删除——先 `MessageRepository.deleteBySession(id)` 再 `SessionRepository.delete(id)`（对齐现有 `ON DELETE CASCADE`，architecture §5.1/§5.2、§6）。语义契约：归档会话不出现在默认 active 列表；删除会话后其消息经 `MessageRepository.listBySession` 不可读（级联一致性，用假 Repository 断言）（对齐 PRD FR-1.2、NFR-7、AC-2/AC-12、epics-stories S3.3）。

- **CAP-4 · touch（仅更新 updatedAt）**
  - **intent:** 上游（如 C1-5 追加消息后）可经 `touch(id)` 只更新会话的 `updatedAt` 把会话顶到列表前列，不改动会话其它字段。
  - **success:** `touch` 用 `now←Clock.now()` 委托 `SessionRepository.touch(id, now)`，仅更新 `updatedAt`（对齐 architecture §4.1「touch」、§6）。语义契约：`touch` 用与注入 `Clock` 一致的值更新 `updatedAt`，不改 `title`/`status`/`source` 等其它字段（对齐 PRD FR-1.3、AC-7、epics-stories S3.4）。

## Constraints

- **核心包铁律（零框架 import）**：`packages/core/.../conversation/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`，禁止直调 `Date.now()`/`new Date()`/`crypto.randomUUID()`；时间/id 一律经注入的 `SK.Clock`/`SK.IdGenerator`。本 epic 产物是纯逻辑用例服务，持久化交出站端口，无任何框架/DB/SDK 绑定；c1-1-7 已建的禁用 import 静态守卫应保持 0 命中。
- **`verbatimModuleSyntax` 已启用**（见 CLAUDE.md）：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。`ManageSessionService` 引用 `ManageSessionUseCase`/`ChatSession`/`SessionSource` 等领域与端口类型、引用 SK 的 `Clock`/`IdGenerator` 端口类型时均须遵守。
- **依赖倒置 + 构造注入**：`ManageSessionService` 经构造函数注入 `SessionRepository`、`MessageRepository`（供 `delete` 级联）、`SK.Clock`、`SK.IdGenerator`（对齐 architecture §7 接线：`ManageSessionService(SessionRepository, MessageRepository, Clock, IdGenerator, RuntimeLog)`）；核心不 `new` 具体实现、不直调 `Date.now()`/`randomUUID()`，持久化细节交端口。
- **缺省语义落用例**：`title` 缺省走 `C1_MESSAGE_KEYS.sessionDefaultTitle`（`c1.session.defaultTitle`）key + `titleOrigin=default`（不硬编码文案，NFR-5）；`list` 的 `sources` 缺省为 `[user]`（过滤 `task`，FR-1.6）；`CreateSessionInput` 可选字段无值时由用例落默认，不预填假空串。
- **禁 phase**：`ManageSession` 只做会话本体生命周期，不引用、不建模流式相位（`phase`/`active`/`settling`/`terminal`/`StreamSession`）；这些一律属 C2（NFR-2）。
- **本 epic 只落地会话生命周期用例**：`rename` 的标题状态机语义（走 `SetSessionTitleUseCase(user)`）属 c1-4，本 epic 若需在 `ManageSessionService` 暴露 `rename` 仅做最小委托占位或留待 c1-4；不实现标题 AI 生成、不实现消息追加、不接适配器。新增/变更需求走 correct-course。

## Non-goals

- 不实现标题与来源状态机（`setByUser`/`generateByAi`、`TitleOrigin` 覆盖优先级编排、`C2.TitleGenerator` 调用与降级属 epic-c1-4）；`rename` 的 `titleOrigin='user'` 写入语义留待 c1-4。
- 不实现消息生命周期用例（`append`/`updateStreamStatus`/`getHistory`/`getPromptView` 属 epic-c1-5）；本 epic 只在 `delete` 级联时调用 `MessageRepository.deleteBySession`，不追加/投影消息。
- 不接 NestJS DI / Controller / SQLite 适配器（`ConversationModule` forwardRef 解环、`SessionController`、`SqliteSessionRepository`/`SqliteMessageRepository` 属 epic-c1-6）；本 epic 只给核心用例服务与内存假出站端口测试。
- 不做真实 DB / 持久化接线：测试用内存 `FakeSessionRepository`（`Map<SessionId, ChatSession>`）+ `FakeMessageRepository`（`Map<SessionId, Message[]>`）+ `FrozenClock`/`SequentialIdGenerator` 假替身，无需真实 SQLite。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿：`ManageSessionService implements ManageSessionUseCase` 在 `verbatimModuleSyntax` 下 `tsc --build` 通过；用假出站端口（内存 `FakeSessionRepository`/`FakeMessageRepository`）+ 假 `Clock`（固定时刻）/`IdGenerator`（序列）的用例单测全通过——`create` 用注入的 id/时间构造会话且缺省标题走 `c1.session.defaultTitle` key、`getById` 读回一致（AC-1）；`list` 默认过滤 `task`、显式请求可取、按 `updatedAt` 倒序（AC-2）；`archive`/`unarchive` 切换 status、`delete` 后 `MessageRepository.listBySession` 空（AC-2/AC-12）；`touch` 用同一 `Clock` 值只更新 `updatedAt`（AC-7）。c1-1-7 已建的禁用 import 静态守卫对 conversation 核心包保持 0 命中（本 epic 无新增框架/DB/SDK 依赖，且无 `Date.now`/`randomUUID` 直调）。

## Assumptions

- 假设用例服务目录约定为 architecture §2 给出的 `packages/core/src/conversation/usecases/`（`manage-session.ts` 承载 `ManageSessionService`），与骨架已落地的 `domain/`、`ports/` 平级；若前序冲刺已固化为其它目录名（如 `application/`）以现有落地为准，冲突走 correct-course。
- 假设 SK 已交付并稳定：`Clock.now(): number`（epoch 毫秒）与 `IdGenerator.next(): string` 端口签名为最终版本（现状：`packages/core/src/ports/` 下 SK-2 已 done）；`ManageSessionService` 对 SK 端口的 `import type` 引用以其为准。
- 假设 architecture §4.1（`CreateSessionInput`/`ListSessionsQuery`/`ManageSessionUseCase`）、§5.1（`SessionRepository`）、§5.2（`MessageRepository`）、§6（用例编排要点）的签名与编排规则为最终版本，无待决问题；`ManageSessionUseCase` 端口签名 c1-1-6 已落地（`packages/core/src/conversation/ports/driving/manage-session-usecase.ts`），本 epic 只实现其 service，不改端口签名。
- 假设 `RuntimeLog`（SK-3 已 done）为可选可观测依赖：architecture §7 接线列出 `RuntimeLog`，本 epic 用例若注入用于记会话写路径（source=`c1.session`），可先以最小注入占位；不阻塞纯逻辑单测（假替身可省略/空实现）。
- 假设 `delete` 级联在核心用例内经 `MessageRepository.deleteBySession` + `SessionRepository.delete` 两步表达（对齐 §6），真实适配器可另由 DB FK `ON DELETE CASCADE` 兜底；两条路径语义一致，用假 Repository 断言级联结果。
