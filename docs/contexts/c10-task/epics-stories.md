---
title: 史诗与故事 — C10 Task 任务
context: C10 · Task
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C10 · Task（任务）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C10 核心包（domain + ports），零框架/零 better-sqlite3/零事件订阅 | FR-1~5 的类型基础、NFR-1 |
| E2 状态映射与快照净化 | SDK 状态诚实映射（未知降 pending）+ 快照过滤 + id 派生纯函数 | FR-2、FR-1.4/1.7 |
| E3 TodoWrite 任务项同步 | 替换式全量同步 + source 隔离 + 空快照 + 幂等（C10 核心） | FR-1 |
| E4 会话任务读取 | 按会话读取 + 排序 + 空处理 | FR-3 |
| E5 用户任务次要能力 | create/update/remove + source 不可变校验 | FR-4 |
| E6 SqliteTaskRepository 与可替换 | better-sqlite3 直写 + 事务原子 + 假端口可替换验证 | FR-5 |
| E7 NestJS 接线与错误映射 | Module/Controller + C2 进程内消费 + 错误码→HTTP + i18n | DI、NFR-5 |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `Task` 实体（对齐现有 `TaskItem`，snake→camel，`description: string | null` 落实反假数据）与 `TaskSource`（'sdk'|'user'）。**AC**：类型往返不丢字段，无 activeForm 时 description 留空而非空串。（FR-1.1）
- **S1.2** 定义 `TaskStatus`（pending/in_progress/completed/failed）值类型。**AC**：与现有 schema CHECK 约束的四值一致。（FR-2.4）
- **S1.3** 定义 `TodoSnapshot` / `TodoItem` 输入快照值对象（对齐现有 `syncSdkTasks` 的 todos 入参形状 `{id, content, status, activeForm?}`）。**AC**：类型即 C10↔C2 输入契约，不含任何 AgentStreamEvent 引用。（FR-1.1）
- **S1.4** 定义结构化错误 `TaskError`（invalid_input/task_not_found/source_immutable/sync_failed），带 `messageKey`（`c10.*`）。**AC**：错误无硬编码 message，只 code+messageKey。（NFR-5）
- **S1.5** 定义驱动端口 `SyncTasksUseCase`（syncFromTodos/listBySession）、`ManageUserTaskUseCase`（create/update/remove）与出站端口 `TaskRepository`（replaceSdkTasks/listBySession/findById/insertUserTask/updateTask/deleteTask）。**AC**：核心 `index.ts` 只导出端口与领域类型。（FR-1/3/4/5）
- **S1.6** 建立禁用 import 静态扫描。**AC-12**：`task/` 对 `better-sqlite3`/`@nestjs/*`/`@anthropic-ai/*` 0 命中，且无 AgentStreamEvent import。（NFR-1）

## E2 · 状态映射与快照净化

- **S2.1** 实现 `mapSdkStatus` 纯函数：已知 3 状态直映，未知（含空串/异常值）→ `{status:'pending', wasUnknown:true}`。**AC-4/AC-8**：表驱动覆盖已知 3 + 未知 ≥2，未知恒降 pending 绝不 completed（反假数据红线）。（FR-2.1/2.2/2.3）
- **S2.2** 实现 `sanitizeSnapshot` 纯函数：过滤 content 空/仅空白的 todo 项。**AC-6**：空 content 项被跳过，不产生空标题任务。（FR-1.7）
- **S2.3** 实现 `deriveSdkTaskId` 纯函数：`sdk-${sessionId}-${todoId}`。**AC-1**：同一 sessionId+todoId 跨轮 id 稳定。（FR-1.4）

## E3 · TodoWrite 任务项同步（C10 核心）

- **S3.1** 实现 `SyncTasksService.syncFromTodos` 编排：sessionId 校验 → sanitize → 逐项算 id/status/sortOrder/description/时间戳（clock）→ 组装 `SdkTaskRow[]`。**AC-1**：基础同步字段/顺序/id 正确。（FR-1.1/1.5）
- **S3.2** **替换式全量**：调 `repo.replaceSdkTasks(sessionId, rows)`（删 sdk + 插新，单事务）。**AC-2**：快照 A→B 后存储为 B 最终态，无 A 残留。（FR-1.2）
- **S3.3** **用户任务隔离**（核心红线）：replaceSdkTasks 删除限定 `source='sdk'`，user 任务原样保留。**AC-3**：会话含 user 任务，多轮 sdk 同步（含空快照）后 user 任务始终保留。（FR-1.3）
- **S3.4** **空快照**：items=[] → 清空该会话 sdk 任务、不报错、不动 user。**AC-5**：空快照清空 sdk。（FR-1.6）
- **S3.5** **未知状态日志**：同步中遇 `wasUnknown` 项，同步结束记一条 warn（含未知状态样本，source=`c10.task`）经 `SK.RuntimeLog`。**AC-4**：'blocked' 状态触发 warn 日志且 status='pending'。（FR-2.2/NFR-3）
- **S3.6** **幂等 + 回传列表**：同步后 `return repo.listBySession(sessionId)`；同一快照同步两次结果一致。**AC-10**：幂等断言无重复项。（NFR-7）
- **S3.7** **同步失败归类**：DB 异常经 `SK.ErrorClassifier.classify` 后包 `TaskError('sync_failed')`，不泄漏裸 SQL 串。**AC**：错误对外为结构化 code。（NFR-5）

## E4 · 会话任务读取

- **S4.1** 实现 `SyncTasksService.listBySession`：直调 `repo.listBySession`，按 sort_order ASC, created_at ASC 排序。**AC-7**：混合会话 sdk+user 按序返回。（FR-3.1/3.2）
- **S4.2** 空会话处理：无任务返回 `[]`（非 null、不报错）。**AC-7**：空会话返回空数组。（FR-3.3）

## E5 · 用户任务次要能力

- **S5.1** 实现 `ManageUserTaskService.create`：source='user'、status='pending'、id 由 `SK.IdGenerator`、时间戳由 `SK.Clock` → `repo.insertUserTask`。（FR-4.1）
- **S5.2** 实现 `update`：findById → 不存在 `task_not_found`；`source='sdk'` → `source_immutable`（防用户改动被下轮同步覆盖）；否则合并 patch（description 区分未提供 vs 置 null）。**AC-11**：改 sdk 任务被拒。（FR-4.1/4.2）
- **S5.3** 实现 `remove`：`repo.deleteTask`，返回 false → `task_not_found`。（FR-4.1）

## E6 · SqliteTaskRepository 与适配器可替换

- **S6.1** 实现 `SqliteTaskRepository.replaceSdkTasks`：`db.transaction` 内 `DELETE ... WHERE session_id=? AND source='sdk'` + 全量 `INSERT`（承接现有 `syncSdkTasks` 事务体，行数据由用例传入）。**AC-9**：事务中途失败整体回滚。（FR-5.2/NFR-2）
- **S6.2** 实现 `listBySession`/`findById`/`insertUserTask`/`updateTask`/`deleteTask`（承接现有 `getTasksBySession`/`getTask`/`createTask`/`updateTask`/`deleteTask`）+ 行 ↔ `Task` 编解码（snake↔camel）。（FR-5.2）
- **S6.3** 保留 `session_id → chat_sessions ON DELETE CASCADE` 外键，C10 不加额外清理。**AC**：删会话时任务级联删。（FR-5.3）
- **S6.4** 内存假 `TaskRepository`（Map 实现，可编程 replaceSdkTasks 中途抛错）供单测。**AC-13**：全部用例跑在假端口上绿，证明核心不依赖 SqliteTaskRepository。（FR-5.1/NFR-4）

## E7 · NestJS 接线与错误映射

- **S7.1** `TaskModule`：imports SharedKernelModule，provides `SyncTasksUseCase`→`SyncTasksService`、`ManageUserTaskUseCase`→`ManageUserTaskService`、`TaskRepository`→`SqliteTaskRepository`，exports `SyncTasksUseCase`（供 C2 跨 Module 消费）。（DI 章节）
- **S7.2** `TaskController`：`GET /api/tasks?sessionId=` → listBySession；`POST/PATCH/DELETE /api/tasks/*` → 用户任务操作。`syncFromTodos` 不走 HTTP，由 C2 进程内注入调用。（DI 章节）
- **S7.3** 错误码→HTTP 映射：`TaskError.code` → 400（invalid_input）/404（task_not_found）/409（source_immutable）/500（sync_failed）；`messageKey` 经 `SK.TranslationPort` 渲染。**AC**：各 code 映射正确状态。（NFR-5）
- **S7.4** C2 消费接线：C2（AgentRuntime）处理 TodoWrite 事件后构造 `TodoSnapshot`，经跨 Module import 的 `SyncTasksUseCase.syncFromTodos` 同步；验证 C2→C10 单向无环。**AC**：C10 不反向依赖/订阅 C2。（DI 章节）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S2.3, S3.1 |
| AC-2 | S3.2 |
| AC-3 | S3.3 |
| AC-4 | S2.1, S3.5 |
| AC-5 | S3.4 |
| AC-6 | S2.2 |
| AC-7 | S4.1, S4.2 |
| AC-8 | S2.1 |
| AC-9 | S6.1 |
| AC-10 | S3.6 |
| AC-11 | S5.2 |
| AC-12 | S1.6 |
| AC-13 | S6.4 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + 纯函数）**：E1 全部、E2 全部。产出零框架 C10 核心 + 状态映射/快照净化/id 派生纯函数 + 端口接口 + 静态扫描门禁。三纯函数表驱动单测（含未知状态降 pending 反假红线）通过。
- **Sprint 2（同步 + 读取 + 用户任务）**：E3 全部、E4 全部、E5 全部。产出 syncFromTodos/listBySession 用例，反假数据（AC-3 用户任务不误删、AC-4 未知状态不冒充完成）与幂等（AC-10）单测通过（用假端口）。
- **Sprint 3（适配器 + 接线）**：E6 全部、E7 全部。产出 SqliteTaskRepository（事务原子）+ 内存假端口可替换验证（AC-13）+ NestJS Module/Controller + C2 进程内消费接线 + 错误映射。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，用内存假 `TaskRepository`，无需真实 SQLite）。
- 禁用 import 静态扫描 0 命中（AC-12），且核心包无 AgentStreamEvent import（不订阅事件流）。
- 反假数据红线断言通过：未知 SDK 状态降 `pending` 而非 `completed` 且记 warn 日志（AC-4）；替换式同步只删 `source='sdk'`、用户任务原样保留（AC-3）。
- 同步原子性：假端口模拟中途抛错时存储回滚（AC-9）；幂等：同一快照同步两次结果一致（AC-10）。
- 适配器可替换验证通过：核心用例跑在内存假端口上全绿（AC-13）。
- 边界纪律：C10 不出现"任务由谁产生"/AI 流/会话生命周期/子 agent 概念；不 import better-sqlite3/@nestjs/@anthropic-ai；不订阅 AgentStreamEvent；C2→C10 单向无环。
