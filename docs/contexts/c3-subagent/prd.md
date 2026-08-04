---
title: 需求 — C3 SubagentOrchestration 子智能体编排
context: C3 · SubagentOrchestration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 需求文档（PRD）：C3 · SubagentOrchestration（子智能体编排）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 复用的 `C2.AgentRuntimePort` 见 [../c2-agent-runtime/architecture.md](../c2-agent-runtime/architecture.md)；durable lifecycle 事实基线见 CodePilot `docs/handover/same-runtime-multi-model-subagents.md`。

## 0. 语义契约字段表（反假数据前置）

> 涉及用户可见的子 agent 状态 / 进展 / 结果 / 能力支持时，先读本表。每个字段写清语义、真实来源（source breadcrumb）、以及缺失时如何降级。禁止显示假 0 / placeholder / 固定估算。

| 用户可见字段 | 语义（用户看到会怎么理解） | 真实来源 breadcrumb | 缺失 / 未支持时 |
|---|---|---|---|
| `logicalRunId` | 这个用户任务的身份（一个胶囊 / sidebar tab） | `SubagentRunRepository.logical.id`（`subagent_runs.logical_run_id`） | 无 durable row 时不显示胶囊（details API 未 200） |
| `attemptId` | 这一次物理执行的身份（tool use ID） | `SubagentRunRepository.attempt.id`（`subagent_runs` 物理行 id） | 同上；历史渲染不改写为 `hist-N` |
| `phase` | 这个子任务现在处于哪个阶段（running/settling/terminal） | `SubagentRunRepository.attempt.phase`（**落库** `subagent_runs` 状态列） | 无 durable row 视为 unknown；**绝不**用 C2 内存 phase 顶替 |
| `terminalOutcome` | 任务最终结果（completed/partial/failed/cancelled/timed_out） | `attempt.result.outcome`（结构化 result/provenance，非"回合结束"推断） | terminal 前不显示 completed；回合结束 ≠ 成功 |
| `error.code` | 失败归类（我停的 / 超时 / 依赖缺失 / 进程死 / 模型不可用） | `SK.ErrorClassifier` 归一的 `ClassifiedError.code`（保留 structured error） | 无错误时不显示错误；ABORTED 不显示成"出错了" |
| `model` / `provider` | 子 agent 实际用的模型 / Provider（不是父继承猜测） | `attempt.route`（server-verified `provider_id + model`；effective 优先，缺则 verified requested） | 拿不到 effective 时标"Runtime 未报告"，不冒充 |
| `dispatchState` | 是否在排队等上游（queued/running/...） | `attempt.dispatchState`（`subagent_runs.dispatch_state`） | queued 不显示 running；无依赖直接 running |
| 进展 snapshot | 父模型跨回合查询的"最新 attempt 进展" | `SubagentRunRepository.latestAttemptSnapshot`（**仅**读 durable 表） | **禁止**从旧正文 / update_plan / 耗时 / 工作区文件推断 |

## 1. 范围与目标

C3 交付一个**零框架的子智能体编排核心** + 其 NestJS 适配层，覆盖：

1. 接受父会话的 delegate 请求，建立 `LogicalRun` + 首个 `Attempt`（或按显式重试生成递增 attempt）。
2. 校验 route（provider+model）、依赖声明（DAG 边），fail-closed 拒绝非法输入 / 循环 / 缺声明。
3. 复用 `C2.AgentRuntimePort` 发起子 agent AI 调用，消费其 `AgentStreamEvent` 归一成 `SubagentEvent` 落库。
4. 维护 `RunPhase`（`running → settling → terminal`）落库状态机，terminal immutable。
5. 经 `C5.PermissionBrokerPort` 转交子 agent 的权限请求 / 消费决议。
6. 提供 `SubagentRunRepository` 供 UI 读 logical run / attempt / event、供父模型跨回合查进展。
7. 支持 Stop 传播（含 queued 取消）、进程重启时 owner 收口遗留 running。

**明确不做**（见 product-brief 第 7 节）：AI 调用本身、权限经纪判定、会话持久化、Provider 配置、跨 Runtime Broker、通用 workflow engine。

## 2. 功能需求（FR）

### FR-1 LogicalRun / Attempt 两层领域模型

- **FR-1.1** 系统必须区分 `LogicalRun`（一个用户任务的逻辑身份）与 `Attempt`（一次物理执行）；一个 LogicalRun 聚合 1..N 个 Attempt，`attempt` 序号从 1 递增。
- **FR-1.2** `Attempt` 只按**显式** `logical_run_id` 关联到 LogicalRun；系统**不得**按 `task_key` / 名称隐式合并 attempt 到既有 LogicalRun。
- **FR-1.3** UI 胶囊 / sidebar tab 身份使用 `logical_run_id`；同一 retry 链只显示一个胶囊；历史渲染使用真实 `attempt` 的 tool use ID，不改写为 `hist-N`。
- **FR-1.4** 每个 Attempt 记录 server-verified route（`provider_id + model`）、`dispatch_state`、结构化 `result` 与 `provenance`；terminal 后这些字段 immutable。
- **FR-1.5** LogicalRun 携带 `workflow_id` / `task_key` / `dependencies`（DAG 边）用于依赖编排；这些是 LogicalRun 级属性，不用于隐式合并 attempt。

### FR-2 RunPhase 持久状态机（durable）

- **FR-2.1** `RunPhase` 有三个相位：`running`、`settling`、`terminal`；`terminal` 带子态 `outcome`（completed/partial/failed/cancelled/timed_out）。
- **FR-2.2** RunPhase 必须**落库**（`subagent_runs` 状态列 + `dispatch_state`）；这是父页面刷新 / detach、进程重启、跨回合查询的唯一权威事实源。
- **FR-2.3** 合法迁移仅：`running → settling`、`running → terminal`、`settling → terminal`；任意 `terminal → *` 回退、`settling → running` 回退一律非法（应用层拒绝 / 领域方法返回失败）。
- **FR-2.4** `settling` 是**独立相位**（子 agent 停止 / 上游发终止信号后，产物收尾 + 结构化 result/provenance 写入中），不得被压缩进 `running` 或跳过。
- **FR-2.5** `terminal` 后 **immutable**：迟到的事件 / checkpoint 不得覆盖终态（对齐现有"terminal 后迟到 checkpoint 不可覆盖"）。
- **FR-2.6** RunPhase 迁移只能经领域方法（`markSettling` / `complete` / `fail` / `cancel` / `timeout`），外部不得直接赋值状态列。

### FR-3 durable RunPhase 与 C2 内存 StreamPhase 分离

- **FR-3.1** C3 核心**不得** import / 建模 C2 的 `StreamPhase` 做持久判断；消费 `AgentRuntimePort` 的 `AgentStreamEvent`（含 `phase_changed`）时只归一成 `SubagentEvent` 落库。
- **FR-3.2** C3 的 durable `RunPhase` 与 C2 的内存 `StreamPhase` 是两种东西：前者回答"这个子任务处于哪个阶段（落库）"，后者回答"这一次 AI 调用这一刻还在生成吗（内存）"；不得互相顶替。
- **FR-3.3** 页面 detach / renderer fetch 断开只 detach，**不得**触发子 agent Runtime abort；server 侧 collector 继续执行并持久化。
- **FR-3.4** 进程重启后，只有当上一 owner 缺失 / PID 已死时，新 owner 才把遗留 `running`/`settling` 收口为 terminal；schema/migration 初始化本身不执行运行态 recovery。

### FR-4 SubagentEvent 事件模型

- **FR-4.1** `SubagentEvent` 至少含五类：`activity`（状态 / 进展文本）、`tool`（tool_started/tool_completed）、`permission`（权限请求 / 决议镜像）、`partial`（部分产物 checkpoint）、`terminal`（终态 + 结构化 result/provenance）。
- **FR-4.2** `SubagentEvent` 落 `subagent_run_events`（typed lifecycle）；每个事件关联 `attempt_id`。
- **FR-4.3** C3 从 `AgentStreamEvent` 归一成 `SubagentEvent`：text/status → activity、tool_use/tool_result → tool、permission_request/permission_resolved → permission、部分正文 → partial、result/error/终态 → terminal。归一不伪造、不改变已识别语义；未识别事件降级（丢弃 / 保留 raw）不抛。
- **FR-4.4** `partial` checkpoint 有大小上限（对齐现有 64 KiB），running 阶段更新；terminal 后迟到 partial 不覆盖终态（呼应 FR-2.5）。

### FR-5 SpawnSubagentUseCase（发起 / 重试）

- **FR-5.1** `spawn(input)` 校验 route（provider+model 必须是 server-verified 的启用 pair），非法 → `SUBAGENT_MODEL_UNAVAILABLE`，**不启动** Runtime、不占 task_key。
- **FR-5.2** 依赖声明校验：`task_key` 重复、自依赖、间接循环在启动前拒绝（`DEPENDENCY_*`）；未声明依赖却要求 child"等待 / 待命"→ `DEPENDENCY_DECLARATION_REQUIRED`，不创建 placeholder。
- **FR-5.3** 启动前必须先写 durable `subagent_runs.running`；durable row 创建失败则 child **不启动**（fail-closed，避免不可审计任务）。
- **FR-5.4** 显式 retry 复用 `logical_run_id` 生成**递增** attempt；对 active（running/settling）的 logical_run_id 复用 → 冲突拒绝；对 completed（terminal）的 → 拒绝或按显式重试语义（生成新 attempt），二者都不得静默并入。
- **FR-5.5** 有依赖的 child 先被接受为 `queued`（`dispatch_state`），在上游 durable `terminal(completed)` 前**不占** Runtime 并发位、不调用目标 Provider；上游失败 / 缺失 / 结果为空 / ownership 丢失 → 结构化失败。
- **FR-5.6** 上游从未创建 → `DEPENDENCY_NOT_FOUND`（有 5 秒 durable-row 创建宽限，防并行 tool handler 顺序问题）；上游存在但 deadline 前未终止 → `DEPENDENCY_TIMEOUT`；二者都不启动下游 Provider。
- **FR-5.7** 上游结果只在 child 真正执行前编译进 prompt（handoff），并显式标为**不可信** task data；父模型预生成的占位 prompt 不决定最终输入。

### FR-6 复用 C2.AgentRuntimePort 发起 AI 调用

- **FR-6.1** C3 经 `C2.AgentRuntimePort.run(request)` 发起子 agent AI 调用，消费其 `AgentStreamEvent` 流；C2 不感知"这是子 agent"，只当作又一次 `RuntimeRunRequest`。
- **FR-6.2** child 使用独立 session / 独立 AbortController；父 abort 向下传播；depth 固定为 1（child 内递归 spawn 入口被移除）。
- **FR-6.3** Stop / interrupt 经 `AgentRuntimePort.interrupt(turnRef)` 优雅中断，必要时 `forceKillTurn`；C3 据此把 attempt 推 `settling → terminal(cancelled/aborted)`。
- **FR-6.4** child 达到 completed/partial/failed/cancelled/timed_out 才收口 terminal；**回合正常结束 ≠ 任务成功**——terminal outcome 由结构化 result/provenance 决定，不用"任意非错误结束 = completed"兜底。

### FR-7 权限经 C5.PermissionBrokerPort 转交

- **FR-7.1** 子 agent 触发需审批的工具（写入 / Shell 等）时，C3 经 `C5.PermissionBrokerPort` 转交权限请求；C3 **不做** allow/deny 判定、不弹 UI。
- **FR-7.2** 权限请求 / 决议镜像成 `SubagentEvent.permission` 落库；决议由唯一 `permissionRequestId` 定向回传给对应 attempt 的 Runtime 调用。
- **FR-7.3** 普通 profile 的子 agent 沿用父权限包裹（写入 / Shell 仍需父审批，不因换模型绕过）；full access 仅在父会话明确选择时透传。

### FR-8 SubagentRunRepository（持久化 + UI 读取）

- **FR-8.1** 提供按 `logical_run_id` 聚合读取（最新 attempt + 全部 attempts + events）、按 `attempt_id` 读单次执行的接口。
- **FR-8.2** 提供父模型跨回合查询的 `latestAttemptSnapshot`（lifecycle-only：状态 / outcome / 简要 provenance，**不含** prompt/result 全文，避免把 child 内容升格成 system instruction）；另有按需 `listRuns` / 详情展开全部 attempts/events。
- **FR-8.3** UI 胶囊只有 details 读取返回有效 durable evidence 才显示 managed 状态；缺失（404 等价）暂记 missing、transient 记 unknown，不永久轮询幽灵 id。
- **FR-8.4** 所有状态来源固定为 durable 表；Repository 不提供从正文 / update_plan / 耗时 / 工作区推断状态的路径。

## 3. 非功能需求（NFR）

- **NFR-1 六边形纯净**：`packages/core/subagent/` 不 import `@anthropic-ai/*` / `child_process` / `better-sqlite3` / `@nestjs/*` / HTTP 细节；AI 调用经 `AgentRuntimePort`、权限经 `PermissionBrokerPort`、持久化经 `SubagentRunRepository`，全部是接口（`import type`）。
- **NFR-2 durable ≠ 内存**：C3 的 `RunPhase` 落库，是唯一权威事实源；不 import C2 的 `StreamPhase` 做持久判断（对齐 CLAUDE.md stop/abort 高发区纪律，类型层面切断）。
- **NFR-3 依赖倒置**：C3 核心只依赖 `C2.AgentRuntimePort` / `C5.PermissionBrokerPort` / `SK.*` 的接口；实现经 NestJS DI 注入。
- **NFR-4 隔离进程病**：任一 Runtime app-server 僵死 / spawn 失败等锁在 C2 的对应适配器内 fail-fast；C3 只消费归一后的 `ClassifiedError`，把对应 attempt 归 `terminal(failed, PROCESS)`，不卡死 logical run 生命周期。
- **NFR-5 幂等收口**：terminal 收口只允许第一次原子写入；completed/partial/failed/cancelled/timed_out 之间不互相覆盖；迟到事件 no-op。
- **NFR-6 结构化错误**：所有失败经 `SK.ErrorClassifier` 归一并保留 structured error / provenance；错误码在 UI 上可区分（ABORTED / PROCESS / NOT_FOUND / TIMEOUT / UNAVAILABLE 等）。
- **NFR-7 可审计**：malformed input 等未成功创建 durable row 的调用不是 Agent run，不产生胶囊；只有 durable row + 有效 evidence 才是 run。
- **NFR-8 i18n**：所有用户可见文案用 `c3.*` messageKey，经 `SK.TranslationPort` 渲染；错误文案 key 来自 `SK.ErrorClassifier` 的 `messageKey`。
- **NFR-9 日志脱敏**：关键路径经 `SK.RuntimeLog`（source=`c3.spawn` / `c3.dispatch` / `c3.persistence`），敏感字段经 SK 脱敏。

## 4. 验收标准（AC）

> 每条 AC 可写成单测 / smoke。带"反例"的必须验证普通路径与触发路径的差异（对齐 CLAUDE.md 反假数据）。

- **AC-1（迁移矩阵）**：`running→settling`、`running→terminal`、`settling→terminal` 合法；`terminal→running`、`terminal→settling`、`settling→running` 非法被拒。单测覆盖全矩阵。
- **AC-2（terminal immutable，反例）**：attempt 到 `terminal(completed)` 后，注入迟到 `partial` / 迟到 error 事件，断言终态与 result 不被覆盖（对比 running 阶段同类事件会更新 partial）。
- **AC-3（settling 独立，反例）**：Stop 一个 running attempt，断言经过 `settling` 相位（观察到 settling 落库）再到 `terminal(cancelled)`，而非直接 running→terminal 跳过 settling。
- **AC-4（显式 logical_run_id 关联，反例）**：给出显式 `logical_run_id` 的重试并入既有 LogicalRun 生成 attempt=2；**不给** logical_run_id 但同名 `task_key` 的新请求生成**新** LogicalRun（不隐式合并）。
- **AC-5（ID 误复用拒绝，反例）**：对 active（running）logical_run_id 的复用请求 → 冲突错误；对 completed logical_run_id 的静默并入 → 拒绝（走显式重试才生成新 attempt）。
- **AC-6（durable vs 内存分离）**：静态扫描 `packages/core/subagent/` 无 import C2 `StreamPhase`；消费 `AgentStreamEvent.phase_changed` 只落 `SubagentEvent`，断言 durable `RunPhase` 不等于 C2 内存 phase 快照。
- **AC-7（detach 不 abort，反例）**：模拟 renderer fetch 断开，断言 collector 继续、durable row 继续推进、Runtime **未** abort（对比显式 Stop 才 abort）。
- **AC-8（进程重启收口）**：遗留 `running` row 且上一 owner PID 已死 → 新 owner 收口为 `terminal`；schema/migration 重复 init **不**把活任务标记 recovery（对比 owner 存活时不收口）。
- **AC-9（route 校验 fail-closed，反例）**：未启用 provider+model → `SUBAGENT_MODEL_UNAVAILABLE`，断言**未**写 durable running、**未**调用 `AgentRuntimePort.run`（对比合法 route 正常启动）。
- **AC-10（依赖编排，反例）**：`research → copy → implementation` 三 task 同 workflow，后两个先 `queued`、上游 `terminal(completed)` 前不调 Provider；再跑 A→B→A 循环 + 上游失败反例，断言下游 Provider 前结构化失败（`DEPENDENCY_*`）。
- **AC-11（依赖缺失 / 超时归类，反例）**：上游从未创建 → `DEPENDENCY_NOT_FOUND`（5 秒宽限后）；上游存在但 deadline 未终止 → `DEPENDENCY_TIMEOUT`；二者 `error.code` 不同且都不启动下游。
- **AC-12（回合结束≠成功，反例）**：`AgentRuntimePort.run` 流正常结束但结构化 result 标 failed / 无 completed marker → attempt 归 `terminal(failed)`，断言**不**因"非错误结束"兜底成 completed。
- **AC-13（权限转交）**：子 agent 触发写入工具 → 经 `PermissionBrokerPort` 转交，镜像成 `SubagentEvent.permission`；C3 核心无 allow/deny 判定逻辑（假 broker spy 断言只转交）。
- **AC-14（queued Stop 取消）**：queued（等上游）的 child 被父 Stop → 进 `terminal(cancelled)`，不等依赖 deadline（组合 AbortSignal / dispatch_state）。
- **AC-15（跨回合事实源，反例）**：父模型查进展 → `latestAttemptSnapshot` 只读 durable 表返回 lifecycle-only；断言 Repository 无从正文 / update_plan / 耗时推断状态的路径。
- **AC-16（幂等收口）**：并发触发两次 terminal 收口，断言只第一次生效、outcome 不被第二次覆盖（NFR-5）。
- **AC-17（边界纯净）**：`packages/core/subagent/` 禁用 import 扫描——`@anthropic-ai/*` / `child_process` / `better-sqlite3` / `@nestjs/*` 0 命中；AI 调用 / 权限 / 持久化全经端口接口。
- **AC-18（无假数据）**：Runtime 未上报 effective model → attempt.route 保留 verified requested 并标"未报告"，断言 UI 不冒充；无 durable evidence → 不显示胶囊（不显示假 running）。

## 5. Story → AC 追溯

详见 [epics-stories.md](./epics-stories.md) 的追溯矩阵；每个 FR 至少一条 Story，每条 Story 映射到上述 AC。
