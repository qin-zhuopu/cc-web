---
id: SPEC-epic-c1-1
companions:
  - docs/contexts/c1-conversation/architecture.md
  - docs/contexts/c1-conversation/prd.md
  - docs/contexts/c1-conversation/epics-stories.md
sources:
  - docs/contexts/c1-conversation/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C1-1 · 会话/消息领域 + 端口骨架（禁 phase + import 守卫）

## Why

这是 C1 Conversation 领域边界的**地基故事**：把「会话是什么、消息是什么」用零框架的富类型钉死，再摆出用例（驱动）与持久化（被驱动）的端口骨架，最后用静态守卫锁住边界纯净。它要一次性解决现有代码库两个反复出问题的痛点。

其一是**领域被运行时细节淹没**：现有 `chat_sessions` 表混入 `sdk_session_id` / 其他运行时句柄字段（历史遗留，已删）/ `runtime_status` / `provider_id` / `context_summary*` 等一大批非会话本体字段（分属 C2 运行时 / C7 消费投影 / C5 权限）。C1 领域模型只建模会话本体 10 字段（architecture §3.1「字段归属」），让「会话是什么」重新清晰。

其二是 **stop/abort 高发区的根因——把持久生命周期误当实时流式相位读**。`Message.streamStatus`（streaming/completed/interrupted/error）回答的是「这条转录行最终完整/被中断/出错」，是**持久**语义；而「现在还在生成吗」属 C2 的 `StreamSession.phase`（active→settling→terminal）。现有 stop/abort 卡死正是这两者被混用。本 epic 在**类型与 lint 层面**切断 phase 概念进入 C1，从源头杜绝误用（PRD NFR-2 / AC-8）。

C1 依赖 SK 已交付的 `Clock`/`IdGenerator`/`TranslationPort`/`RuntimeLog` 端口，并只 `import type` 引用 C2 的 `TitleGeneratorPort` 接口——是 SK 之后、C2 之前的迁移第二站，其领域类型与端口签名被 C1 后续 epic（内容编解码 c1-2、会话生命周期 c1-3、标题状态机 c1-4、消息生命周期 c1-5、接线 c1-6）与上游 C2/C5 消费者直接依赖，必须优先且正确交付。

## Capabilities

- **CAP-1 · ChatSession 会话本体实体 + 会话枚举**
  - **intent:** 上层用例可用富类型 `ChatSession` 表达会话本体，配合 `SessionStatus`/`SessionMode`/`SessionSource` 枚举，运行时/Provider/其他运行时句柄字段一律排除在领域模型之外。
  - **success:** `domain/session/` 下定义 `ChatSession` 实体（`SessionId` 值对象 + `id/title/titleOrigin/status/mode/source/workingDirectory/projectName/createdAt/updatedAt` 10 个会话本体字段，全 `readonly`），及 `SessionStatus`（active/archived）/`SessionMode`（code/plan/ask）/`SessionSource`（user/task）三枚举，签名与 architecture §3.1/§3.2 逐字一致；语义契约说明会话本体字段类型往返编解码不丢字段，运行时字段（`sdkSessionId`/其他运行时句柄字段（历史遗留，已删）/`runtimeStatus`/`providerId` 等）**不在**领域模型内（对齐 PRD FR-1.5、architecture §3.1「字段归属」）。

- **CAP-2 · Message 消息实体 + MessageRole + TokenUsage 投影**
  - **intent:** 上层用例可用富类型 `Message` 表达一条消息，`role` 经 `MessageRole` 枚举约束，`tokenUsage` 为「只存不算」的投影值对象——无值即未记录，绝不落假 0。
  - **success:** `domain/message/` 下定义 `Message` 实体（`MessageId` 值对象 + `id/sessionId/role/content/createdAt/streamStatus/tokenUsage?/isHeartbeatAck/taskRunId?`，全 `readonly`）、`MessageRole` 枚举（user/assistant）、`TokenUsage` 值对象，签名与 architecture §3.3 一致；语义契约说明 `tokenUsage` 为可选投影，无值时字段 `undefined` 不落 0（对齐 PRD FR-4.5、AC-10）。`content` 字段引用 `MessageContent` 类型（其编解码实现属 c1-2，本故事只引用类型占位）。

- **CAP-3 · StreamStatus 持久生命周期 + canTransition，且类型层禁 phase**
  - **intent:** 上层用例可用 `StreamStatus` 表达 assistant 消息的**持久转录行生命周期**并经 `canTransition` 防非法回退；C1 在类型/lint 层面不出现任何流式相位概念。
  - **success:** `domain/message/stream-status.ts` 定义 `StreamStatus` 枚举（streaming/completed/interrupted/error）与 `canTransition(from, to): boolean` 签名，与 architecture §3.5 一致；语义契约说明合法推进（streaming→completed/interrupted/error）通过、非法回退拒绝，且 C1 核心**不 import、不建模、不出现** `phase`/`active`/`settling`/`terminal`/`StreamSession` 概念——「现在还在流式吗」一律由 C2 回答（对齐 PRD FR-4.2/4.3、NFR-2、AC-8 静态断言）。

- **CAP-4 · TitleOrigin 来源值对象 + canOverrideTitle 覆盖优先级谓词**
  - **intent:** 上层标题用例可用 `TitleOrigin` 标记标题来源，并经 `canOverrideTitle` 谓词判定「请求来源能否覆盖当前来源」，实现 default < ai < user 的覆盖优先级。
  - **success:** `domain/session/title-origin.ts` 定义 `TitleOrigin` 枚举（default/ai/user）与 `canOverrideTitle(current, incoming): boolean` 签名，与 architecture §3.2 一致；语义契约说明 `user` 态不被 `ai`/`default` 覆盖、`default` 可被任何来源覆盖，覆盖矩阵可全量单测（对齐 PRD FR-2.1、AC-3）。

- **CAP-5 · C1 i18n 消息键（`c1.*`）**
  - **intent:** C1 自身产生的用户可见文案（默认标题、来源 badge 文案等）经 message key 暴露，交 `SK.TranslationPort` 渲染，C1 只贡献自己的键、不含具体文案，默认标题 `New Chat` 经 key 而非硬编码。
  - **success:** `domain/message-keys.ts` 定义 C1 消息键常量表（`c1.*`，含 `c1.session.defaultTitle`），以 `as const` 给出字面量类型 + 只读，仿 SK `SK_MESSAGE_KEYS` 范式（`packages/core/src/domain/error/message-keys.ts`）；语义契约说明默认标题与来源 badge 文案经 key，核心包内无硬编码中英文案（对齐 PRD NFR-5）。

- **CAP-6 · 驱动与被驱动端口骨架 + C2.TitleGeneratorPort 本地引用**
  - **intent:** 摆出 C1 的四个驱动端口（用例契约）与两个被驱动端口（持久化契约）接口签名，并以 `import type` 引用 C2 的 `TitleGeneratorPort`；`index.ts` 桶文件只导出端口与领域类型。
  - **success:** `ports/driving/` 定义 `ManageSessionUseCase`/`SetSessionTitleUseCase`/`AppendMessageUseCase`/`GetSessionHistoryUseCase`（含 `CreateSessionInput`/`ListSessionsQuery`/`AppendMessageInput`/`HistoryQuery` 等输入类型），`ports/driven/` 定义 `SessionRepository`/`MessageRepository`，`ports/driven/title-generator.ts` 以 `import type` 别名引用 C2 的 `TitleGeneratorPort`（`TitleGenerationInput`/`generateTitle`），签名与 architecture §4/§5 一致；`index.ts` 只导出端口接口与领域类型（无实现）。语义契约说明驱动端口=上游经其读写会话/消息的用例入口，被驱动端口=由适配器实现的出站持久化契约，`TitleGeneratorPort` 只引用不实现（对齐 PRD FR-5.1/5.2/5.4、architecture §8 契约核对）。

- **CAP-7 · 禁用 import 静态守卫（覆盖 conversation/ 核心包）**
  - **intent:** 建立对 `packages/core/.../conversation/` 的禁用 import 静态扫描，把边界纯净违规前移为可断言的 0 命中检查。
  - **success:** 静态守卫覆盖 C1 conversation 目录，对 `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`Date.now(`、`randomUUID(`、`crypto`、以及 phase 相关标识（`StreamSession`/`.phase`）做扫描，0 命中即通过（对齐 PRD NFR-1/NFR-2、AC-11、AC-8 静态断言）。

## Constraints

- **核心包铁律（零框架 import）**：`packages/core/.../conversation/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`，禁止直调 `Date.now()`/`new Date()`/`crypto.randomUUID()`；时间/id 经 `SK.Clock`/`SK.IdGenerator`，标题 AI 生成经 `C2.TitleGenerator`。本 epic 产物是领域类型与端口签名，不含任何框架/DB/SDK 绑定。
- **`verbatimModuleSyntax` 已启用**（见 CLAUDE.md）：类型-only import 必须用 `import type`，且模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。C1 引用 SK 端口（`Clock`/`IdGenerator` 等）、跨文件引用 C1 自身领域类型、以及引用 C2 `TitleGeneratorPort` 时均须遵守。
- **依赖方向单向指向核心**：C1 只 `import type` 依赖 SK 端口与 C2 的 `TitleGeneratorPort` **接口**，**绝不反向依赖 C2 实现**，也不依赖 C5；C2/C5 是 C1 的上游消费者，经 C1 用例读写。C1 不自己拼 AI 标题提示词（锁在 C2 端口后）。
- **禁 phase 进 C1 持久模型**：`streamStatus` 只做持久转录行生命周期语义；C1 核心不 import、不建模、不出现 `phase`/`active`/`settling`/`terminal`/`StreamSession`。把持久 `streamStatus` 当实时相位读是现有 stop/abort 卡死根因，C1 在类型层面切断。
- **本 epic 只定义领域实体/值对象/枚举/端口骨架**，不含用例实现体：`ManageSessionService`/`SetSessionTitleService`/`AppendMessageService`/`GetSessionHistoryService` 的逻辑，以及 `encodeContent`/`decodeContent` 的实现，均不在本 epic 范围（新增/变更需求走 correct-course，不在本 epic 内擅自扩展）。

## Non-goals

- 不做会话生命周期用例实现（create/getById/list/archive/touch/delete 逻辑属 epic-c1-3）。
- 不做消息内容编解码实现（`ContentBlock` 联合明细、`encode/decodeContent` 往返与脏输入降级属 epic-c1-2；本 epic 的 `Message.content` 只引用 `MessageContent` 类型占位）。
- 不做标题状态机用例实现（`setByUser`/`generateByAi` 逻辑与 TitleGenerator 降级属 epic-c1-4）与消息生命周期用例（append/updateStreamStatus/getHistory/getPromptView 逻辑属 epic-c1-5）。
- 不接 NestJS DI / Controller / SQLite 适配器（`ConversationModule` forwardRef 解环、`SessionController`/`MessageController`、`SqliteSessionRepository`/`SqliteMessageRepository` 属 epic-c1-6）。
- 不做 C2/C5 消费契约验证（属 epic-c1-6）。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿：C1 领域类型（`ChatSession`/`Message`/`TokenUsage`/`StreamStatus`/`TitleOrigin`/`c1.*` 键）与端口（4 驱动 + 2 被驱动 + `TitleGeneratorPort` 引用）在 `verbatimModuleSyntax` 下 `tsc --build` 通过；`canTransition` 合法/非法推进与 `canOverrideTitle` 覆盖矩阵单测通过；`index.ts` 只导出端口与领域类型。禁用 import 静态守卫对 conversation 核心包 0 命中（含 `@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`Date.now`/`randomUUID`/`crypto`），且 C1 无 `phase`/`StreamSession` 概念（AC-8/AC-11 静态断言 0 命中）。

## Assumptions

- 假设 SK 已交付并稳定：`Clock`/`IdGenerator`（已 done，见 `packages/core/src/ports/`）与 `TranslationPort`/`RuntimeLog`（属 SK-3/SK-4）端口签名为最终版本；C1 端口签名中对 SK 类型的 `import type` 引用以其为准。若在 dispatch 时 SK 横切端口尚不可用，端口签名可先以本地类型别名占位并标注，待 SK 交付后对齐（走 correct-course）。
- 假设 C2 的 `TitleGeneratorPort` 接口形状（`TitleGenerationInput` 含 `sessionId`/`recentMessages`，`generateTitle(input): Promise<string>`）以 architecture §5.3 为准；C1 侧只做 `import type` 本地引用别名，实现由 C2 Module 提供。若 C2 端口尚未落地，C1 可先在 `ports/driven/title-generator.ts` 声明该接口形状占位，待 C2 交付后收敛为跨包引用。
- 假设 `packages/core` 脚手架、`ports/` 目录约定与 `npm run test` 运行器已由 SK 冲刺就位（现状：`packages/core/src/{domain,ports}` 已存在 SK 产物）；C1 conversation 领域代码落于 `packages/core/src/` 下对应 conversation 子树，目录结构对齐 architecture §2。
- 假设 architecture §3/§4/§5 的类型签名与字段归属为最终版本，无待决问题；字段增删或改名走 correct-course 而非在本 epic 内擅自扩展。
