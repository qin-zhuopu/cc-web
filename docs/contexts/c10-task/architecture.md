---
title: 架构 — C10 Task 任务
context: C10 · Task
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C10 · Task（任务）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS TaskController (HTTP: GET /api/tasks?sessionId=, POST/PATCH/DELETE /api/tasks/*)
                     + C2 在处理 TodoWrite 事件后调用 SyncTasksUseCase（进程内 DI，非 HTTP）
               ↓ 调用驱动端口
        [驱动端口] SyncTasksUseCase / ManageUserTaskUseCase
               ↓
        [应用核心] Domain Model + Use Cases（纯逻辑，零框架，零 better-sqlite3，零事件订阅）
               ↓ 依赖倒置，只依赖接口
        [出站端口] TaskRepository
               +   （横切）SK: Clock / IdGenerator / RuntimeLog / ErrorClassifier / TranslationPort
               ↓ 由适配器实现
        [被驱动适配器] SqliteTaskRepository（better-sqlite3 直写 tasks 表，replaceSdkTasks 走 db.transaction）
```

依赖方向永远指向核心。C10 核心**只依赖 `TaskRepository` 接口与横切 SK 端口**，绝不 import `better-sqlite3`/框架，也**绝不订阅 AgentStreamEvent**。按边界契约，C10 对**业务上下文**依赖为"无"——它不消费任何 C1–C9 的端口，是相对独立的小上下文之一。

**关键分工线（C10 不含"任务由谁产生"）**：TodoWrite 工具调用如何从 AI 流式回合里被解析、AI 在什么时机发 todo，全部是 C2（AgentRuntime）的职责。C2 处理完 TodoWrite 事件后，把解析好的 todo 列表包装成 `TodoSnapshot`，**主动调用** `SyncTasksUseCase.syncFromTodos(sessionId, snapshot)`。C10 是被调用方，不反向订阅 C2 的事件流——这条边界让 C10 保持"纯粹的同步/存储/读取"职责，不被 AI 流式复杂度污染。

## 2. 目录结构

```
packages/core/task/
├── domain/
│   ├── task.ts                  # Task 实体（会话任务项）
│   ├── task-status.ts           # TaskStatus 值类型 + mapSdkStatus 纯函数
│   ├── task-source.ts           # TaskSource 值类型（'sdk' | 'user'）
│   ├── todo-snapshot.ts         # TodoSnapshot / TodoItem 输入快照值对象
│   ├── task-id.ts               # deriveSdkTaskId 纯函数（sdk-${sessionId}-${todoId}）
│   ├── task-error.ts            # TaskError + TaskErrorCode
│   └── message-keys.ts          # C10 自身 i18n 键（c10.*）
├── ports/
│   ├── driving/
│   │   ├── sync-tasks-usecase.ts       # SyncTasksUseCase 驱动端口（核心）
│   │   └── manage-user-task-usecase.ts # ManageUserTaskUseCase 驱动端口（次要）
│   └── driven/
│       └── task-repository.ts          # TaskRepository 出站端口（唯一持久化出口）
├── usecases/
│   ├── sync-tasks.ts            # SyncTasksService（实现 SyncTasksUseCase，编排 TaskRepository + 领域纯函数）
│   └── manage-user-task.ts      # ManageUserTaskService（实现 ManageUserTaskUseCase）
└── index.ts                     # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`SqliteTaskRepository`）位于 `apps/api` 适配器层，不在核心包内。本文件给签名，不给实现。领域层只放**纯逻辑**（状态映射、id 派生、快照过滤），真正的 SQL 与事务归 `SqliteTaskRepository`。

## 3. 领域模型 (Domain Model)

### 3.1 Task — 会话任务项实体

```ts
// domain/task.ts
import type { TaskStatus } from './task-status';
import type { TaskSource } from './task-source';

export interface Task {
  readonly id: string;                    // sdk: sdk-${sessionId}-${todoId} / user: SK.IdGenerator
  readonly sessionId: string;             // 归属会话（外键，ON DELETE CASCADE）
  readonly title: string;                 // 任务标题（来自 TodoItem.content 或用户输入，非空）
  readonly status: TaskStatus;            // pending / in_progress / completed / failed
  readonly description: string | null;    // 补充说明（来自 TodoItem.activeForm，可空）
  readonly source: TaskSource;            // 'sdk'（TodoWrite 同步）/ 'user'（手建）
  readonly sortOrder: number;             // 展示顺序（同步时按快照 index）
  readonly createdAt: string;             // ISO 时间串，来自 SK.Clock
  readonly updatedAt: string;             // ISO 时间串，来自 SK.Clock
}
```

> 字段对齐现有 `@/types` 的 `TaskItem`（snake_case → camelCase）。`description` 用 `string | null` 而非默认空串，落实反假数据"无 activeForm 留空不编造"。领域层 `Task` 是不可变值对象；持久化行 ↔ `Task` 的编解码在 `SqliteTaskRepository` 内完成（snake_case 列名映射）。

### 3.2 TaskStatus — 状态值类型 + 映射纯函数

```ts
// domain/task-status.ts
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * 把 SDK 上报的 todo 状态字符串映射为 TaskStatus。纯函数。
 * 反假数据红线：未知状态一律降级为 'pending'，绝不降为 'completed'。
 * 返回 { status, wasUnknown }，wasUnknown=true 时用例层需记 warn 日志。
 */
export function mapSdkStatus(raw: string): { status: TaskStatus; wasUnknown: boolean };
```

> 映射表：`completed→completed`、`in_progress→in_progress`、`pending→pending`，其余（含空串、大小写异常、未来新增值）→ `{ status:'pending', wasUnknown:true }`。承接现有 `syncSdkTasks` 内的 `mapStatus`，但**显式回传 `wasUnknown`** 以支撑 FR-2.2 的日志要求（现有实现静默降级，C10 补上诚实标注）。`'failed'` 是 schema 兼容位，同步路径不产生，供用户任务/未来扩展用。

### 3.3 TaskSource — 来源值类型

```ts
// domain/task-source.ts
export type TaskSource = 'sdk' | 'user';
// 'sdk'：由 TodoWrite 同步产生，替换式全量同步会删它、重插它。
// 'user'：由用户手建，同步中原样保留，绝不被 sdk 同步波及（FR-1.3 红线）。
```

### 3.4 TodoSnapshot — 一轮 TodoWrite 输入快照

```ts
// domain/todo-snapshot.ts
export interface TodoItem {
  readonly id: string;                    // TodoWrite 项 id（跨轮稳定，用于派生任务 id）
  readonly content: string;               // 待办内容 → Task.title
  readonly status: string;                // SDK 原始状态字符串（未映射）→ mapSdkStatus
  readonly activeForm?: string;           // 进行时描述（可选）→ Task.description
}

export interface TodoSnapshot {
  readonly items: ReadonlyArray<TodoItem>; // 一轮 TodoWrite 的完整清单（全量语义，可为空数组）
}

/** 过滤无效项（content 为空/仅空白的 todo 跳过）。纯函数。（FR-1.7） */
export function sanitizeSnapshot(snapshot: TodoSnapshot): ReadonlyArray<TodoItem>;
```

> `TodoSnapshot` 是 C10 与 C2 的**输入契约**：C2 从 AgentStreamEvent 解析 TodoWrite 工具调用后，构造该快照传入。C10 不认识 AgentStreamEvent，只认 `TodoSnapshot`。字段对齐现有 `syncSdkTasks(sessionId, todos)` 的 `todos` 入参形状 `{ id, content, status, activeForm? }`。

### 3.5 任务 id 派生（纯函数）

```ts
// domain/task-id.ts
/** 派生 sdk 任务的稳定 id：同一 sessionId+todoId 跨轮同步 id 不变。纯函数。（FR-1.4） */
export function deriveSdkTaskId(sessionId: string, todoId: string): string;
// 实现：`sdk-${sessionId}-${todoId}`（对齐现有 syncSdkTasks）
```

### 3.6 结构化错误

```ts
// domain/task-error.ts
export type TaskErrorCode =
  | 'invalid_input'        // 快照/参数非法（如 sessionId 空）
  | 'task_not_found'       // 用户任务操作目标不存在
  | 'source_immutable'     // 试图用用户操作改 source='sdk' 任务（FR-4.2）
  | 'sync_failed';         // 同步事务失败（底层异常归类后）

export class TaskError extends Error {
  constructor(
    public readonly code: TaskErrorCode,
    public readonly messageKey: string,        // c10.* i18n 键，经 SK.TranslationPort 渲染
    public readonly meta?: Readonly<Record<string, unknown>>,
  );
}
```

> `messageKey` 而非硬编码 message，落实 i18n（NFR-5）。DB 底层异常经 `SK.ErrorClassifier.classify` 归类后，用例再包成 `TaskError('sync_failed', ...)` 对外，不泄漏裸 SQL 错误串。

## 4. 驱动端口 (Driving Ports)

### 4.1 SyncTasksUseCase — C10 核心对外端口

```ts
// ports/driving/sync-tasks-usecase.ts
import type { Task } from '../../domain/task';
import type { TodoSnapshot } from '../../domain/todo-snapshot';

export interface SyncTasksUseCase {
  /**
   * 把一轮 TodoWrite 快照同步进存储（替换式全量，单事务）。
   * - 删除该会话所有 source='sdk' 任务，按快照顺序全量重插（FR-1.2）。
   * - source='user' 任务原样保留（FR-1.3 红线）。
   * - 空快照 → 清空该会话 sdk 任务，不报错（FR-1.6）。
   * - content 空的项跳过（FR-1.7）。
   * - 遇未知 SDK 状态 → 降 pending 且记 warn 日志（FR-2.2）。
   * 返回同步后该会话的完整任务列表（sdk+user，已排序）。
   */
  syncFromTodos(sessionId: string, snapshot: TodoSnapshot): Promise<ReadonlyArray<Task>>;

  /**
   * 读取会话任务列表，按 sort_order ASC, created_at ASC 排序（FR-3）。
   * 无任务返回 []。
   */
  listBySession(sessionId: string): Promise<ReadonlyArray<Task>>;
}
```

> C10 契约「对外提供：SyncTasksUseCase」。`syncFromTodos` 是核心（TodoWrite 任务项同步），`listBySession` 供前端与其他上下文按会话读取。

### 4.2 ManageUserTaskUseCase — 用户任务次要能力

```ts
// ports/driving/manage-user-task-usecase.ts
import type { Task } from '../../domain/task';
import type { TaskStatus } from '../../domain/task-status';

export interface CreateUserTaskInput {
  sessionId: string;
  title: string;
  description?: string;
}

export interface UpdateUserTaskInput {
  title?: string;
  status?: TaskStatus;
  description?: string | null;
}

export interface ManageUserTaskUseCase {
  /** 手建用户任务（source='user'，status='pending'，id 由 SK.IdGenerator）。（FR-4.1） */
  create(input: CreateUserTaskInput): Promise<Task>;

  /**
   * 改用户任务；若目标 source='sdk' → 抛 TaskError('source_immutable')（FR-4.2），
   * 防用户改动被下一轮 TodoWrite 同步无声覆盖。
   */
  update(taskId: string, input: UpdateUserTaskInput): Promise<Task>;

  /** 删用户任务；目标不存在 → 抛 TaskError('task_not_found')。 */
  remove(taskId: string): Promise<void>;
}
```

## 5. 出站端口 (Driven Ports)

### 5.1 TaskRepository — 唯一持久化出口 & 适配器可替换点

```ts
// ports/driven/task-repository.ts
import type { Task } from '../../domain/task';

/** 一次替换式同步要写入的 sdk 任务行（已由用例算好 id/status/sortOrder/时间戳）。 */
export interface SdkTaskRow {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;              // 已映射的 TaskStatus 字符串
  readonly description: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskRepository {
  /**
   * 替换式全量同步（单事务原子）：删该会话所有 source='sdk' 任务，再插入 rows。
   * source='user' 任务不受影响（删除语句限定 source='sdk'）。
   * 事务中途失败必须整体回滚（NFR-2 / AC-9）。
   */
  replaceSdkTasks(sessionId: string, rows: ReadonlyArray<SdkTaskRow>): Promise<void>;

  /** 读会话全部任务（sdk+user），ORDER BY sort_order ASC, created_at ASC。（FR-3） */
  listBySession(sessionId: string): Promise<ReadonlyArray<Task>>;

  /** 按 id 读单条任务，不存在返回 undefined。 */
  findById(taskId: string): Promise<Task | undefined>;

  /** 插入一条用户任务（source='user'）。（FR-4.1） */
  insertUserTask(task: Task): Promise<void>;

  /** 更新一条任务的 title/status/description + updatedAt。（FR-4.1） */
  updateTask(taskId: string, patch: {
    title: string; status: string; description: string | null; updatedAt: string;
  }): Promise<Task | undefined>;

  /** 删一条任务，返回是否删除成功。 */
  deleteTask(taskId: string): Promise<boolean>;
}
```

- **实现位置**：适配器 `SqliteTaskRepository`（`apps/api`），承接现有 `db.ts`：
  - `replaceSdkTasks` = 现有 `syncSdkTasks` 的事务体（`db.transaction(() => { DELETE ... source='sdk'; INSERT ... })`），行数据由用例算好后传入（适配器只负责 SQL + 事务，不含状态映射/id 派生逻辑——那已在核心纯函数完成）。
  - `listBySession` = `getTasksBySession`（`SELECT * FROM tasks WHERE session_id=? ORDER BY sort_order ASC, created_at ASC`）+ 行 ↔ `Task` 编解码。
  - `findById` = `getTask`。`insertUserTask` = `createTask` 的 INSERT。`updateTask` = `updateTask` 的 UPDATE。`deleteTask` = `deleteTask` 的 DELETE。
- **可替换性（AC-13）**：单测用内存 Map 实现的假 `TaskRepository`（可编程"replaceSdkTasks 中途抛错"验证回滚语义）跑通全部用例，证明核心不依赖 `SqliteTaskRepository`。
- **换存储不动核心**：未来若把存储从 better-sqlite3 换为其他（如远程 DB），只新增一个实现同一 `TaskRepository` 的适配器，C10 核心与两个 UseCase 零改动。

## 6. 用例编排要点

### 6.1 `SyncTasksService`（实现 SyncTasksUseCase）

```ts
// usecases/sync-tasks.ts
export class SyncTasksService implements SyncTasksUseCase {
  constructor(
    private readonly repo: TaskRepository,
    private readonly clock: Clock,             // SK 横切：时间戳
    private readonly log: RuntimeLog,          // SK 横切：未知状态 warn
    private readonly errors: ErrorClassifier,  // SK 横切：DB 异常归类
  ) {}
  // ...
}
```

- **`syncFromTodos`**：
  1. 校验 `sessionId` 非空（否则 `TaskError('invalid_input')`）。
  2. `items = sanitizeSnapshot(snapshot)`（跳过空 content，FR-1.7）。
  3. `now = clock.now()`；对每个 item：`id = deriveSdkTaskId(sessionId, item.id)`、`{status, wasUnknown} = mapSdkStatus(item.status)`、`sortOrder = index`、`description = item.activeForm ?? null`、`title = item.content`；若 `wasUnknown` 累计一条 warn（同步结束记一次汇总日志，含未知状态样本，source=`c10.task`）。
  4. `await repo.replaceSdkTasks(sessionId, rows)`（单事务，删 sdk + 插新，FR-1.2/1.3）。DB 异常经 `errors.classify` 归类后包 `TaskError('sync_failed')`。
  5. `return repo.listBySession(sessionId)`（回传同步后完整列表，sdk+user 已排序）。
- **`listBySession`**：直接 `repo.listBySession(sessionId)`；无任务返回 `[]`。
- **幂等**（NFR-7/AC-10）：稳定 id（`deriveSdkTaskId`）+ 替换式全量 ⇒ 同一快照同步两次结果一致。

### 6.2 `ManageUserTaskService`（实现 ManageUserTaskUseCase）

- **`create`**：`id = idGen.next()`、`source='user'`、`status='pending'`、`sortOrder`=末尾、时间戳来自 `clock` → `repo.insertUserTask`。
- **`update`**：先 `repo.findById`；不存在 → `TaskError('task_not_found')`；`source==='sdk'` → `TaskError('source_immutable')`（FR-4.2/AC-11）；否则合并 patch（未提供字段沿用旧值，`description` 显式区分"未提供"与"置 null"）→ `repo.updateTask`。
- **`remove`**：`repo.deleteTask`；返回 false → `TaskError('task_not_found')`。

## 7. 同步语义关键决策：为什么替换式全量 + source 隔离（关键设计决策）

TodoWrite 是**全量覆盖**语义——AI 每轮调用都重发整份最新清单，而非"追加一项"或"改一项"的增量补丁。基于此：

- **替换式全量而非增量 upsert**：若用增量思路（逐项 upsert + 单独处理删除），需要额外的"上一轮清单 diff 本轮"逻辑，复杂且易漏删。直接"删该会话所有 sdk 任务 + 全量重插"最简、最不易错，且天然幂等（对齐现有 `syncSdkTasks`）。
- **必须单事务**（NFR-2）：删 + 插不原子会有中间窗口——并发读可能看到"旧的删了、新的没插"的空清单。`SqliteTaskRepository.replaceSdkTasks` 用 `db.transaction` 包裹，核心层则以端口契约"replaceSdkTasks 语义上原子、失败整体回滚"约定，假实现据此验证回滚（AC-9）。
- **source 隔离是硬红线**（FR-1.3/AC-3）：删除语句必须严格 `WHERE source='sdk'`。漏掉这个条件会把用户手建任务一起清空——这是最高优先级的反例 smoke 守护点。AI 清单与用户任务在同一张 `tasks` 表共存，靠 `source` 字段区分生命周期。
- **稳定派生 id**（FR-1.4）：`sdk-${sessionId}-${todoId}` 让同一 todo 跨轮同步 id 不变。虽然替换式全量每轮都删了重插，但 id 稳定让前端能据 id 做 diff 动画（哪项从 pending→completed），而非整列重渲闪烁。
- **状态映射诚实**（FR-2.2）：现有 `mapStatus` 对未知状态静默降 pending；C10 显式回传 `wasUnknown` 并记日志，避免"SDK 出了新状态、我们静默当 pending、用户与实际不符还查不到"。这是反假数据在 C10 的落点。

## 8. 依赖注入接线 (NestJS 侧)

```
TaskModule (apps/api)
  imports: [SharedKernelModule]      // 注入 Clock / IdGenerator / RuntimeLog / ErrorClassifier / TranslationPort
  provides:
    SyncTasksUseCase       → SyncTasksService(TaskRepository, Clock, RuntimeLog, ErrorClassifier)
    ManageUserTaskUseCase  → ManageUserTaskService(TaskRepository, IdGenerator, Clock)
    TaskRepository         → SqliteTaskRepository()   // better-sqlite3 直写 tasks 表
  exports:
    SyncTasksUseCase                 // 契约对外提供端口；供 C2 处理 TodoWrite 后调用
    // TaskRepository / ManageUserTaskUseCase 默认不 export（无其他业务上下文消费）
  controllers:
    TaskController
      GET    /api/tasks?sessionId=              → listBySession
      POST   /api/tasks                         → ManageUserTaskUseCase.create
      PATCH  /api/tasks/:id                     → ManageUserTaskUseCase.update
      DELETE /api/tasks/:id                     → ManageUserTaskUseCase.remove
      // syncFromTodos 不走 HTTP：由 C2 在处理 TodoWrite 事件时进程内注入 SyncTasksUseCase 调用。
      // 控制器负责：把 TaskError.code 映射 HTTP 400/404/409/500，
      //            用 SK.TranslationPort 渲染 messageKey。
```

- **`SyncTasksUseCase` 需 export**：C2（AgentRuntime）在处理 TodoWrite 事件后需调用 `syncFromTodos`。虽然边界引用图未画 `C10 ← C2` 的显式箭头（C10 契约「依赖端口：无」指 C10 不依赖别人），但 **C2 消费 C10 的 `SyncTasksUseCase` 是合法的"别人依赖 C10"方向**——通过 NestJS 跨 Module import 实现，C10 核心不反向依赖 C2。这与 C7.ProviderRepository 被 C2 消费同构。
- **C2 → C10 无环**：C2 单向调用 C10（进程内），C10 不回调 C2、不订阅 C2 事件，无循环依赖。
- NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `SyncTasksUseCase` | C10 对外提供 | context-boundaries.md：C10「对外提供端口：SyncTasksUseCase」；由 C2 处理 TodoWrite 后消费 |
| `TaskRepository` | C10 对外提供（出站，本上下文自用） | C10「对外提供端口：TaskRepository」——由 SqliteTaskRepository 实现 |
| `ManageUserTaskUseCase` | C10 内部次要能力 | 承接现有 createTask/updateTask/deleteTask（user 任务），非契约核心端口 |
| （业务上下文依赖） | 无 | C10「依赖端口：无」——不消费任何 C1–C9 端口 |
| `SK.Clock/IdGenerator/RuntimeLog/ErrorClassifier/TranslationPort` | C10 依赖 SK（横切） | SK 对外端口清单（横切全上下文；非业务依赖，不违反"依赖端口：无"主线） |

**边界纪律自检**：
- C10 不含"任务由谁产生"：不订阅 AgentStreamEvent、不解析 TodoWrite 工具调用、不认识 AI 流式相位——那属 C2。C10 只接收 C2 传入的 `TodoSnapshot`。
- C10 不含会话/消息（C1）：只持有 `sessionId` 作归属键，不管理会话生命周期（会话删除靠外键 CASCADE）。
- C10 不含子 agent run/attempt（C3）、定时任务/调度（scheduled_tasks 另一套机制）。
- C10 不 import `better-sqlite3`/`@nestjs/*`/`@anthropic-ai/*`：全部持久化锁在 `SqliteTaskRepository` 后（AC-12 静态扫描）。
- C10 对**业务上下文**零依赖，无循环依赖风险（C2 单向消费 C10.SyncTasksUseCase）。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，用假 `TaskRepository`）：
  - `mapSdkStatus` 表驱动：已知 3 状态映射正确 + 未知状态（空串、'blocked'、大小写异常）全部 `{status:'pending', wasUnknown:true}`（AC-4/AC-8）。
  - `sanitizeSnapshot`：空 content 项被过滤（AC-6）。`deriveSdkTaskId`：id 稳定拼接。
  - `syncFromTodos`：基础同步字段/顺序/id（AC-1）；替换式全量（快照 A→B 最终态无残留）（AC-2）；空快照清空 sdk（AC-5）；幂等（同步两次结果一致）（AC-10）。
  - `listBySession`：无任务返回 `[]`、混合会话 sdk+user 按 sort_order 排序（AC-7）。
- 反例 smoke（反假数据核心）：
  - **用户任务不误删**（AC-3 红线）：会话有 user 任务，多轮 sdk 同步（含空快照）后 user 任务始终原样保留。用假 `TaskRepository` 断言 `replaceSdkTasks` 只动 sdk 行。
  - **未知状态不冒充完成**（AC-4）：SDK 状态 'blocked' 同步后该项 status='pending' 且有一条 warn 日志（断言写入 `SK.RuntimeLog`），绝不为 'completed'。
  - **同步原子性**（AC-9）：假 `TaskRepository.replaceSdkTasks` 编程为中途抛错 → 断言存储保持同步前状态（回滚语义）。
  - **用户操作不改 sdk 任务**（AC-11）：对 source='sdk' 任务调 `update` → 抛 `TaskError('source_immutable')`。
- 适配器可替换（AC-13）：同一批用例单测跑在内存假 `TaskRepository` 上全绿，证明核心不依赖 `SqliteTaskRepository`。
- 静态检查（AC-12）：对 `task/` 核心包做禁用 import 扫描（`better-sqlite3`/`@nestjs/*`/`@anthropic-ai/*`）0 命中。
- 集成 smoke（`SqliteTaskRepository` 真实 SQLite，可选）：真实 `tasks` 表验证 `replaceSdkTasks` 事务、外键 CASCADE（删会话→任务级联删）、`ORDER BY sort_order` 排序端到端一致。
