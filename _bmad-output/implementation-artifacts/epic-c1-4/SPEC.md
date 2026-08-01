---
id: SPEC-epic-c1-4
companions:
  - docs/contexts/c1-conversation/architecture.md
  - docs/contexts/c1-conversation/prd.md
  - docs/contexts/c1-conversation/epics-stories.md
sources:
  - docs/contexts/c1-conversation/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C1-4 · 标题来源状态机（setByUser + generateByAi + 覆盖规则 + 降级）

## Why

C1-1 落下了 `TitleOrigin`（`'default' | 'ai' | 'user'`）值对象与 `canOverrideTitle(current, incoming)` 覆盖优先级谓词（`packages/core/src/conversation/domain/session/title-origin.ts`：`default < ai < user`，`user` 不被 `ai`/`default` 覆盖），C1-3 落下了会话生命周期用例。但 `SetSessionTitleUseCase`（`packages/core/src/conversation/ports/driving/set-session-title-usecase.ts`）至今仍只是空签名骨架——没有任何用例逻辑能真正写入用户手改的标题、也没有逻辑去调 `C2.TitleGenerator` 自动起名并遵守覆盖规则。

本 epic 落地 C1「自动起标题」能力的核心编排：**标题来源状态机**。这是产品体验的关键——AI 会为会话自动生成一个有意义的标题（不再是永远的「New Chat」），但一旦用户手动改过标题，AI 就绝不能再把它覆盖掉。这条「user 手改后不被 AI 覆盖」的规则是用户对标题的所有权保证，也是现有代码库反复出问题的地方（自动逻辑无脑覆盖用户意图）。本 epic 用 `canOverrideTitle` 谓词把这条规则钉死在用例编排里。

它还要钉死另外两条边界纪律。其一是**降级不崩**：`C2.TitleGenerator` 是跨领域边界的远程能力（背后是 AI 模型调用），会失败/超时/不可用；此时用例必须保留原标题、不写库、不外抛，并经 `SK.RuntimeLog.warn` 记一笔（PRD FR-2.4/AC-4）。其二是**C1 绝不拼提示词**：AI 标题的提示词/模型/Runtime 全锁在 `C2.TitleGenerator` 端口之后，C1 只 `import type` 该端口、只喂纯文本投影 `recentMessages`、只消费返回的标题字符串——绝不 import C2 实现、绝不自己构造 AI 提示词、绝不直接调模型（PRD FR-2.5、architecture §5.3/§8 边界纪律）。

本 epic 只落地标题状态机的编排逻辑，`TitleGenerator` 本身属 C2、持久化交出站端口（测试用假实现），不接 NestJS/SQLite、不做真实 AI 调用。

## Capabilities

- **CAP-1 · setByUser（用户手改标题，标 origin=user）**
  - **intent:** 上游可经 `setByUser(id, title)` 把用户手动输入的标题写入会话并标 `titleOrigin='user'`，此后 AI 生成不可再覆盖它。
  - **success:** `setByUser` 读会话本体（不存在则按接口语义处理），`canOverrideTitle(current, 'user')` 对任意 `current` 恒 `true`（`user` 优先级最高，architecture §6「setByUser」）→ 委托 `SessionRepository.setTitle(id, title, 'user')` 写入，返回更新后的 `ChatSession`。语义契约：用户改名后 `titleOrigin='user'`（PRD FR-2.3/AC-3、epics-stories S4.1）；写路径经 `SK.RuntimeLog`（source=`c1.session`）。用假 `SessionRepository` 断言写入的 `title` 与 `origin='user'`。

- **CAP-2 · generateByAi + 覆盖规则（调 C2.TitleGenerator，origin=ai，受 canOverrideTitle 约束）**
  - **intent:** 上游可经 `generateByAi(id)` 触发 AI 自动起名：从会话历史投影出近期消息文本、调 `C2.TitleGeneratorPort` 拿标题、仅当当前标题来源允许被 `ai` 覆盖（即 `titleOrigin ∈ {default, ai}`）时才写入并标 `titleOrigin='ai'`；`user` 态会话不被覆盖。
  - **success:** `generateByAi` 读会话 → 若 `canOverrideTitle(current, 'ai')` 为 `false`（即 `current==='user'`）直接返回原会话、不调 TitleGenerator、不写库（`user` 态保护，AC-3）→ 否则从 `GetSessionHistoryUseCase.getPromptView` 投影出 `recentMessages`（`{role, text}` 纯文本，见 §5.3 `TitleGenerationInput`）→ 调 `TitleGeneratorPort.generateTitle(input)` → 成功则 `SessionRepository.setTitle(id, title, 'ai')`（对齐 architecture §6「generateByAi」编排）。语义契约：`titleOrigin='default'` 会话被 AI 标题覆盖并标 `ai`，`titleOrigin='user'` 会话调 AI 生成**不被覆盖**——两条路径断言结果不同（反例 smoke，PRD FR-2.1/2.2/AC-3、epics-stories S4.2）。用假 `TitleGeneratorPort`（可注入返回固定标题）+ 假 `SessionRepository` + 假 `Clock` 断言覆盖判定复用 `canOverrideTitle`。

- **CAP-3 · generateByAi 降级（生成失败保持原标题、不崩、记 RuntimeLog）**
  - **intent:** 当 `C2.TitleGenerator` 抛错/超时/不可用时，`generateByAi` 必须保留会话现有标题、不写库、不向上游抛错，并经 `SK.RuntimeLog.warn` 记一笔可观测日志。
  - **success:** `generateByAi` 用 `try/catch` 包裹 `TitleGeneratorPort.generateTitle` 调用；catch 到任何异常 → 不调 `setTitle`、经 `RuntimeLog.warn`（source=`c1.session`，脱敏）记录降级、返回读回的原 `ChatSession`（对齐 architecture §6「generateByAi ... catch 则记 RuntimeLog.warn 并返回原会话」、§331 行「TitleGenerator 异常由 C1 用例就地降级，不对外抛结构化错误」）。语义契约：注入抛错的假 `TitleGeneratorPort`，断言标题保持不变、`SessionRepository.setTitle` 未被调用、用例不抛（PRD FR-2.4/AC-4、epics-stories S4.3）。用可注入成功/抛错/超时的假 `TitleGeneratorPort` 覆盖失败路径。

- **CAP-4 · 确认 C1 不拼 AI 提示词（只调端口）**
  - **intent:** 从代码/类型/测试层面确认 C1 的标题状态机只 `import type` `C2.TitleGeneratorPort` 并调其 `generateTitle`，绝不自己构造 AI 提示词、绝不 import C2 实现、绝不直接调模型/SDK。
  - **success:** `SetSessionTitleService` 对 AI 能力的唯一触点是注入的 `TitleGeneratorPort.generateTitle`；反例断言——测试注入一个「记录入参」的假 `TitleGeneratorPort`，断言 C1 传给它的是投影出的 `recentMessages`（`{role, text}` 纯文本片段）**而非**任何拼好的提示词字符串/模型参数，且用例内无提示词模板/模型调用代码（对齐 architecture §5.3/§8 边界纪律、PRD FR-2.5、epics-stories S4.4）。语义契约：C1 只喂投影文本、只消费标题返回值；禁用 import 静态守卫（c1-1-7 已建）对 `@anthropic-ai/*` 等保持 0 命中。

## Constraints

- **核心包铁律（零框架 import）**：`packages/core/.../conversation/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`，禁止直调 `Date.now()`/`new Date()`/`crypto.randomUUID()`；时间经注入的 `SK.Clock`。本 epic 产物是纯逻辑用例服务，持久化与 AI 生成均交出站端口，无任何框架/DB/SDK 绑定；c1-1-7 已建的禁用 import 静态守卫应保持 0 命中。
- **`verbatimModuleSyntax` 已启用**（见 CLAUDE.md）：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。`SetSessionTitleService` 引用 `SetSessionTitleUseCase`/`ChatSession`/`SessionId`、`TitleOrigin`、`TitleGeneratorPort`/`TitleGenerationInput`、`SessionRepository`、`GetSessionHistoryUseCase`、SK 的 `Clock`/`RuntimeLog` 等类型时均须遵守。
- **覆盖判定复用 canOverrideTitle**：不得在用例里重写覆盖优先级——一律调 `domain/session/title-origin.ts` 的 `canOverrideTitle(current, incoming)`（`default < ai < user`）。`generateByAi` 用 `canOverrideTitle(current, 'ai')` 判定是否写入，`setByUser` 语义上 `canOverrideTitle(current, 'user')` 恒 true。
- **C1 绝不 import C2 实现、绝不自己拼 AI 标题提示词**：AI 标题生成锁在 `C2.TitleGeneratorPort` 之后。C1 只 `import type` 该端口（`ports/driven/title-generator-port.ts`，C1 消费视角的类型契约），只喂 `recentMessages` 纯文本投影、只消费返回的标题字符串；绝不 import C2 运行实现、绝不构造提示词模板、绝不调模型/SDK（architecture §5.3/§8、PRD FR-2.5）。
- **AI 生成失败降级不崩、保持原标题**：`generateByAi` 对 `TitleGeneratorPort.generateTitle` 的调用必须 `try/catch`；失败时保留原标题、不写库、不外抛，经 `SK.RuntimeLog.warn`（source=`c1.session`，脱敏）记录（PRD FR-2.4/AC-4、architecture §6/§331 行）。
- **依赖倒置 + 构造注入**：`SetSessionTitleService` 经构造函数注入 `SessionRepository`、`GetSessionHistoryUseCase`（投影 recentMessages）、`TitleGeneratorPort`、`SK.Clock`、`SK.RuntimeLog`（对齐 architecture §7 接线：`SetSessionTitleService(SessionRepository, GetSessionHistoryUseCase, TitleGeneratorPort, Clock, RuntimeLog)`）；核心不 `new` 具体实现、不直调 `Date.now()`。
- **rename 语义对齐**：若本 epic 触及 `ManageSessionService.rename`（现抛未实现），其语义应走 `SetSessionTitleUseCase.setByUser`（`titleOrigin='user'`）；本 epic 以落地 `SetSessionTitleService` 为主，`rename` 的委托接线不是硬要求，新增/变更需求走 correct-course。
- **禁 phase**：标题状态机只做会话本体标题字段，不引用、不建模流式相位（`phase`/`StreamSession`）；这些一律属 C2（NFR-2）。

## Non-goals

- 不实现 `TitleGenerator` 本身——AI 标题生成能力（提示词/模型/Runtime）的定义与实现属 **C2（c2-7）**；本 epic 只在 C1 侧 `import type` 其端口契约并用假实现测试。
- 不接 NestJS DI / Controller / SQLite 适配器（`ConversationModule` forwardRef 解环、`SessionController` 的 `POST /api/sessions/:id/title:generate`、`SqliteSessionRepository` 属 epic-c1-6）；本 epic 只给核心用例服务与内存/假出站端口测试。
- 不做真实 AI 调用 / 真实 DB：测试用可注入成功/抛错/超时的假 `TitleGeneratorPort` + 内存 `FakeSessionRepository`（`Map<SessionId, ChatSession>`）+ 假 `GetSessionHistoryUseCase`（返回投影消息）+ `FrozenClock` + 假 `RuntimeLog` 替身，无需真实 AI/SQLite。
- 不实现消息生命周期用例（`append`/`getHistory`/`getPromptView` 的完整投影属 epic-c1-5）；本 epic 只**消费** `GetSessionHistoryUseCase.getPromptView` 投影 `recentMessages`（测试可用假实现替身），不落地其内部逻辑。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿：`SetSessionTitleService implements SetSessionTitleUseCase` 在 `verbatimModuleSyntax` 下 `tsc --build` 通过；用假 `TitleGeneratorPort`（可注入返回固定标题 / 抛错 / 超时）+ 内存 `FakeSessionRepository` + 假 `GetSessionHistoryUseCase` + `FrozenClock` + 假 `RuntimeLog` 的用例单测全通过——`setByUser` 写入 `title` 且标 `origin='user'`（AC-3）；`generateByAi` 对 `titleOrigin='default'` 会话调 AI 生成后标题被覆盖并标 `ai`、对 `titleOrigin='user'` 会话不被覆盖（两条路径断言结果不同，AC-3 反例 smoke）；注入抛错的假 `TitleGeneratorPort` 时 `generateByAi` 标题保持不变、`setTitle` 未被调用、用例不抛、`RuntimeLog.warn` 被调用（AC-4 降级）；反例断言 C1 传给 `TitleGeneratorPort` 的是投影 `recentMessages` 纯文本而非拼好的提示词、用例无提示词/模型调用代码（FR-2.5）。c1-1-7 已建的禁用 import 静态守卫对 conversation 核心包保持 0 命中（本 epic 无新增框架/DB/SDK 依赖，无 `Date.now`/`randomUUID` 直调）。

## Assumptions

- 假设 `canOverrideTitle(current, incoming)`（`packages/core/src/conversation/domain/session/title-origin.ts`，c1-1-4 已 done）为最终版本：`default < ai < user`、`user` 不被 `ai`/`default` 覆盖；本 epic 复用它做覆盖判定，不重写、不改签名。
- 假设 `SetSessionTitleUseCase` 端口签名（`ports/driving/set-session-title-usecase.ts`，c1-1-6 已落地）为最终版本：`setByUser(id, title)` 与 `generateByAi(id)` 返回 `Promise<ChatSession>`；本 epic 只实现其 service，不改端口签名。
- 假设 `TitleGeneratorPort`/`TitleGenerationInput`（`ports/driven/title-generator-port.ts`，c1-1 已落地 C1 消费视角契约）为最终版本：`generateTitle(input): Promise<string>`、`input.recentMessages: ReadonlyArray<{role, text}>`；权威定义与实现在 C2，C1 只 `import type`、绝不 import C2 实现。
- 假设 `SessionRepository.setTitle(id, title, origin)`、`getById(id)`（`ports/driven/session-repository.ts`，c1-1 已落地）与 `GetSessionHistoryUseCase.getPromptView`（`ports/driving/get-session-history-usecase.ts`，签名 c1-1 已落地、实现属 c1-5）为最终签名；本 epic 消费其签名，`getPromptView` 测试用假实现替身。
- 假设 SK 已交付并稳定：`Clock.now(): number`、`RuntimeLog`（SK-3 已 done，`packages/core/src/ports/`）端口签名为最终版本；`SetSessionTitleService` 对 SK 端口的 `import type` 引用以其为准。
- 假设用例服务落 architecture §2 给出的 `packages/core/src/conversation/usecases/set-session-title.ts`（承载 `SetSessionTitleService`），与 `manage-session.ts` 平级；若前序冲刺固化为其它目录名以现有落地为准，冲突走 correct-course。
