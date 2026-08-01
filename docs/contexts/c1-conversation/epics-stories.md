---
title: 史诗与故事 — C1 Conversation 会话
context: C1 · Conversation
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C1 · Conversation（会话）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C1 核心包（domain + ports），零框架 | FR-1~5 的类型基础、NFR-1/2 |
| E2 MessageContent 值对象 | 5 类内容块富类型 + 编解码往返 + 脏输入降级 | FR-3 |
| E3 会话生命周期 | CRUD + 改名 + 归档 + touch + source 过滤 | FR-1 |
| E4 标题与来源状态机 | TitleOrigin 覆盖优先级 + 调 C2.TitleGenerator + 降级 | FR-2 |
| E5 消息生命周期 | 追加 + touch + streamStatus 推进 + 历史/prompt 投影 | FR-4 |
| E6 NestJS 接线与消费契约 | Module/Controller/适配器 + C2/C5 经用例读写 | FR-5、DI |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `ChatSession` 实体 + `SessionStatus`/`SessionMode`/`SessionSource` 枚举（仅会话本体字段，运行时/Provider 字段排除）。**AC**：类型往返编解码不丢会话本体字段；运行时字段不在领域模型内。（FR-1.5）
- **S1.2** 定义 `Message` 实体 + `MessageRole` 枚举 + `TokenUsage` 值对象（只存投影）。**AC**：无 tokenUsage 时字段 undefined，不落 0。（FR-4.5）
- **S1.3** 定义 `StreamStatus` 值对象与 `canTransition`，并在类型/lint 层面禁止出现 phase 概念。**AC-8**：静态断言 C1 无 `phase`/`StreamSession`。（NFR-2）
- **S1.4** 定义 `TitleOrigin` 值对象 + `canOverrideTitle` 覆盖优先级谓词。**AC**：`user` 不被 `ai`/`default` 覆盖，全矩阵单测。（FR-2.1）
- **S1.5** 定义 C1 message-keys（`c1.*`，含 `c1.session.defaultTitle`）。**AC**：默认标题经 key，无硬编码文案。（NFR-5）
- **S1.6** 定义驱动端口（ManageSession / SetSessionTitle / AppendMessage / GetSessionHistory）与出站端口（SessionRepository / MessageRepository）+ `import type` 引用 `C2.TitleGeneratorPort`。**AC**：核心包 `index.ts` 只导出端口与领域类型。
- **S1.7** 建立禁用 import 静态扫描。**AC-11**：`conversation/` 对 `@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`Date.now`/`randomUUID` 0 命中。（NFR-1）

## E2 · MessageContent 值对象

- **S2.1** 定义 `ContentBlock` 联合（text/thinking/tool_use/tool_result/code），字段对齐现有 `MessageContentBlock`。**AC**：5 类块类型完整。（FR-3.1）
- **S2.2** 实现 `encodeContent`/`decodeContent` 往返。**AC-5**：5 类块 `encode∘decode` 不丢字段，合法块幂等。（FR-3.2 / NFR-3）
- **S2.3** `decodeContent` 脏输入降级：非 JSON / 非数组 / 异常 → 单个 text 块，永不抛。**AC-5**：喂非 JSON 串断言不抛且内容等于原串。（FR-3.3）
- **S2.4** `tool_result` 的 `isError`/`media`/`sources` 与 `tool_use.input: unknown` 保真。**AC-6**：带可选字段与任意 JSON input 往返一致。（FR-3.4）
- **S2.5** `MessageContent.toPlainText` 投影（拼 text/code），供预览与标题上下文。**AC**：混合块产出稳定纯文本。（FR-4.4 支撑）

## E3 · 会话生命周期

- **S3.1** 实现 `ManageSessionService.create/getById`（id←IdGenerator，时间←Clock）。**AC-1**：CRUD 用注入的假 Clock/IdGenerator，核心无 Date/uuid 直调。（FR-1.1/1.4）
- **S3.2** 实现 `list`（按 updatedAt 倒序 + source 过滤，默认过滤 task）。**AC-2**：task 会话默认不出现，显式请求可取。（FR-1.6）
- **S3.3** 实现 `archive`/`unarchive`/`delete`（级联删消息）。**AC-2/AC-12**：归档不入 active 列表；删会话后消息不可读。（FR-1.2 / NFR-7）
- **S3.4** 实现 `touch`（仅更新 updatedAt）。**AC-7**：touch 用同一 Clock 值。（FR-1.3）

## E4 · 标题与来源状态机

- **S4.1** 实现 `setByUser`（写入 + 标 `user`）。**AC-3**：用户改名后 origin=user。（FR-2.3）
- **S4.2** 实现 `generateByAi`：投影 recentMessages → 调 `C2.TitleGeneratorPort` → 仅当 origin∈{default,ai} 写入并标 `ai`。**AC-3**：user 态不被覆盖 vs default 态被覆盖，两条路径断言不同（反例 smoke）。（FR-2.1/2.2）
- **S4.3** `generateByAi` 降级：TitleGenerator 抛错/不可用 → 保留原标题、不写库、不抛、记 RuntimeLog.warn。**AC-4**：注入 TitleGenerator 抛错断言标题不变。（FR-2.4）
- **S4.4** 确认 C1 不拼 AI 提示词（只 `import type` C2 端口）。**AC**：静态断言无提示词/模型调用代码。（FR-2.5 / 边界纪律）

## E5 · 消息生命周期

- **S5.1** 实现 `AppendMessageService.append`（id←IdGenerator，createdAt←Clock）+ 同一操作内 touch 会话。**AC-7**：追加后会话 updatedAt 更新，与消息同一 now。（FR-4.1 / NFR-7）
- **S5.2** 实现 `updateStreamStatus`（streaming→completed/interrupted/error，校验 `canTransition`）+ 可选 tokenUsage 落库。**AC-8**：合法推进通过、非法回退拒绝。（FR-4.2/4.3）
- **S5.3** 实现 `getHistory`（按 createdAt/rowid 升序，支持 beforeRowId 分页）。**AC**：投影有序。（FR-4.4）
- **S5.4** 实现 `getPromptView`（剔除 isHeartbeatAck / taskRunId 关联的 render-only 消息）。**AC-9**：getHistory 与 getPromptView 对含 taskRunId 消息返回不同。（FR-4.6）
- **S5.5** tokenUsage 投影只存不算。**AC-10**：无 tokenUsage 读回为空，断言不显 0（反假数据）。（FR-4.5）

## E6 · NestJS 接线与消费契约

- **S6.1** `ConversationModule`：imports SharedKernelModule + AgentRuntimeModule(forwardRef 取 TitleGeneratorPort)，provides/exports 4 用例端口，接线适配器。**AC**：C1↔C2 环经 forwardRef 解，核心包仅单向 import type。（DI 章节）
- **S6.2** `SessionController`（REST：会话 CRUD/rename/archive/title:generate）+ `MessageController`（REST：消息列表/追加/stream-status）。**AC**：用户可见状态字段带 source breadcrumb。
- **S6.3** 适配器实现：`SqliteSessionRepository`（会话本体列 ↔ 实体，title_origin ↔ TitleOrigin）/ `SqliteMessageRepository`（content ↔ MessageContent、token_usage/stream_status 编解码、rowid 分页）。**AC**：SQLite 行往返一致。（FR-5.1/5.2/5.3）
- **S6.4** C2/C5 消费契约：C2/C5 `imports` 本 Module 后经 4 用例读写会话/消息；不导出 Repository 写端口给外部直写。**AC-13**：C2/C5 侧对会话/消息的写只能经用例（编译期无直写 Repository 路径）。（FR-5.4）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S3.1 |
| AC-2 | S3.2, S3.3 |
| AC-3 | S4.1, S4.2 |
| AC-4 | S4.3 |
| AC-5 | S2.2, S2.3 |
| AC-6 | S2.4 |
| AC-7 | S3.4, S5.1 |
| AC-8 | S1.3, S5.2 |
| AC-9 | S5.4 |
| AC-10 | S5.5 |
| AC-11 | S1.7 |
| AC-12 | S3.3 |
| AC-13 | S6.4 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + 内容值对象）**：E1 全部、E2 全部。产出零框架 C1 核心骨架 + `MessageContent` 编解码 + 单测。
- **Sprint 2（会话 + 标题 + 消息）**：E3 全部、E4 全部、E5 全部。产出会话/消息生命周期用例 + 标题状态机 + 反例 smoke 通过。
- **Sprint 3（接线 + 消费契约）**：E6 全部。产出 NestJS Module/Controller/适配器 + C2/C5 消费契约（经用例读写）+ forwardRef 解环。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，无需真实 DB/AI，用假出站端口 + 假 Clock/IdGenerator/TitleGenerator）。
- 禁用 import 静态扫描 0 命中（AC-11）；C1 无 phase/StreamSession 概念（AC-8 / NFR-2）。
- 标题覆盖优先级反例断言通过（AC-3）；TitleGenerator 降级断言通过（AC-4）；无假 tokenUsage 0（AC-10）。
- C2/C5 消费契约文档与类型对齐（AC-13）；引用图 `C2.TitleGenerator ← C1`、`C1 会话用例 ← C5` 闭合。
</content>
