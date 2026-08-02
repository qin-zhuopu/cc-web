---
title: 史诗与故事 — C3 SubagentOrchestration 子智能体编排
context: C3 · SubagentOrchestration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C3 · SubagentOrchestration（子智能体编排）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。
> 复用的 `C2.AgentRuntimePort` 见 [../c2-agent-runtime/architecture.md](../c2-agent-runtime/architecture.md)；durable lifecycle 事实基线见 CodePilot `docs/handover/same-runtime-multi-model-subagents.md`。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C3 核心包（domain + ports），零框架、切断 C2 `StreamPhase` import | FR-1~8 的类型基础、NFR-1/2/3 |
| E2 RunPhase durable 状态机 + 两层模型 | LogicalRun/Attempt 两层 + RunPhase 落库迁移 + terminal immutable | FR-1、FR-2、FR-3 |
| E3 SubagentEvent 事件模型 + 归一 | 五类 typed lifecycle 事件 + AgentStreamEvent 归一 + phase_changed 不落 durable | FR-4、FR-3.1 |
| E4 SpawnSubagentUseCase 发起/重试 | route 校验 fail-closed + 显式关联 + 先写 durable running | FR-5.1~5.4、FR-1.2 |
| E5 依赖编排 DispatchCoordinator | DAG 校验 + queued 不占位 + 上游 terminal 门控 + handoff | FR-5.2/5.5/5.6/5.7 |
| E6 复用 C2 Runtime + 中断 + 收口 + recovery | AgentRuntimePort.run 消费 + Stop 传播 + 幂等收口 + 进程重启收口 + detach≠abort | FR-6、FR-2.5、FR-3.3/3.4、NFR-5 |
| E7 权限中转 + Query + 持久化适配器 + 接线 | C5 转交 + latestAttemptSnapshot + Sqlite Repository + NestJS Module | FR-7、FR-8、DI |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `RunPhaseKind`（`running`/`settling`/`terminal`）与 `TerminalOutcome`（completed/partial/failed/cancelled/timed_out）+ `TerminalOutcomeValue`（带 `ClassifiedError | null`）。**AC**：三相位 + 五终态子态类型完整；completed 的 classified 为 null。（FR-2.1）
- **S1.2** 定义 `canTransitionRunPhase` 合法迁移谓词（纯函数）。**AC-1**：`running→settling`/`running→terminal`/`settling→terminal` 合法，`terminal→*`/`settling→running` 非法。（FR-2.3）
- **S1.3** 定义 `LogicalRunId`/`AttemptId` 值对象 + `DispatchState`（queued/dispatched/running/settled）+ `RunResult`（结构化 result/provenance/effectiveModel）。**AC**：AttemptId ≡ tool use ID；RunResult 只存 provenance/summary 非全文。（FR-1.1/1.4 / 0 反假数据）
- **S1.4** 定义 `SubagentRoute` 值对象（server-verified providerId + model + 可选 effectiveModel）+ `RouteVerification`（verified/unavailable）。**AC-18**：无 effectiveModel 时保留 verified requested、标"未报告"，不冒充。（FR-5.1 / 0 反假数据）
- **S1.5** 定义 `DependencyEdge`（workflowId/taskKey/dependsOn）+ `DependencyGraph` 校验函数签名。**AC**：DependencyEdge 是 LogicalRun 级属性，不用于隐式合并 attempt。（FR-1.5）
- **S1.6** 定义 `SubagentEvent` 联合（activity/tool/permission/partial/terminal）+ `event-mapping` 契约签名。**AC**：五类事件结构完整，每个关联 attemptId。（FR-4.1）
- **S1.7** 定义驱动端口（`SpawnSubagentUseCase`/`RetrySubagentUseCase`/`InterruptSubagentUseCase`/`QuerySubagentRunsUseCase`）与出站端口（`SubagentRunRepository`）+ `import type` 引用 `C2.AgentRuntimePort` / `C5.PermissionBrokerPort`。**AC**：`index.ts` 只导出端口与领域类型。（FR-5/6/7/8）
- **S1.8** 建立禁用 import 静态扫描。**AC-17**：`packages/core/subagent/` 对 `@anthropic-ai/*`/`child_process`/`better-sqlite3`/`@nestjs/*` 0 命中；额外断言无 import C2 `StreamPhase`。（NFR-1 / NFR-2）
- **S1.9** 定义 C3 message-keys（`c3.*`，状态/错误/依赖/权限提示）。**AC**：用户可见文案经 key + `SK.TranslationPort`，错误文案 key 来自 `SK.ErrorClassifier.messageKey`。（NFR-8）

## E2 · RunPhase durable 状态机 + LogicalRun/Attempt 两层模型（领域不变量核心）

- **S2.1** 实现 `LogicalRun` 聚合根 + `snapshot()`/`latestAttempt()`/`appendAttempt()`/`hasActiveAttempt()`。**AC**：一个 LogicalRun 聚合 1..N Attempt，attempt 序号从 1 递增。（FR-1.1）
- **S2.2** 实现**显式关联**：`appendAttempt` 只按显式 `logicalRunId` 关联，聚合根内无按 task_key/名称的隐式合并路径。**AC-4**：给 logicalRunId → attempt=2 并入；不给但同 task_key → 应由用例层生成新 LogicalRun（聚合根不合并）。（FR-1.2）
- **S2.3** 实现 `Attempt` 实体 + `snapshot()`；phase 只能经领域方法迁移，外部不得直接赋值状态列。**AC-1**：非法迁移抛 `InvalidRunPhaseTransition`。（FR-2.6）
- **S2.4** 实现 `markDispatched`/`markRunning`/`markSettling` dispatch+phase 推进方法，各自内部 `canTransitionRunPhase` 校验。**AC-3**：`markSettling` 落 settling 相位，settling 不被跳过（独立相位）。（FR-2.4）
- **S2.5** 实现 `complete(result)` / `settleNonSuccess(outcome, error, result?)` 终态收口方法，**幂等**：已 terminal 时 no-op。**AC-16**：并发两次收口仅第一次生效、outcome 不被第二次覆盖。（FR-2.5 / NFR-5）
- **S2.6** 实现 **terminal immutable 不变量**：`checkpointPartial(text)` 在 terminal 后 no-op（running 阶段更新，≤64 KiB）。**AC-2**（反例）：terminal(completed) 后注入迟到 partial/迟到 error，断言终态与 result 不被覆盖（对比 running 阶段 partial 会更新）。（FR-2.5 / FR-4.4）
- **S2.7** 实现 `hasActiveAttempt()` 支撑 ID 误复用判定：active（running/settling）reuse → 冲突。**AC-5**（反例）：active reuse → 冲突拒绝；completed 静默并入 → 拒绝（走显式重试才生成新 attempt）。（FR-5.4）

## E3 · SubagentEvent 事件模型 + AgentStreamEvent 归一

- **S3.1** 落地五类 `SubagentEvent`（activity/tool/permission/partial/terminal）+ 值对象编解码。**AC**：每个事件关联 `attempt_id`，落 `subagent_run_events` typed lifecycle。（FR-4.1/4.2）
- **S3.2** 实现 `mapStreamEvent(event, attemptId)` 归一：text/status→activity、tool_use/tool_result→tool、permission_request/resolved→permission、累积正文→partial、result/error/终态→terminal。**AC**：归一不伪造、不改变已识别语义；未识别事件降级（丢弃/保留 raw）不抛。（FR-4.3）
- **S3.3** 实现 `phase_changed`（C2 内存 phase）归一规则：**不落 durable RunPhase**，至多映射成 activity 或丢弃。**AC-6**（反例）：假 `AgentRuntimePort` 发 `phase_changed` 内存 phase 序列，断言 durable `RunPhase` 只由领域方法迁移、不等于内存 phase 快照；静态扫描核心无 import C2 `StreamPhase`。（FR-3.1/3.2）
- **S3.4** 实现 `partial` checkpoint 大小上限（64 KiB）归一。**AC-2**：running 阶段更新，terminal 后迟到 partial 不覆盖终态（呼应 S2.6）。（FR-4.4）

## E4 · SpawnSubagentUseCase 发起/重试

- **S4.1** 实现 `SpawnSubagentService.spawn` 主编排骨架：`attemptId←IdGenerator.next()`、`startedAt←Clock.now()`。**AC**：id/时间经 SK 注入，核心无 Date/uuid 直调。（FR-5 / NFR-1）
- **S4.2** 实现 route 校验 fail-closed：provider+model 必须 server-verified 启用 pair，非法 → `SUBAGENT_MODEL_UNAVAILABLE`，**不写 durable running、不调 `AgentRuntimePort.run`**。**AC-9**（反例）：未启用 pair → spy 断言 `createRunning`/`AgentRuntimePort.run` 未被调（对比合法 route 正常启动）。（FR-5.1）
- **S4.3** 实现 LogicalRun 解析/创建：给 `logicalRunId` 且 active → 冲突拒绝；completed → 拒绝或显式重试；缺省 → 新 LogicalRun。**AC-4/AC-5**：显式关联生成 attempt=2；同名 task_key 无 logicalRunId → 新 LogicalRun；误复用拒绝。（FR-1.2 / FR-5.4）
- **S4.4** 实现**先写 durable running**：校验通过后 `Repository.createRunning`；写失败 → child **不启动**（fail-closed，避免不可审计任务）。**AC**：createRunning 失败时 `AgentRuntimePort.run` 未被调。（FR-5.3 / NFR-7）
- **S4.5** 实现 `RetrySubagentService.retry`：显式复用 `logical_run_id` 生成递增 attempt，active reuse → 冲突。**AC-5**：completed logicalRunId retry → 生成新 attempt，不静默并入。（FR-5.4）
- **S4.6** 实现无依赖直接 dispatch 分支：无 `dependsOn` → 直接进 E6 dispatch。**AC**：无依赖 attempt 直接 running 不经 queued。（FR-5.5 对照面）

## E5 · 依赖编排 DispatchCoordinator

- **S5.1** 实现 `validateDependencyGraph`：task_key 重复、自依赖、间接循环启动前拒绝（`DEPENDENCY_*`）；未声明依赖却要求 child 待命 → `DEPENDENCY_DECLARATION_REQUIRED`，不创建 placeholder。**AC-10**（反例）：A→B→A 循环 → 结构化失败，下游 Provider 前拒绝。（FR-5.2）
- **S5.2** 实现有依赖 attempt 置 `dispatch_state=queued`：在上游 durable `terminal(completed)` 前**不占** Runtime 并发位、不调目标 Provider。**AC-10**（反例）：`research→copy→implementation` 三 task 同 workflow，后两个先 queued、上游 terminal 前不调 Provider。（FR-5.5）
- **S5.3** 实现上游门控与依赖缺失/超时归类：上游从未创建 → `DEPENDENCY_NOT_FOUND`（5 秒 durable-row 创建宽限）；上游存在但 deadline 前未终止 → `DEPENDENCY_TIMEOUT`；上游失败/空结果/ownership 丢失 → 结构化失败。**AC-11**（反例）：从未创建 → NOT_FOUND（5s 宽限后）；存在未终止 → TIMEOUT；`error.code` 不同且都不启动下游 Provider。（FR-5.6）
- **S5.4** 实现 `handoff`：上游 `terminal(completed)` 后把上游**真实**结果编译进 prompt，显式标为**不可信** task data；`markDispatched` 转 E6。**AC**：上游结果只在 child 真正执行前编译进 prompt，父模型预生成占位 prompt 不决定最终输入。（FR-5.7）

## E6 · 复用 C2 Runtime + 中断 + 终态收口 + 进程重启 recovery

- **S6.1** 实现 dispatch + 事件消费（`SubagentEventCollector`）：`markRunning`；构造 `RuntimeRunRequest`（独立 child session、独立 AbortController、depth=1）；订阅 `AgentRuntimePort.run` 归一事件流 → 每 `AgentStreamEvent` 经 `mapStreamEvent` → `SubagentEvent` → `Repository.appendEvent` + 更新内存 Attempt。**AC**：C2 不感知子 agent，视作又一次 `RuntimeRunRequest`；depth 固定为 1（递归 spawn 入口移除）。（FR-6.1/6.2）
- **S6.2** 实现终态收口（`TerminalReconciler`）：**结构化 result 决定 outcome**——completed marker+正文→complete；无 marker/明确失败→settleNonSuccess(failed)；maxTurns→partial；idle/hard cap→timed_out；error→按 `SK.ErrorClassifier` 归因；Stop→cancelled。收口经 `Repository.settleTerminalOnce`（原子，仅第一次生效）。**AC-12**（反例）：run 流正常结束但 result 标 failed/无 marker → `terminal(failed)`，断言**不**因"非错误结束"兜底成 completed。（FR-6.4 / NFR-5）
- **S6.3** 实现 `InterruptSubagentService.interrupt` Stop 传播：running → `markSettling` → `AgentRuntimePort.interrupt(turnRef)`，必要时 `forceKillTurn` → `settleNonSuccess(cancelled, ABORTED)`。**AC-3**（反例）：Stop running attempt 断言经过 settling 落库再到 `terminal(cancelled)`，非跳过 settling。（FR-6.3）
- **S6.4** 实现 queued Stop 取消：queued（等上游）child 被父 Stop → 组合 AbortSignal 命中 → 直接 `terminal(cancelled)`，**不等**依赖 deadline。**AC-14**：queued child 被 Stop → terminal(cancelled) 不等 deadline（组合 AbortSignal / dispatch_state）。（FR-6.3 / FR-5.5）
- **S6.5** 实现 detach ≠ abort：renderer fetch 断开/页面切走只 detach，server 侧 Collector 继续消费+持久化，**不**触发 `AgentRuntimePort.interrupt`。**AC-7**（反例）：模拟 fetch 断开，spy 断言 Collector 继续、durable row 继续推进、`interrupt` 未被调（对比显式 Stop 才 abort）。（FR-3.3）
- **S6.6** 实现进程重启 recovery（`TerminalReconciler.recover`）：经 `Repository.listStaleActiveRuns` 拿遗留 running/settling；**仅当**上一 owner 缺失/PID 已死才收口为 `terminal(failed, PROCESS process_restarted)`；owner 存活→不动；**schema/migration 初始化本身不执行运行态 recovery**。**AC-8**：遗留 running + owner PID 已死 → 收口 terminal；schema init 重复 → 不 recovery（对比 owner 存活不收口）。（FR-3.4）
- **S6.7** 实现进程病隔离消费：任一 Runtime app-server 僵死/spawn 失败等锁在 C2 对应适配器内 fail-fast，C3 只消费归一后的 `ClassifiedError`，把对应 attempt 归 `terminal(failed, PROCESS)`，不卡死 logical run 生命周期。**AC**：进程病态归 terminal(failed, PROCESS)，logical run 不悬挂。（NFR-4）

## E7 · 权限中转 + Query + 持久化适配器 + 接线

- **S7.1** 实现权限中转（FR-7）：Collector 遇 `permission` 类归一事件 → 经 `C5.PermissionBrokerPort` 转交 + 镜像成 `SubagentEvent.permission` 落库；决议由唯一 `permissionRequestId` 定向回对应 attempt 的 Runtime 调用。**AC-13**：假 broker spy 断言只转交、C3 核心无 allow/deny 判定逻辑。（FR-7.1/7.2）
- **S7.2** 实现权限包裹继承：普通 profile 子 agent 沿用父权限包裹（写入/Shell 仍需父审批，不因换模型绕过）；full access 仅在父会话明确选择时透传。**AC**：换模型不绕过父审批。（FR-7.3）
- **S7.3** 实现 `QuerySubagentRunsService.latestAttemptSnapshot`：**仅**读 durable 表返回 lifecycle-only snapshot（状态/outcome/简要 provenance，**不含** prompt/result 全文）。**AC-15**（反例）：断言 Repository 无从正文/update_plan/耗时/工作区推断状态的路径。（FR-8.2/8.4）
- **S7.4** 实现 `getLogicalRun` / `listRunsBySession`：logical 聚合读取（最新 attempt + 全部 attempts + events）；UI 胶囊只有 details 返回有效 durable evidence 才显示 managed；缺失（404 等价）暂记 missing、transient 记 unknown，不永久轮询幽灵 id。**AC-18**（反例）：无 durable evidence → 不显示胶囊（不显示假 running）。（FR-8.1/8.3）
- **S7.5** 实现 `SqliteSubagentRunRepository`（`apps/api` 适配器）：落 `subagent_runs`（logical_run_id/attempt/route/dispatch_state/状态列/dependencies_json/structured result/provenance/parent FK）与 `subagent_run_events`（typed lifecycle）。**AC**：`settleTerminalOnce` 用 `UPDATE ... WHERE phase != 'terminal'` 保证仅第一次生效；`checkpointPartial` 截断 64 KiB + `WHERE phase='running'`。（FR-8 / NFR-5）
- **S7.6** 接线 `SubagentModule`（NestJS）：imports SharedKernelModule + AgentRuntimeModule（注入 C2.AgentRuntimePort）+ BridgeModule（注入 C5.PermissionBrokerPort）；provides/exports `SpawnSubagentUseCase` + `SubagentRunRepository`（供 UI/父会话侧消费）；controllers `SubagentController`（spawn SSE / retry / interrupt / runs 列表 / 详情）+ `SubagentPermissionController`（决议回传中转）。**AC**：C3 单向依赖 C2/C5/SK 端口，无实现级循环、无需 forwardRef（编排叶子）。（DI 章节 / NFR-3）
- **S7.7** 静态扫描收口（NFR-1/AC-17）：`subagent/` 核心包禁用 import 扫描 0 命中；RunPhase 只经 Repository 落库、AI 调用/权限/持久化全经端口接口。**AC-17**：`@anthropic-ai/*`/`child_process`/`better-sqlite3`/`@nestjs/*` 0 命中。（NFR-1）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1（迁移矩阵） | S1.2, S2.3 |
| AC-2（terminal immutable，反例） | S2.6, S3.4 |
| AC-3（settling 独立，反例） | S2.4, S6.3 |
| AC-4（显式关联，反例） | S2.2, S4.3 |
| AC-5（ID 误复用拒绝，反例） | S2.7, S4.3, S4.5 |
| AC-6（durable vs 内存分离，反例） | S3.3, S1.8 |
| AC-7（detach 不 abort，反例） | S6.5 |
| AC-8（进程重启收口） | S6.6 |
| AC-9（route 校验 fail-closed，反例） | S4.2 |
| AC-10（依赖编排，反例） | S5.1, S5.2 |
| AC-11（依赖缺失/超时归类，反例） | S5.3 |
| AC-12（回合结束≠成功，反例） | S6.2 |
| AC-13（权限转交） | S7.1 |
| AC-14（queued Stop 取消） | S6.4 |
| AC-15（跨回合事实源，反例） | S7.3 |
| AC-16（幂等收口） | S2.5, S7.5 |
| AC-17（边界纯净） | S1.8, S7.7 |
| AC-18（无假数据） | S1.4, S7.4 |

> 每个 FR 至少一条 Story，每条 Story 映射到上述 AC；18 条 AC 全覆盖。

## 建议排期（Sprint）

- **Sprint 1（骨架 + 两层模型 + phase 状态机 + 事件模型）**：E1 全部、E2 全部、E3 全部。产出零框架 C3 核心骨架 + `LogicalRun`/`Attempt` 两层模型 + durable `RunPhase` 迁移矩阵 + terminal immutable 不变量 + `SubagentEvent` 五类 + `phase_changed` 不落 durable 的归一 + 单测（含 terminal immutable / settling 独立 / durable vs 内存分离反例回归）。
- **Sprint 2（发起 + 依赖编排）**：E4 全部、E5 全部。产出 `SpawnSubagentService`（route fail-closed + 显式关联 + 先写 durable running）+ `RetrySubagentService` + `DispatchCoordinator`（DAG 校验 + queued 不占位 + 上游 terminal 门控 + NOT_FOUND/TIMEOUT 归类 + handoff），用假 `AgentRuntimePort`/假 Clock/假 Repository 跑通 fail-closed 与依赖编排反例 smoke。
- **Sprint 3（复用 Runtime + 中断收口 + recovery + 权限 + Query + 接线）**：E6 全部、E7 全部。产出 `SubagentEventCollector`（消费 `AgentRuntimePort.run` 归一落库）+ `InterruptSubagentService`（Stop 传播经 settling + queued 取消）+ `TerminalReconciler`（结构化 result 决定 outcome + 幂等收口 + 进程重启收口）+ detach≠abort + 权限中转 C5 + `latestAttemptSnapshot` lifecycle-only + `SqliteSubagentRunRepository` + NestJS Module/Controller，跑通回合结束≠成功 / queued Stop / detach≠abort / 进程重启收口反例 smoke。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，无需真实 SDK/进程/网络，用假 `AgentRuntimePort` + 假 `PermissionBrokerPort` + 假 Clock/IdGenerator + 假 `SubagentRunRepository`）。
- **durable vs 内存分离回归通过（AC-6 核心反例）**：假 `AgentRuntimePort` 发 `phase_changed` 内存 phase 序列，断言 durable `RunPhase` 只由领域方法迁移、不被 C2 内存 phase 顶替；静态扫描核心无 import C2 `StreamPhase`——这是 C3 区别于 C2 的核心点，切断"页面切走误 abort / terminal 被迟到 checkpoint 覆盖"根因。
- **terminal immutable 回归通过（AC-2 反例）**：terminal 后注入迟到 partial/error，终态与 result 不被覆盖（对比 running 阶段 partial 会更新）；幂等收口仅第一次生效（AC-16）。
- **回合结束≠成功回归通过（AC-12 反例）**：run 流正常结束但结构化 result 标 failed/无 completed marker → `terminal(failed)`，不因"非错误结束"兜底 completed。
- **detach≠abort 回归通过（AC-7 反例）**：renderer fetch 断开只 detach，Collector 继续、durable row 继续推进、`interrupt` 未被调（对比显式 Stop 才 abort）。
- 依赖编排反例通过（AC-10/AC-11：queued 不占位 + 上游 terminal 门控 + A→B→A 循环 + NOT_FOUND/TIMEOUT 归类不同）；route fail-closed 反例通过（AC-9：未启用 pair 不写 durable、不调 Runtime）。
- 禁用 import 静态扫描 0 命中（AC-17）；无假数据（AC-18：无 effectiveModel 保留 verified requested 标"未报告"、无 durable evidence 不显胶囊）；跨回合事实源 lifecycle-only（AC-15）。
- 跨上下文端口引用闭合：`C2.AgentRuntimePort ← C3`（复用 AI 调用，C2 不感知子 agent）、`C5.PermissionBrokerPort ← C3`（转交权限，C3 不做经纪判定）、`SK.IdGenerator`/`Clock`/`ErrorClassifier`/`RuntimeLog`/`TranslationPort → C3 消费`；C3 是编排叶子，单向 import type，无需 forwardRef。
