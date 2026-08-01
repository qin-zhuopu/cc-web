---
title: 需求文档 (PRD) — C10 Task 任务
context: C10 · Task
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C10 · Task（任务）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C10 存在若干"用户可见的任务清单状态"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能。任务清单里最容易误导用户的是"每一项的状态"和"这份清单是不是最新的"——它们必须如实反映 SDK 上报的真实 todo 快照，不能拿默认值冒充、不能把未识别状态静默归为完成：

| 用户可见字段 | 语义（用户会怎么理解） | 真实来源 breadcrumb | 缺失/不确定来源时的降级 |
|---|---|---|---|
| 任务项 `title` | 这一步 AI 要做什么 | `TodoSnapshot.items[].content`（TodoWrite `content`，由 C2 解析后传入） | content 为空的 todo 项跳过，不插空标题 |
| 任务项 `status` | 这一步做完没 / 在做没 | `mapSdkStatus(todo.status)`（SDK 上报状态映射） | 未知状态 → `pending` 且记 `SK.RuntimeLog`，绝不静默当 `completed` |
| 任务项 `description` | 这一步的补充说明 | `TodoSnapshot.items[].activeForm`（TodoWrite `activeForm`，可空） | 无 activeForm 时留空（`null`），不编造 |
| 任务项 `source` | 这是 AI 规划的还是我建的 | `'sdk'`（本用例同步）/ `'user'`（用户手建，另一路径） | 同步路径产出的项恒为 `'sdk'`，不混淆 |
| 任务项顺序 | 这些步骤的先后 | `sort_order`（同步时按快照 index 赋值） | 读取 `ORDER BY sort_order ASC, created_at ASC`，稳定 |
| 任务项 `id` | 前端 diff / 定位用的稳定键 | `sdk-${sessionId}-${todoId}`（派生式稳定 id） | 同一 todo 跨轮 id 不变，供前端 diff |
| 任务项 `updated_at` | 这项啥时候更新的 | `SK.Clock.now()`（同步时刻） | 每次同步刷新，来自实测时钟 |
| 清单整体 | 这是不是 AI 当前的最新计划 | 替换式全量同步后的存储状态（删旧 sdk 项 + 插新快照） | 同步在单事务内原子完成，不会被读到半截清单 |

**原则**：没有真实来源的字段一律隐藏 / 标 unsupported / 留空。核心反假红线——**任务状态必须如实映射 SDK 上报值，未知状态降级为 pending 而非 completed**；且**替换式全量同步只影响 `source='sdk'` 的任务，绝不误删用户手建任务**。

## 1. 功能需求 (Functional Requirements)

### FR-1 TodoWrite 任务项同步（`SyncTasksUseCase.syncFromTodos`）
- FR-1.1 给定 `sessionId` 与一份 `TodoSnapshot`（AI 一轮 TodoWrite 产出的 todo 列表，每项含 `id` / `content` / `status` / 可选 `activeForm`），把它同步进存储，产出/更新对应的任务项集合。
- FR-1.2 **替换式全量同步**：同步在**单事务**内完成——先删除该会话所有 `source='sdk'` 的任务，再按快照顺序全量重插。这对齐 TodoWrite 的"全量覆盖"语义（AI 每轮重发整份清单），保证存储反映的是**最新一份**清单，无旧项残留。
- FR-1.3 **用户任务隔离**：删除步骤严格限定 `source='sdk'`；`source='user'` 的用户手建任务在同步中**原样保留**，绝不被 AI 清单同步波及。
- FR-1.4 **稳定 id**：每个同步产出的任务项 id 为 `sdk-${sessionId}-${todo.id}`（派生式稳定 id），同一 todo 跨轮同步 id 不变，供前端做 diff 而非整列重渲。
- FR-1.5 **稳定排序**：插入时按快照 index 赋 `sort_order`（第 i 项 sort_order=i），读取时 `ORDER BY sort_order ASC, created_at ASC`，保证展示顺序与 AI 清单顺序一致。
- FR-1.6 **空快照处理**：`TodoSnapshot.items` 为空数组时，同步等价于"清空该会话的 AI 任务"（删除所有 `source='sdk'`，不插任何项），这是合法状态（AI 清空了待办清单），不报错。
- FR-1.7 **无效项过滤**：`content` 为空/仅空白的 todo 项在同步时跳过，不插入空标题任务（对齐反假数据"不插空标题"）。

### FR-2 SDK 状态映射（领域纯函数 `mapSdkStatus`）
- FR-2.1 把 SDK 上报的状态字符串映射为 `TaskStatus`：`'completed'→'completed'`、`'in_progress'→'in_progress'`、`'pending'→'pending'`。
- FR-2.2 **未知状态降级**：任何未覆盖的状态字符串（含空串、大小写异常、未来新增值）映射为 `'pending'`，**绝不映射为 `'completed'`**（反假数据红线：不能让"未识别"看起来像"做完了"），并由用例层记 `SK.RuntimeLog`（level=warn，source=`c10.task`）标注遇到未知状态。
- FR-2.3 `mapSdkStatus` 为**纯函数**（相同输入相同输出，无 I/O），可表驱动单测。
- FR-2.4 `TaskStatus` 保留 `'failed'` 作为兼容位（现有 schema CHECK 约束含 `failed`），但 TodoWrite 同步路径本身不产生 `failed`（该值供用户任务或未来扩展使用）。

### FR-3 会话任务读取（`SyncTasksUseCase.listBySession`）
- FR-3.1 给定 `sessionId`，返回该会话下的全部任务项（含 `source='sdk'` 与 `source='user'`），按 `sort_order ASC, created_at ASC` 排序。
- FR-3.2 返回的每个任务项字段齐全：`id` / `sessionId` / `title` / `status` / `description`（可空）/ `source` / `sortOrder` / `createdAt` / `updatedAt`，字段语义对齐 §0 契约表。
- FR-3.3 会话无任务时返回空数组（不返回 null、不报错）。

### FR-4 用户任务单条操作（次要能力，`ManageUserTaskUseCase`）
- FR-4.1 承接现有 `createTask` / `updateTask` / `deleteTask`：用户可手建任务（`source='user'`，初始 `status='pending'`）、改标题/状态/描述、删除单条。
- FR-4.2 这些操作只针对 `source='user'` 的任务；用例层可对目标任务做 source 校验（防误改 AI 同步任务，避免下一轮同步覆盖用户改动产生困惑）。
- FR-4.3 此为次要能力，与 C10 核心（TodoWrite 同步）共用 `TaskRepository`，不引入新出站端口。

### FR-5 仓储抽象（`TaskRepository` 出站端口）
- FR-5.1 C10 核心与用例只依赖 `TaskRepository` 接口，不直接 import `better-sqlite3`。
- FR-5.2 默认实现 `SqliteTaskRepository`：better-sqlite3 直写 `tasks` 表，承接现有 `db.ts` 的 `syncSdkTasks` / `getTasksBySession` / `createTask` / `updateTask` / `deleteTask` 全部 SQL；`replaceSdkTasks` 必须在 `db.transaction` 内执行（FR-1.2 原子性）。
- FR-5.3 `session_id → chat_sessions ON DELETE CASCADE` 外键约束保留：会话删除时其任务级联删除，C10 不需额外清理逻辑。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/task/` 禁止 import `better-sqlite3`、`@nestjs/*`、`@anthropic-ai/*` 或任何 AgentStreamEvent 相关类型；全部持久化经 `TaskRepository` 注入，时间戳经 `SK.Clock`，id 经 `SK.IdGenerator`（用户任务）或派生规则（sdk 任务）。C10 不订阅事件流。
- NFR-2 **同步原子性**：替换式全量同步（删 sdk + 插新）必须单事务原子完成，杜绝并发同步下"删了旧的、新的没插完"被读到空/半截清单的窗口。（FR-1.2）
- NFR-3 **反假数据**：状态映射如实、未知降 pending 不降 completed；用户任务同步中不被删；空标题不插。语义契约见 §0。
- NFR-4 **可测**：同步与读取均可用假 `TaskRepository`（内存 Map）做纯单元测试，无需真实 SQLite；`mapSdkStatus` 纯函数可表驱动测试；替换式同步的"用户任务不删"用反例断言。
- NFR-5 **错误统一 / i18n**：对外错误（如无效输入）用稳定 code + i18n messageKey（`c10.*`）经 `SK.TranslationPort`；DB 底层异常经 `SK.ErrorClassifier` 归类（同步失败通常归 `FILESYSTEM` 或 `UNKNOWN`），不把裸 SQL 错误串暴露给前端。
- NFR-6 **性能**：同步与读取按 `session_id` 走索引（`idx_tasks_session_id`）；单会话任务量级为几十条，无需分页。
- NFR-7 **幂等**：同一份 `TodoSnapshot` 重复同步两次，结果一致（稳定 id + 替换式全量保证幂等，无重复插入）。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.1/1.5）给定一份含 3 项的 TodoSnapshot，`syncFromTodos` 后 `listBySession` 返回 3 个任务项，title / 顺序与快照一致，id 为 `sdk-{sessionId}-{todoId}`。
- AC-2（FR-1.2）**替换式全量反例**：先同步快照 A（3 项），再同步快照 B（删了 A 的第 2 项、改了第 1 项状态、加了 1 新项）→ `listBySession` 返回的恰好是 B 的最终态（无 A 残留项、状态为 B 的状态）。
- AC-3（FR-1.3）**用户任务不误删反例（核心红线）**：会话内先建 1 个 `source='user'` 任务，再同步一份 AI 快照 → 用户任务原样保留，`source='sdk'` 任务被替换为快照内容；再同步空快照 → 用户任务仍在，sdk 任务清空。
- AC-4（FR-2.1/2.2）**状态映射反例**：SDK 状态 `'completed'/'in_progress'/'pending'` 分别映射正确；SDK 状态 `'blocked'`（未知）→ 映射为 `'pending'`（**不是 completed**）且触发一条 warn 日志。
- AC-5（FR-1.6）同步空 TodoSnapshot（items=[]）→ 该会话 sdk 任务清空，不报错，用户任务不受影响。
- AC-6（FR-1.7）快照含一个 `content=''` 的 todo 项 → 该项被跳过，不产生空标题任务。
- AC-7（FR-3.1/3.3）`listBySession` 对无任务会话返回 `[]`；对混合会话返回 sdk+user 全部，按 sort_order 排序。
- AC-8（FR-2.3）`mapSdkStatus` 表驱动单测覆盖已知 3 状态 + 至少 2 个未知状态（空串、任意字符串）全部降 pending。
- AC-9（NFR-2）**原子性反例**：用假 `TaskRepository` 模拟 `replaceSdkTasks` 中途抛错 → 事务回滚，存储保持同步前状态（旧 sdk 任务未被删）。（在 SqliteTaskRepository 层由 `db.transaction` 保证；核心层由端口契约"replaceSdkTasks 语义上原子"约定 + 假实现验证回滚语义）
- AC-10（NFR-7）**幂等反例**：同一份快照连续同步两次 → `listBySession` 结果与同步一次完全相同，无重复项。
- AC-11（FR-4.2）用户任务操作反例：对 `source='sdk'` 的任务调用 `ManageUserTaskUseCase.update` → 被拒（或明确降级），防用户改动被下一轮同步无声覆盖。
- AC-12（NFR-1）对 `task/` 核心包做禁用 import 静态扫描（`better-sqlite3`/`@nestjs/*`/`@anthropic-ai/*`），0 命中。
- AC-13（NFR-4）用内存假 `TaskRepository` 跑通 `SyncTasksUseCase` 的同步与读取全部单测，**证明 C10 核心与用例完全不依赖 SqliteTaskRepository**（换存储不动核心）。

## 4. 依赖与假设

- 依赖 SK 已交付：`Clock`（时间戳）/ `IdGenerator`（用户任务 id）/ `RuntimeLog`（同步/未知状态日志）/ `ErrorClassifier` / `TranslationPort` 端口稳定（见 SK architecture 第 4 节）作为**横切**注入使用；C10 对**业务上下文**依赖为无（契约 C10「依赖端口：无」）。
- 假设 `TodoSnapshot` 由上游（C2 处理 TodoWrite 事件后）构造并传入，字段（id/content/status/activeForm）已从 AgentStreamEvent 里解析好；C10 不订阅事件、不解析原始工具调用。这是 C10 与 C2 的关键分工线。
- 假设 TodoWrite 是**全量覆盖**语义（AI 每轮重发整份清单），故同步策略为替换式全量；若 SDK 改增量语义需另立需求调整。
- 假设 `session_id` 有效且其会话可能被删除；任务归属经外键 `ON DELETE CASCADE` 与会话生命周期绑定，C10 不主动管理会话删除。
- 假设 `tasks` 表 schema 与现有一致（含 `source` / `sort_order` 列，由 db.ts 迁移保证）；C10 重构不改表结构，只把访问收口进 `TaskRepository`。
