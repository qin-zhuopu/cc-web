---
title: 产品简报 — C3 SubagentOrchestration 子智能体编排
context: C3 · SubagentOrchestration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C3 · SubagentOrchestration（子智能体编排）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 复用的 AI 调用能力见 [../c2-agent-runtime/architecture.md](../c2-agent-runtime/architecture.md)（`AgentRuntimePort`）；依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 一句话定位

C3 是 CodePilot Web 里**持有"子智能体（sub-agent）一次任务的持久生命周期"**的限界上下文。它负责：接受父会话的一次 delegate 请求 → 建立一条**逻辑运行（LogicalRun）**并生成其下的**尝试（Attempt）**→ 复用 `C2.AgentRuntimePort` 发起子 agent 的 AI 调用 → 把子 agent 的活动、工具、权限、部分产物、终态归一成 `SubagentEvent` 并**落库持久化** → 维护这次运行的**持久相位状态机（RunPhase：`running → settling → terminal`）**。它**自己不做 AI 调用本身**（复用 C2 的 `AgentRuntimePort`），也**不做权限 UI/经纪判定**（复用 C5 的 `PermissionBrokerPort`）。

## 2. 解决什么问题

C3 对应现有 Electron 版 CodePilot 的 **subagent 编排层**——`src/lib/subagent-orchestration.ts`、`subagent-models.ts`、`subagent-view.ts`，以及三条 Runtime 的 spawn 适配（`tools/agent.ts` / `claude-subagent-mcp.ts` / `codex/subagent.ts`）与 `subagent_runs` / `subagent_run_events` 两张表。现有实现的核心痛点是：**"一个用户任务"与"一次物理执行"没有被固化成两个清晰的领域概念，durable lifecycle 与内存流式态语义混淆，导致重试聚合、跨回合进展查询、Stop 传播反复出错。**

- **逻辑运行 vs 物理尝试的边界模糊**：同一个用户任务可能重试多次，每次是一次独立的物理执行（不同 OS 子进程 / thread / in-process loop）。现有 `subagent_runs` 用 `logical_run_id` 聚合 attempt，但聚合规则散落——一旦按名称隐式合并、或复用了 active/completed 的 ID，就会把两个无关任务错误地并到一条链上，UI 只显示一个胶囊却混着两次执行的产物。
- **durable 相位与内存流式相位混用**：子 agent 的 `running → settling → terminal` 必须**落库**——因为父页面可能刷新 / detach、进程可能重启、跨回合要查"上游任务完成了没"。这跟 C2 的 `StreamPhase`（内存态、回答"这一刻还在生成吗"）是**两种东西**。现有代码里两者边界不清，导致"页面切走 → Runtime 被误 abort"或"terminal 后迟到 checkpoint 覆盖终态"这类 bug。
- **settling 相位被省略**：子 agent 停止 / 上游发终止信号后，产物收尾、结构化 result/provenance 写入需要一个独立的**收尾中**相位。现有实现里 settling 常被压缩进 running 或直接跳到 terminal，导致"回合结束"被误当成"任务成功"（Codex `turn.status=completed` ≠ 任务 completed）。
- **结构化失败被当空成功**：上游失败 / 缺失 / 结果为空 / route 不可用时，若不 fail-closed 成结构化错误，就会启动下游 Provider 或把失败 child 冒领成父产物。需要一套稳定的错误码（复用 `SK.ErrorClassifier`）把 `DEPENDENCY_NOT_FOUND` / `SUBAGENT_MODEL_UNAVAILABLE` / `PROCESS_DIED` 等在语义上区分。
- **跨回合进展查询无稳定事实源**：父模型问"进展怎么样"时，必须从 `subagent_runs` 的最新 attempt 读事实，不能从旧正文、`update_plan`、耗时或工作区文件推断。这要求 durable 表是唯一权威事实源。

C3 把"子智能体一次任务的持久生命周期"抽成一个零框架核心：**LogicalRun 聚合根**（一个用户任务，聚合多次 Attempt）+ **Attempt 实体**（一次物理执行，只按显式 `logical_run_id` 关联）+ **RunPhase 持久状态机**（`running → settling → terminal`，落库，只能经领域方法迁移）+ **SubagentEvent**（activity / tool / permission / partial / terminal 五类，落 `subagent_run_events`）。目标是让"重试聚合、跨回合进展、Stop 传播、结构化失败"靠领域不变量与持久事实源保证，而非靠散落的分支纪律。

## 3. 目标用户与价值

- **单机开发者用户**：在聊天里让主 Agent delegate 一个子任务（例如"用 DeepSeek 先研究，再让 Kimi 实现"），子 agent 以独立 `SubagentCard` 展示 running / settling / terminal 真实状态；页面刷新 / 切走再回来任务继续；点 Stop 只取消对应链、父会话不残留；重试同一任务只显示一个胶囊（logical 身份），详情里能展开多次 attempt。
- **接入 C3 的其他上下文**：
  - **C2 AgentRuntime**（被 C3 复用）：C3 经 `C2.AgentRuntimePort` 发起子 agent 的 AI 调用（run / interrupt / forceKillTurn / availability），C2 不感知"这是一个子 agent"——它只当作又一次 `RuntimeRunRequest`。
  - **C5 Bridge**（被 C3 复用）：子 agent 触发写入 / Shell 等需审批的工具时，C3 经 `C5.PermissionBrokerPort` 把权限请求交给经纪，不自己弹 UI、不自己判定。
  - **调用 C3 的上游**：父会话侧（三条 Runtime 的 spawn 入口）经 C3 的 `SpawnSubagentUseCase` 发起 delegate；UI 侧经 `SubagentRunRepository` 读 logical run / attempt / event 渲染卡片与详情面板。

价值主张：**把"子智能体一次任务的持久生命周期"从散落的 durable 字段与内存流式态里固化成 LogicalRun/Attempt 两层领域模型 + 落库的 RunPhase 状态机，让重试聚合、跨回合进展、Stop 传播、结构化失败靠不变量与唯一持久事实源保证，而不是靠每条 spawn 分支的人工纪律。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C3 契约：

- **拥有**：
  - `LogicalRun` 聚合根（一个用户任务的逻辑身份，聚合其下多次 Attempt；`logical_run_id` 是 UI 胶囊 / sidebar tab 的身份）
  - `Attempt` 实体（一次物理执行，含 `attempt` 序号、dispatch_state、structured result/provenance；只按显式 `logical_run_id` 关联，缺省不按名称合并）
  - `RunPhase` 持久状态机（`running → settling → terminal`，**落库**，区别于 C2 内存 phase；settling 是独立相位）
  - `SubagentEvent`（子 agent typed lifecycle：activity / tool / permission / partial / terminal，落 `subagent_run_events`）
- **不包含**：
  - **AI 调用本身** —— 属 C2。C3 复用 `C2.AgentRuntimePort` 发起子 agent 的 run / interrupt，不重新实现 SDK / HTTP / app-server 调用。
  - **权限 UI / 经纪判定** —— 属 C5。C3 经 `C5.PermissionBrokerPort` 转交权限请求 / 消费决议，不自己判定 allow/deny、不弹 UI。
  - **会话 / 消息持久化** —— 属 C1（子 agent 的 child session 由 C2/C1 侧处理，C3 只持有 subagent run 的 durable 表）。
  - **Provider 配置 / 诊断** —— 属 C7（route 校验所需的 provider+model catalog 由 C7 / C2 侧提供，C3 只消费校验结果）。
- **依赖端口（只引用，不重写）**：
  - `C2.AgentRuntimePort` —— 发起子 agent AI 调用（run / interrupt / forceKillTurn / availability）；只 `import type`。
  - `C5.PermissionBrokerPort` —— 转交子 agent 的权限请求 / 消费决议；只 `import type`。
  - `SK.IdGenerator` / `SK.Clock` —— 生成 `logical_run_id` / `attempt_id`、时间戳。
  - `SK.ErrorClassifier` —— 把子 agent 失败归一成结构化错误（含 `ABORTED` / `PROCESS` / `NOT_FOUND` 等）。
  - `SK.RuntimeLog` / `SK.TranslationPort`（横切）。
- **对外提供端口**：
  - `SpawnSubagentUseCase`（发起 / 重试一次子 agent delegate，管理 logical run + attempt 生命周期）。
  - `SubagentRunRepository`（出站持久化 + UI 读取 logical run / attempt / event 的入口）。

## 5. 与 CodePilot 现有实现的对应

| C3 概念 | 现有落点 |
|---|---|
| `LogicalRun` 聚合根 | `subagent_runs.logical_run_id`——现为聚合列，C3 固化为聚合根身份（UI 胶囊 / sidebar tab 用它） |
| `Attempt` 实体 + attempt 序号 | `subagent_runs` 的物理行 + `attempt` 递增序号——现为行 + 列，C3 固化为实体（一次物理执行 = tool use ID = physical attempt identity） |
| `RunPhase` 持久状态机（running→settling→terminal） | `subagent_runs.dispatch_state` / 状态列的 `running`/`settling`/`completed`/`failed`/`partial`/`cancelled`/`timed_out`——现为散落状态列，C3 固化为落库状态机不变量 |
| `SubagentEvent`（5 类） | `subagent_run_events` 的 typed lifecycle 行（Codex 还用作跨回合事实源）——C3 归一成事件联合 |
| `SpawnSubagentUseCase` | `subagent-orchestration.ts` 的 validator / resolver / prompt compiler + 三 Runtime 的 spawn 入口（`tools/agent.ts` / `claude-subagent-mcp.ts` / `codex/subagent.ts`）——C3 收敛成一个用例（唯一依赖语义层） |
| `SubagentRunRepository` | `subagent-run-persistence` + details API（`agent-run:<toolUseId>` tab / `SubagentCard` 的 200 才显示 durable evidence）——C3 固化为出站端口 |
| 结构化失败码 | `DEPENDENCY_NOT_FOUND` / `DEPENDENCY_TIMEOUT` / `SUBAGENT_MODEL_UNAVAILABLE` / `DEPENDENCY_DECLARATION_REQUIRED` 等——C3 经 `SK.ErrorClassifier` 归一并保留 structured error |

> **语义澄清（防"持久 vs 实时"混用，对齐 CLAUDE.md 与 C2 的 phase 分离纪律）**：C2 的 `StreamPhase`（`active → settling → terminal`）是**实时内存相位**，回答"子 agent 这一次 AI 调用现在还在生成吗"，随进程消失。C3 的 `RunPhase`（`running → settling → terminal`）是**持久任务相位**，回答"这个子任务作为一个用户可见的工作，现在处于哪个阶段"，**落 `subagent_runs`**——因为父页面刷新 / detach、进程重启、跨回合查询都要读它。二者**不可混用**：C3 的 RunPhase 是 durable 事实源，C2 的 StreamPhase 是瞬时相位；C3 消费 `AgentRuntimePort` 拿到的 `AgentStreamEvent`（含 C2 内存 phase 变化）时，只把它归一成 `SubagentEvent` 落库，**绝不把 C2 内存 phase 当 durable RunPhase 存**。把两者混用正是"页面切走被误 abort""terminal 后被迟到 checkpoint 覆盖"类 bug 的根因。

## 6. 成功标准（可度量）

- **S1 逻辑运行 / 物理尝试两层清晰**：`LogicalRun`（一个用户任务）与 `Attempt`（一次物理执行）是两个领域概念；同一 logical run 的多次 attempt 有单测覆盖聚合规则；UI 胶囊 / sidebar tab 用 logical 身份，历史渲染不改写 attempt 的 tool use ID。
- **S2 attempt 只按显式 logical_run_id 关联**：新 attempt 只在给出显式 `logical_run_id` 时并入既有 logical run；**缺省不按名称 / task_key 隐式合并**；对 active（running/settling）或 completed（terminal）的 logical_run_id 复用请求，应用层**拒绝**（active reuse → 冲突错误、completed reuse → 拒绝或按显式重试语义生成新 attempt）。有正例 + 反例 smoke。
- **S3 RunPhase 是落库不变量而非散字段**：`running → settling → terminal` 只能经领域方法迁移；非法迁移（如 `terminal → running` 回退、越过 settling 直跳）被拒绝；**terminal 后 immutable**，迟到事件不覆盖终态；settling 是独立相位（不被压缩进 running）。有单测覆盖合法 / 非法迁移全矩阵。
- **S4 durable 相位与 C2 内存 phase 严格分离**：C3 核心不 import、不建模 C2 的 `StreamPhase` 做持久判断；消费 `AgentStreamEvent` 时只归一成 `SubagentEvent` 落库；页面 detach 只 detach 不触发 abort，进程重启时 owner 才收口遗留 running。有静态扫描 + 反例 smoke。
- **S5 结构化失败可分且 fail-closed**：上游缺失 → `DEPENDENCY_NOT_FOUND`、上游超时 → `DEPENDENCY_TIMEOUT`、route 不可用 → `SUBAGENT_MODEL_UNAVAILABLE`、进程僵死 → `PROCESS`(process_died)、用户 Stop → `ABORTED`——归类不同，经 `SK.ErrorClassifier` 保留 structured error；失败不启动下游 Provider、不冒领父产物。有反例 smoke。
- **S6 边界纯净**：C3 核心包不 import `@anthropic-ai/*` / `child_process` / `codex` / `better-sqlite3` / `@nestjs/*`；不重新实现 AI 调用（复用 `AgentRuntimePort`）、不做权限经纪（复用 `PermissionBrokerPort`）；durable 表访问经 `SubagentRunRepository` 出站端口。

## 7. 非目标（明确排除）

- 不实现 AI 调用本身（run / interrupt / SDK / HTTP / app-server 全复用 `C2.AgentRuntimePort`）。
- 不做权限经纪判定 / 权限 UI（复用 `C5.PermissionBrokerPort`；C3 只转交请求 / 消费决议）。
- 不持久化会话 / 消息本体（属 C1；C3 只持有 subagent run 的 durable 表）。
- 不管理 Provider 配置 / 诊断（属 C7；C3 只消费 route 校验结果）。
- 不做跨 Runtime Delegation Broker、background / scheduled child、单独"取消某一个 child"按钮（本版 Stop 由父回合传播，见现有交接文档"已知后续"）。
- 不做条件分支 / 循环 / 人工审批节点 / 工作流级 resume-checkpoint 的通用 workflow engine（当前只支持声明式 DAG 依赖边，见现有交接文档）。
- 不替 SK 重实现 IdGenerator / Clock / ErrorClassifier。

## 8. 关键风险与假设

- **假设**：C2 已交付 `AgentRuntimePort`（run / interrupt / forceKillTurn / availability 签名见 C2 architecture 5.1）；C5 已交付 `PermissionBrokerPort`；SK 已交付 IdGenerator / Clock / ErrorClassifier。C3 只 `import type` 这些端口，实现经 NestJS DI 注入。
- **风险（durable phase 泄漏成内存态，或反之）**：若把 C2 内存 `StreamPhase` 当 C3 durable `RunPhase` 存、或把 durable RunPhase 当实时判断读，会重现"页面切走误 abort""terminal 被迟到 checkpoint 覆盖"。C3 的 RunPhase 落库、terminal immutable；消费 `AgentStreamEvent` 只归一成 `SubagentEvent`，不透传 C2 phase 进 durable 表。
- **风险（logical_run_id 误复用 / 隐式合并）**：若按名称 / task_key 隐式合并 attempt、或复用 active/completed 的 logical_run_id，会把两个无关任务并到一条链。C3 在应用层 fail-closed 拒绝：只按显式 `logical_run_id` 关联，active reuse 报冲突、completed reuse 拒绝或走显式重试。
- **风险（回合结束 ≠ 任务成功）**：`AgentRuntimePort` 的 run 流正常结束不等于子任务 completed（Codex `turn.status=completed` 同理）。C3 的 terminal 子态由结构化 result/provenance 决定（completed/partial/failed/cancelled/timed_out），不用"任意非错误结束 = completed"兜底。
- **风险（进程僵死不属 C3 但需 fail-closed 消费）**：Codex app-server 僵死 / spawn 失败等进程病锁在 C2 的 `CodexRuntimeAdapter` 内并 fail-fast 归一成 `ClassifiedError`；C3 消费这个错误把对应 attempt 归 `terminal(failed, PROCESS)`，不卡死 logical run 生命周期。
- **风险（Stop 传播 / queued 取消）**：父回合 Stop 需向 child 传播；queued（等待上游 durable terminal）的 child 也要能被 Stop 取消，而非等依赖 deadline。C3 用组合 AbortSignal / dispatch_state 保证 queued Stop 也进 `terminal(cancelled)`。
