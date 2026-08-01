---
title: 产品简报 — C10 Task 任务
context: C10 · Task
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C10 · Task（任务）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 一句话定位

C10 是 CodePilot Web 里负责**接收、持久化并对外提供 TodoWrite 任务项**的限界上下文。AI 在一次会话里通过 TodoWrite 工具产出一份"待办清单"（todo 列表），C10 把这份清单**同步**进本地存储、维护其状态（pending / in_progress / completed），并供前端按会话读取展示。它**不关心任务由谁产生**——TodoWrite 事件从 AI 流式回合里冒出来是 C2（AgentRuntime）的职责，C10 只在接到"这一轮的最新 todo 快照"时负责把它落地、供人查看。

## 2. 解决什么问题

CodePilot 的 AI Agent（Claude SDK / Codex）在执行多步任务时，会用 TodoWrite 工具维护一份内部待办清单——"先读文件、再改代码、然后跑测试"。这份清单对用户价值极高：它把 AI 的执行计划显性化，让用户实时看到"AI 打算做什么、做到哪一步了"。但 TodoWrite 的原始数据是**流式事件里的瞬时快照**，如果不落地：

- 刷新页面 / 重开会话就丢失，用户看不到 AI 之前规划过什么。
- 前端只能靠内存态渲染，无法跨请求、跨设备一致展示。
- AI 每一轮都会重发整份清单（TodoWrite 是"全量覆盖"语义，不是增量补丁），需要一个稳定的同步策略把"最新一份"落地而不产生重复。

现有 CodePilot 已在 `db.ts` 沉淀了这条链路：`tasks` 表 + `syncSdkTasks(sessionId, todos)` 采用**替换式全量同步**（删掉该会话所有 `source='sdk'` 任务，再按最新清单重插，用户手建任务 `source='user'` 不受影响）。C10 的任务是把它从"散落在 db.ts 里的一个函数 + tasks 表"重构进六边形架构，让任务同步收口到一个可测、语义清晰、来源可追的用例与仓储端口后面。

痛点集中在：

- **瞬时快照不落地就丢**：TodoWrite 事件是内存态，必须持久化才能跨请求展示与回看。
- **全量覆盖语义容易同步错**：TodoWrite 每轮重发整份清单，若用增量思路处理会产生重复/残留旧项；必须用"替换式全量同步"且只替换 AI 来源的任务。
- **AI 任务与用户任务混淆**：同一会话里既有 AI 自动产生的任务，也可能有用户手建任务；同步 AI 清单时不能误删用户任务（source 字段是关键语义）。
- **状态语义要诚实**：任务项的 `pending / in_progress / completed` 必须如实映射 SDK 上报的真实状态，不能拿默认值冒充；无法识别的状态要有明确降级，不能静默当成 completed。

## 3. 目标用户与价值

- **单机开发者用户**：在会话界面看到 AI 的执行计划清单实时更新——哪些做完了（completed）、正在做哪一步（in_progress）、还剩什么（pending）；刷新或重开会话后清单仍在，能回看 AI 曾经的规划。
- **接入 C10 的其他上下文**：C10 边界契约声明"依赖端口：无"，是相对独立的小上下文。它对外提供 `SyncTasksUseCase`（供上游把一轮 TodoWrite 快照同步进来）与出站 `TaskRepository`（持久化）。C2 在处理 TodoWrite 事件时调用 `SyncTasksUseCase`，但 C2 不需要知道任务如何存储；前端读取会话任务列表也经 C10 用例。

价值主张：**把 AI 流式回合里瞬时的 TodoWrite 待办快照，安全落地成一份来源清晰、状态诚实、可跨请求回看的会话任务清单。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C10 契约：

- **拥有**：
  - **TodoWrite 任务项同步**：接收一次会话回合的 todo 清单快照，按替换式全量同步策略落地（删旧 AI 任务 + 插新清单），维护每个任务项的 `title` / `status` / `description` / `sort_order` / `source` / 时间戳。
  - 任务项领域模型：`Task` 实体、`TaskStatus` 状态语义（pending / in_progress / completed，含 failed 兼容位）、`TaskSource`（sdk / user）、`TodoSnapshot`（一轮待同步的输入快照）。
  - SDK 状态到本地状态的映射规则（`mapSdkStatus`，未知状态降级为 pending）。
  - 任务项按会话的读取与排序（sort_order 优先、created_at 次之）。
- **不包含**：
  - **任务由谁产生** —— TodoWrite 事件如何从 AI 流式回合里被解析出来、AI 在什么时机调用 TodoWrite，全部属 C2（AgentRuntime）。C10 只在接到"最新一份 todo 快照"时负责同步，不订阅事件流、不解析 AgentStreamEvent。
  - 会话/消息实体（属 C1）；C10 只持有对 `session_id` 的引用作为任务归属键，不拥有会话本身的生命周期。
  - 子 agent 编排的 run/attempt 任务（属 C3，那是"逻辑运行"的分阶段任务，与 TodoWrite 待办清单是不同概念）。
  - 定时任务 / 调度（现有 `scheduled_tasks` 表属另一套调度机制，不在 C10 的 TodoWrite 任务项范围）。
- **依赖端口（只引用，不重写）**：
  - 契约表声明 C10 **依赖端口：无**（相对独立，最简依赖）。
  - 横切能力（`SK.Clock` 提供时间戳、`SK.IdGenerator` 生成任务 id、`SK.RuntimeLog` 记同步日志、`SK.TranslationPort` 若有对外文案）在架构上作为可选横切注入使用；契约主线依赖仍为"无"，即 C10 不依赖任何**业务上下文**。
- **对外提供端口**：
  - `SyncTasksUseCase` —— 把一轮 TodoWrite 快照同步进存储、读取会话任务列表的驱动端口。
  - `TaskRepository` —— 出站端口，抽象"任务项如何持久化"，由 `SqliteTaskRepository`（better-sqlite3 直写 `tasks` 表）实现。

## 5. 与 CodePilot 现有实现的对应

| C10 概念 | 现有落点（`src/lib/db.ts` / `src/types/index.ts`） |
|---|---|
| 任务项实体 | `TaskItem`（id / session_id / title / status / description / source / sort_order / created_at / updated_at） |
| 任务状态 | `TaskStatus = 'pending' \| 'in_progress' \| 'completed' \| 'failed'` |
| 替换式全量同步 | `syncSdkTasks(sessionId, todos)`——事务内删 `source='sdk'` 再全量重插，`source='user'` 不动 |
| SDK 状态映射 | `syncSdkTasks` 内的 `mapStatus`（completed / in_progress / pending，default→pending） |
| 稳定任务 id | `sdk-${sessionId}-${todo.id}`（同一 todo 跨轮 id 稳定，便于前端 diff） |
| 稳定排序 | 插入时 `sort_order = i`（按清单顺序），读取 `ORDER BY sort_order ASC, created_at ASC` |
| 读取会话任务 | `getTasksBySession(sessionId)` |
| 单条 CRUD（用户任务） | `createTask` / `updateTask` / `deleteTask`（source='user'） |
| tasks 表 schema | `db.ts` §270 `CREATE TABLE tasks`（含 `FOREIGN KEY session_id → chat_sessions ON DELETE CASCADE`） |

> 现有 `tasks` 表混放 AI 任务（`source='sdk'`）与用户手建任务（`source='user'`）。C10 的核心用例是 **TodoWrite 任务项同步**（契约「拥有：TodoWrite 任务项同步」），即 `syncSdkTasks` 那条链路；用户手建任务的单条 CRUD 作为同表的次要能力保留（`source='user'` 在同步时不被触碰），但 C10 的设计重心与反假数据红线都在"AI 清单的诚实同步"上。

## 6. 成功标准（可度量）

- **S1 同步闭环**：给定一个会话与一份 TodoWrite todo 快照，`SyncTasksUseCase.syncFromTodos` 把它落地；再次读取会话任务列表返回与快照一致的任务项（title / status / 顺序）。
- **S2 替换式全量正确**：连续同步两份不同快照（第二份删了某项、改了某项状态、加了新项）→ 存储反映第二份的最终态，无第一份的残留 AI 任务。
- **S3 用户任务不误删**：会话里既有 `source='user'` 任务又有 `source='sdk'` 任务，同步 AI 清单后用户任务原样保留，只有 AI 任务被替换（反例断言）。
- **S4 状态语义诚实**：SDK 上报 `in_progress` 的任务在存储与读取里就是 `in_progress`，不被冒充为 pending 或 completed；未知状态降级为 pending 且记日志，绝不静默当 completed（反假数据）。
- **S5 排序稳定**：同一份清单同步后读取，任务顺序与清单顺序一致（sort_order 驱动），不因插入时间抖动而乱序。
- **S6 边界纯净**：C10 核心包不 import `better-sqlite3` / `@nestjs/*`、不订阅 AgentStreamEvent、不出现会话/AI 流/子 agent 概念；全部持久化经 `TaskRepository` 注入，全部时间/id 经 SK 端口。

## 7. 非目标（明确排除）

- 不做"TodoWrite 事件如何从 AI 流式回合里被解析产生"（C2）；C10 只接收已解析好的 todo 快照。
- 不做子 agent 的 logical run / attempt / phase 任务建模（C3）。
- 不做定时任务 / 调度（现有 `scheduled_tasks` 是另一套机制）。
- 不做任务的富编辑器 / 依赖关系图 / 甘特图（超出"任务项同步"范畴）。
- 不做任务变更的实时推送 / 订阅（本期为按需拉取；实时性由 C2 回合结束后触发一次同步 + 前端拉取覆盖）。
- 不替 SK 重新实现时钟 / id 生成 / 日志。

## 8. 关键风险与假设

- **假设**：TodoWrite 是**全量覆盖**语义——AI 每次调用都重发整份清单（对齐现有实现与 SDK 行为），因此同步策略是"替换式全量"而非"增量补丁"。若未来 SDK 改为增量语义，同步策略需相应调整（文档标注此假设）。
- **假设**：`session_id` 由上游（C2 / C1）给定且有效；C10 只把它当归属键，不校验会话是否存在（外键约束由存储层的 `chat_sessions ON DELETE CASCADE` 兜底：会话删则任务级联删）。
- **风险（反假数据）**：状态映射失真。SDK 状态字符串若出现 C10 未覆盖的值（如未来新增状态），必须降级为 pending 并记日志，而不是静默当 completed 误导用户"做完了"。这是 C10 语义验收要覆盖的反例路径。
- **风险**：并发同步。同一会话短时间内多轮 TodoWrite（AI 快速更新清单）可能触发并发同步；替换式全量同步必须在**单事务**内完成（删+插原子），避免"删了旧的、新的还没插完"时被读到空清单。
- **风险**：用户任务被误删。同步 AI 清单的删除语句必须严格限定 `source='sdk'`，一旦漏掉这个条件会连用户手建任务一起清空——这是必须写反例 smoke 守护的红线（S3）。
- **风险**：id 不稳定导致前端闪烁。任务项 id 采用 `sdk-${sessionId}-${todoId}` 派生式稳定 id（对齐现有），同一 todo 跨轮 id 不变，前端可据此做 diff 动画而非整列重渲。
