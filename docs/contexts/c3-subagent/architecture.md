---
title: 架构 — C3 SubagentOrchestration 子智能体编排
context: C3 · SubagentOrchestration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C3 · SubagentOrchestration（子智能体编排）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 复用的 `C2.AgentRuntimePort` / `AgentStreamEvent` 签名见 [../c2-agent-runtime/architecture.md](../c2-agent-runtime/architecture.md)；依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)；durable lifecycle 事实基线见 CodePilot `docs/handover/same-runtime-multi-model-subagents.md`。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS SubagentController (HTTP/SSE)
                     + 父会话侧 spawn 入口（三 Runtime 的 delegate 调用点）
               ↓ 调用驱动端口
        [驱动端口] SpawnSubagentUseCase / RetrySubagentUseCase
                   / InterruptSubagentUseCase / QuerySubagentRunsUseCase
               ↓
        [应用核心] LogicalRun 聚合根（聚合 Attempt + 依赖编排）
                   + Attempt 实体（RunPhase 持久状态机 + 结构化 result/provenance）
                   + SubagentEvent 事件模型 + 用例编排（纯逻辑，零框架）
               ↓ 依赖倒置，只依赖接口
        [出站端口] SubagentRunRepository（C3 自有，durable 落库）
               +   C2: AgentRuntimePort（import type，发起子 agent AI 调用）
               +   C5: PermissionBrokerPort（import type，转交权限）
               +   SK: IdGenerator / Clock / ErrorClassifier / RuntimeLog / TranslationPort
               ↓ 由适配器实现
        [被驱动适配器] SqliteSubagentRunRepository（better-sqlite3）
               +   C2/C5/SK 适配器（经 DI 注入，C3 不实现）
```

依赖方向永远指向核心。C3 核心**只依赖 SK 端口、C2/C5 端口接口、以及 C3 自己的出站端口 `SubagentRunRepository` 接口**，绝不 import 框架 / SDK / DB / 子进程。C3 是 `C2.AgentRuntimePort` 的**上游消费者**（把子 agent AI 调用当作又一次 `RuntimeRunRequest`，C2 不感知子 agent）、是 `C5.PermissionBrokerPort` 的消费者（转交权限，不做经纪判定）。C3 **不被** C1–C10 中任何上下文依赖其领域概念——它是编排叶子。

## 2. 目录结构

```
packages/core/subagent/
├── domain/
│   ├── run/
│   │   ├── logical-run.ts          # LogicalRun 聚合根 + LogicalRunId 值对象
│   │   ├── attempt.ts              # Attempt 实体 + AttemptId 值对象 + attempt 序号
│   │   ├── run-phase.ts            # RunPhase 持久状态机（running/settling/terminal + TerminalOutcome）
│   │   ├── phase-transition.ts     # 合法迁移谓词 canTransitionRunPhase
│   │   ├── terminal-outcome.ts     # TerminalOutcome 值对象（completed/partial/failed/cancelled/timed_out + 归因）
│   │   ├── dispatch-state.ts       # DispatchState 值对象（queued/dispatched/running/settled）
│   │   └── run-result.ts           # 结构化 result / provenance 值对象
│   ├── route/
│   │   ├── subagent-route.ts       # SubagentRoute 值对象（server-verified provider_id + model + effective）
│   │   └── route-verification.ts   # 校验结果值对象（verified / unavailable）
│   ├── dependency/
│   │   ├── dependency-edge.ts      # DependencyEdge 值对象（workflow_id / task_key / depends_on）
│   │   ├── dependency-graph.ts     # 依赖 DAG 校验（循环 / 自依赖 / 重复 task_key）
│   │   └── handoff.ts              # 上游结果编译进 prompt（标不可信 task data）
│   ├── event/
│   │   ├── subagent-event.ts       # SubagentEvent 联合（activity/tool/permission/partial/terminal）
│   │   └── event-mapping.ts        # AgentStreamEvent → SubagentEvent 归一谓词
│   └── message-keys.ts             # C3 自身 i18n 键（c3.*）
├── ports/
│   ├── driving/
│   │   ├── spawn-subagent-usecase.ts     # SpawnSubagentUseCase 端口（对外提供）
│   │   ├── retry-subagent-usecase.ts     # RetrySubagentUseCase 端口
│   │   ├── interrupt-subagent-usecase.ts # InterruptSubagentUseCase 端口
│   │   └── query-subagent-runs-usecase.ts# QuerySubagentRunsUseCase 端口（UI / 跨回合查询）
│   └── driven/
│       ├── subagent-run-repository.ts    # SubagentRunRepository 出站端口（对外提供 + durable）
│       ├── agent-runtime-port.ts         # C2.AgentRuntimePort 的本地 import type 别名
│       └── permission-broker-port.ts     # C5.PermissionBrokerPort 的本地 import type 别名
├── usecases/
│   ├── spawn-subagent.ts           # SpawnSubagentService（校验 → 依赖 → 写 running → 调 Runtime → 消费归一）
│   ├── retry-subagent.ts           # RetrySubagentService（显式复用 logical_run_id + 递增 attempt）
│   ├── interrupt-subagent.ts       # InterruptSubagentService（Stop 传播 + queued 取消）
│   ├── dispatch-coordinator.ts     # DispatchCoordinator（依赖编排：queued → 上游 terminal → dispatch）
│   ├── event-collector.ts          # SubagentEventCollector（消费 AgentStreamEvent → SubagentEvent 落库）
│   ├── terminal-reconciler.ts      # TerminalReconciler（幂等收口 + terminal immutable + 进程重启 recovery）
│   └── query-subagent-runs.ts      # QuerySubagentRunsService（logical 聚合 / latestAttemptSnapshot）
└── index.ts                        # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`SqliteSubagentRunRepository`）位于 `apps/api` 适配器层，不在核心包内。`C2.AgentRuntimePort` / `C5.PermissionBrokerPort` 只是**类型引用**（`import type`），实现由对应 Module 提供、经 DI 注入。本文件给签名，不给实现。

## 3. 领域模型 (Domain Model)

### 3.1 RunPhase — 持久任务相位状态机（领域不变量核心）

```ts
// domain/run/run-phase.ts
export enum RunPhaseKind {
  RUNNING  = 'running',   // 子 agent 执行中（durable，落库）
  SETTLING = 'settling',  // 已停止 / 上游发终止信号，产物收尾 + 结构化 result 写入中（独立相位）
  TERMINAL = 'terminal',  // 任务已结束（见 TerminalOutcome）
}

// domain/run/terminal-outcome.ts
export enum TerminalOutcome {
  COMPLETED = 'completed', // 任务成功（由结构化 result/provenance 决定，非"回合结束"推断）
  PARTIAL   = 'partial',   // 部分完成（maxTurns / 部分产物）
  FAILED    = 'failed',    // 失败（真实错误 / 无 completed marker）
  CANCELLED = 'cancelled', // 用户 Stop（含 queued 取消）
  TIMED_OUT = 'timed_out', // idle / hard cap 超时
}

export interface TerminalOutcomeValue {
  readonly outcome: TerminalOutcome;
  readonly classified: ClassifiedError | null; // 失败 / 取消 / 超时经 SK.ErrorClassifier 归一；completed 为 null
}

export type RunPhase =
  | { readonly kind: RunPhaseKind.RUNNING }
  | { readonly kind: RunPhaseKind.SETTLING }
  | { readonly kind: RunPhaseKind.TERMINAL; readonly result: TerminalOutcomeValue };

export function isTerminal(phase: RunPhase): boolean;   // kind === TERMINAL
export function isRunning(phase: RunPhase): boolean;     // kind === RUNNING
```

```ts
// domain/run/phase-transition.ts
/**
 * 合法迁移：running→settling / running→terminal / settling→terminal。
 * 任意 terminal→* 与 settling→running 回退一律非法（返回 false）。
 * settling 是独立相位，不得被跳过（除 running→terminal 的直接失败路径外，Stop / 上游终止必经 settling）。
 */
export function canTransitionRunPhase(from: RunPhase, to: RunPhase): boolean;
```

> **边界纪律（NFR-2 / 对齐 CLAUDE.md 与 C2 phase 分离，本上下文的核心区别点）**：`RunPhase` 是**持久任务相位**，**落库**（`subagent_runs` 状态列），回答"这个子任务作为用户可见的工作现在处于哪个阶段"。它**不是** C2 的内存 `StreamPhase`（`active/settling/terminal`，回答"这一次 AI 调用这一刻还在生成吗"，随进程消失）。C3 核心**不 import、不建模** C2 的 `StreamPhase`；消费 `AgentRuntimePort` 返回的 `AgentStreamEvent`（含 `phase_changed`）时，只把它归一成 `SubagentEvent` 落库，**绝不把 C2 内存 phase 当 durable RunPhase 存**。把两者混用正是"页面切走被误 abort""terminal 后被迟到 checkpoint 覆盖"类 bug 的根因（见 6.6 recovery）。

### 3.2 LogicalRun — 一个用户任务的聚合根

```ts
// domain/run/logical-run.ts
export type LogicalRunId = string;

export interface LogicalRunSnapshot {
  readonly id: LogicalRunId;
  readonly parentSessionId: string;         // 父会话 id（durable FK，满足权限 row FK）
  readonly workflowId?: string;             // 依赖编排所属 workflow（可选）
  readonly taskKey?: string;                // workflow 内任务键（不用于隐式合并 attempt）
  readonly dependencies: ReadonlyArray<DependencyEdge>; // DAG 上游边
  readonly attempts: ReadonlyArray<AttemptSnapshot>;    // 1..N 次物理执行（attempt 序号递增）
  readonly createdAt: number;               // 来自 SK.Clock
}

/**
 * LogicalRun 是聚合根：一个用户任务的逻辑身份，UI 胶囊 / sidebar tab 用 id（FR-1.3）。
 * attempt 只按显式 logical_run_id 关联（FR-1.2），聚合根内不做按名称 / task_key 的隐式合并。
 */
export interface LogicalRun {
  snapshot(): LogicalRunSnapshot;
  latestAttempt(): Attempt | null;
  /** 显式重试：生成 attempt 序号 = max(existing)+1 的新 Attempt（FR-5.4）。 */
  appendAttempt(attempt: Attempt): void;
  /** 是否有活跃 attempt（running/settling）——active reuse 冲突判定用（FR-5.4 / AC-5）。 */
  hasActiveAttempt(): boolean;
}
```

### 3.3 Attempt — 一次物理执行的实体

```ts
// domain/run/attempt.ts
export type AttemptId = string;   // == tool use ID == physical attempt identity（FR-1.3）

export interface AttemptSnapshot {
  readonly id: AttemptId;
  readonly logicalRunId: LogicalRunId;   // 显式关联（FR-1.2）
  readonly attempt: number;              // 序号，从 1 递增
  readonly route: SubagentRoute;         // server-verified provider_id + model（+ effective）
  readonly dispatchState: DispatchState; // queued/dispatched/running/settled
  readonly phase: RunPhase;              // 持久相位（落库）
  readonly result?: RunResult;           // 结构化 result / provenance（terminal 时）
  readonly startedAt: number;            // SK.Clock
  readonly settledAt?: number;           // terminal 时刻
}

/**
 * Attempt 是可变实体（durable 投影）。phase 只能经领域方法迁移，外部不得直接赋值（FR-2.6）。
 * 每个迁移方法内部先 canTransitionRunPhase 校验，非法迁移抛 InvalidRunPhaseTransition（AC-1）。
 */
export interface Attempt {
  snapshot(): AttemptSnapshot;

  /** dispatch_state 推进：queued → dispatched（依赖满足，占并发位前）→ running。 */
  markDispatched(): void;
  markRunning(): void;

  /** running → settling：Stop / 上游发终止信号，收尾中（FR-2.4，独立相位）。 */
  markSettling(): void;

  /** * → terminal(completed)：由结构化 result 决定成功，非"回合结束"兜底（FR-6.4）。
   *  幂等：已 terminal 时 no-op（NFR-5 / AC-16）。 */
  complete(result: RunResult): void;

  /** * → terminal(partial/failed/cancelled/timed_out)：带归因 ClassifiedError。
   *  幂等：已 terminal 时 no-op（terminal immutable，FR-2.5 / AC-2）。 */
  settleNonSuccess(outcome: TerminalOutcome, error: ClassifiedError, result?: RunResult): void;

  /** running 阶段更新部分产物 checkpoint（≤64 KiB）；terminal 后 no-op（FR-4.4 / AC-2）。 */
  checkpointPartial(text: string): void;
}
```

> **terminal immutable 不变量（FR-2.5 / NFR-5，核心）**：`complete()` / `settleNonSuccess()` / `checkpointPartial()` 内部若当前已是 terminal 则 no-op（幂等），否则强制迁移到对应终态——**terminal 收口只发生一次，迟到事件 / checkpoint 绝不覆盖终态**。这把"每条 spawn 分支都要记得别覆盖终态"的人工纪律，变成实体不变量。

### 3.4 DispatchState 与 RunResult

```ts
// domain/run/dispatch-state.ts
export enum DispatchState {
  QUEUED     = 'queued',      // 有依赖，等上游 durable terminal；不占并发位、不调 Provider（FR-5.5）
  DISPATCHED = 'dispatched',  // 依赖满足，已占并发位、准备调 Runtime
  RUNNING    = 'running',     // AgentRuntimePort.run 进行中
  SETTLED    = 'settled',     // 已收口
}

// domain/run/run-result.ts
export interface RunResult {
  readonly outcome: TerminalOutcome;
  readonly summary?: string;          // 结构化摘要（provenance），非 prompt/result 全文
  readonly effectiveModel?: string;   // Runtime 上报的真实模型；无值=保留 verified requested，不冒充（AC-18）
  readonly provenance: Readonly<Record<string, unknown>>; // 执行归属证据（已脱敏）
}
```

### 3.5 SubagentEvent — 子 agent typed lifecycle 事件模型

```ts
// domain/event/subagent-event.ts
export type SubagentEvent =
  | { readonly type: 'activity';   readonly attemptId: AttemptId; readonly text: string }                 // 状态 / 进展
  | { readonly type: 'tool';       readonly attemptId: AttemptId; readonly phase: 'started' | 'completed'; readonly tool: ToolRef }
  | { readonly type: 'permission'; readonly attemptId: AttemptId; readonly request: PermissionRequestRef; readonly status?: 'allow' | 'deny' }
  | { readonly type: 'partial';    readonly attemptId: AttemptId; readonly text: string }                 // 部分产物 checkpoint（≤64 KiB）
  | { readonly type: 'terminal';   readonly attemptId: AttemptId; readonly result: RunResult };           // 终态 + 结构化 result/provenance
```

```ts
// domain/event/event-mapping.ts
/**
 * 把 C2 的 AgentStreamEvent 归一成 C3 的 SubagentEvent（落 subagent_run_events）：
 *   text/status         → activity
 *   tool_use/tool_result→ tool(started/completed)
 *   permission_request  → permission(request)；permission_resolved → permission(+status)
 *   累积正文             → partial（checkpoint）
 *   result/error/终态    → terminal（结构化 result）
 *   phase_changed（C2 内存 phase）→ **不落 durable RunPhase**，至多映射成 activity 或丢弃（FR-3.1 / AC-6）
 * 未识别事件降级（丢弃 / 保留 raw），不伪造、不改变已识别语义（FR-4.3）。
 */
export function mapStreamEvent(event: AgentStreamEvent, attemptId: AttemptId): SubagentEvent | null;
```

> **FR-3.1 / AC-6（durable vs 内存分离）**：`AgentStreamEvent.phase_changed` 携带的是 C2 内存 `StreamPhase`。C3 **绝不**把它当 durable `RunPhase` 存——durable RunPhase 只由 C3 用例经 Attempt 领域方法迁移（markSettling/complete/settleNonSuccess），由 dispatch / Stop / 结构化 result / recovery 驱动，与 C2 内存 phase 是两条独立轨道。

### 3.6 SubagentRoute 与依赖 DAG

```ts
// domain/route/subagent-route.ts
export interface SubagentRoute {
  readonly providerId: string;          // server-verified，必须是启用 pair（FR-5.1）
  readonly model: string;               // requested canonical model
  readonly effectiveModel?: string;     // Runtime 上报的真实模型；无值=用 requested，标"未报告"（AC-18）
}

// domain/dependency/dependency-edge.ts
export interface DependencyEdge {
  readonly workflowId: string;
  readonly taskKey: string;             // 本任务键（重复 → 拒绝）
  readonly dependsOn: ReadonlyArray<string>; // 上游 task_key 列表
}

// domain/dependency/dependency-graph.ts
/**
 * 启动前校验（FR-5.2 / AC-10）：task_key 重复、自依赖、间接循环 → 返回违规原因（拒绝）。
 * 无违规返回 null。纯函数，不触 I/O。
 */
export function validateDependencyGraph(edges: ReadonlyArray<DependencyEdge>): DependencyViolation | null;
```

## 4. 驱动端口 (Driving Ports)

### 4.1 SpawnSubagentUseCase（对外提供）

```ts
// ports/driving/spawn-subagent-usecase.ts
export interface SpawnSubagentInput {
  parentSessionId: string;
  route: { providerId?: string; model?: string };  // 都缺省=继承父路由；给一半=非法
  prompt: string;
  workflowId?: string;
  taskKey?: string;
  dependsOn?: ReadonlyArray<string>;
  logicalRunId?: LogicalRunId;          // 显式重试才给；缺省=新 LogicalRun（FR-1.2 / AC-4）
  parentAbortSignal: AbortSignalLike;   // 父回合 abort 向下传播（FR-6.2）
}

export interface SpawnSubagentResult {
  logicalRunId: LogicalRunId;
  attemptId: AttemptId;
  events: AsyncIterable<SubagentEvent>;  // 归一后的子 agent 事件流（同时已落库）
}

export interface SpawnSubagentUseCase {
  /**
   * 发起一次子 agent delegate（FR-5）：
   *  1. 校验 route（provider+model 必须 server-verified 启用 pair）→ 非法 SUBAGENT_MODEL_UNAVAILABLE，
   *     **不写 durable running、不调 AgentRuntimePort**（FR-5.1 / AC-9）。
   *  2. 校验依赖 DAG（重复 task_key / 自依赖 / 循环 / 未声明却待命）→ DEPENDENCY_*（FR-5.2）。
   *  3. 解析 / 创建 LogicalRun：给 logicalRunId 且 active → 冲突拒绝；completed → 拒绝或显式重试；
   *     缺省 → 新 LogicalRun（FR-1.2 / FR-5.4 / AC-4/5）。
   *  4. **先写 durable subagent_runs.running**；写失败 → child 不启动（fail-closed，FR-5.3）。
   *  5. 有依赖 → dispatch_state=queued，交 DispatchCoordinator（FR-5.5）；无依赖 → 直接 dispatch。
   *  6. dispatch 时经 AgentRuntimePort.run 发起 AI 调用，SubagentEventCollector 消费归一 + 落库。
   *  7. child 达 completed/partial/failed/cancelled/timed_out 才收口 terminal（FR-6.4）。
   */
  spawn(input: SpawnSubagentInput): Promise<SpawnSubagentResult>;
}
```

### 4.2 RetrySubagentUseCase / InterruptSubagentUseCase

```ts
// ports/driving/retry-subagent-usecase.ts
export interface RetrySubagentUseCase {
  /** 显式复用 logical_run_id 生成递增 attempt（FR-5.4）；active reuse → 冲突（AC-5）。 */
  retry(logicalRunId: LogicalRunId): Promise<SpawnSubagentResult>;
}

// ports/driving/interrupt-subagent-usecase.ts
export interface InterruptSubagentUseCase {
  /**
   * Stop 传播（FR-6.3）：
   *  - running attempt → markSettling → AgentRuntimePort.interrupt/forceKillTurn → terminal(cancelled)（经 settling，AC-3）。
   *  - queued attempt → 直接 terminal(cancelled)，**不等依赖 deadline**（组合 AbortSignal / dispatch_state，AC-14）。
   *  幂等：已 terminal → no-op。
   */
  interrupt(logicalRunId: LogicalRunId): Promise<void>;
}
```

### 4.3 QuerySubagentRunsUseCase（UI / 跨回合查询，对外提供）

```ts
// ports/driving/query-subagent-runs-usecase.ts
export interface QuerySubagentRunsUseCase {
  /** UI 详情：logical 聚合（最新 attempt + 全部 attempts + events）。 */
  getLogicalRun(logicalRunId: LogicalRunId): Promise<LogicalRunSnapshot | null>;
  /**
   * 父模型跨回合查进展（FR-8.2 / AC-15）：**仅**读 durable 表返回 lifecycle-only snapshot
   * （状态 / outcome / 简要 provenance，不含 prompt/result 全文，避免升格成 system instruction）。
   * 禁止从正文 / update_plan / 耗时 / 工作区推断。
   */
  latestAttemptSnapshot(logicalRunId: LogicalRunId): Promise<AttemptLifecycleSnapshot | null>;
  /** 按 parentSessionId 列出 managed runs（UI 胶囊；无 durable evidence 不列，FR-8.3）。 */
  listRunsBySession(parentSessionId: string): Promise<ReadonlyArray<LogicalRunSnapshot>>;
}
```

## 5. 出站端口 (Driven Ports)

### 5.1 SubagentRunRepository（C3 自有；对外提供供 UI 读）

```ts
// ports/driven/subagent-run-repository.ts
export interface SubagentRunRepository {
  /** 创建 durable running row（FR-5.3）；返回失败 → 调用方 fail-closed 不启动 child。 */
  createRunning(attempt: AttemptSnapshot): Promise<void>;
  /** 持久化 dispatch_state / phase 迁移（FR-2.2）；只接受合法迁移（越权由领域方法先拦）。 */
  updatePhase(attemptId: AttemptId, phase: RunPhase, dispatchState: DispatchState): Promise<void>;
  /** 追加 typed lifecycle 事件（FR-4.2）。 */
  appendEvent(event: SubagentEvent): Promise<void>;
  /** 原子收口 terminal（NFR-5 / AC-16）：仅第一次生效，已 terminal → no-op，返回是否为本次收口。 */
  settleTerminalOnce(attemptId: AttemptId, result: RunResult): Promise<boolean>;
  /** running 阶段更新部分 checkpoint（≤64 KiB，terminal 后忽略，FR-4.4）。 */
  checkpointPartial(attemptId: AttemptId, text: string): Promise<void>;

  // —— 读取（UI / 跨回合，FR-8）——
  findLogicalRun(logicalRunId: LogicalRunId): Promise<LogicalRunSnapshot | null>;
  findAttempt(attemptId: AttemptId): Promise<AttemptSnapshot | null>;
  latestAttemptLifecycle(logicalRunId: LogicalRunId): Promise<AttemptLifecycleSnapshot | null>;
  listByParentSession(parentSessionId: string): Promise<ReadonlyArray<LogicalRunSnapshot>>;

  // —— 进程重启 recovery（FR-3.4 / AC-8）——
  /** 列出遗留 running/settling row（供 owner 判活后收口；schema init 本身不 recovery）。 */
  listStaleActiveRuns(): Promise<ReadonlyArray<AttemptSnapshot>>;
}
```
- **实现位置**：适配器 `SqliteSubagentRunRepository`（`apps/api`），落 `subagent_runs` / `subagent_run_events`（对齐现有两表 schema）。
- **供 UI 复用**：引用图未把 C3 列为被依赖，UI（web SPA）经 NestJS Controller → `QuerySubagentRunsUseCase` → 本 Repository 读取。

### 5.2 C2.AgentRuntimePort（本地 import type 别名）

```ts
// ports/driven/agent-runtime-port.ts
// C3 仅引用 C2 定义的出站端口类型；实现由 C2 Module 提供并注入（AgentRuntimeModule.exports）。
import type { AgentRuntimePort, RuntimeRunRequest, TurnRef, AgentStreamEvent, RuntimeAvailability } from '<c2-package>';
export type { AgentRuntimePort, RuntimeRunRequest, TurnRef, AgentStreamEvent, RuntimeAvailability };
```
- **契约来源**：边界契约 `C2 对外提供端口：AgentRuntimePort（供 C3 复用）`；引用图 `C2.AgentRuntimePort ← C3`。签名（`run` / `interrupt` / `forceKillTurn` / `availability`）见 C2 architecture 5.1，C3 **不重写**。
- **C3 用法**：`run(request)` 发起子 agent AI 调用（C2 不感知子 agent，视作又一次 `RuntimeRunRequest`）；`interrupt` / `forceKillTurn` 供 Stop 传播；`availability` 供 spawn 前探测（不 spawn 进程）。

### 5.3 C5.PermissionBrokerPort（本地 import type 别名）

```ts
// ports/driven/permission-broker-port.ts
import type { PermissionBrokerPort } from '<c5-package>';
export type { PermissionBrokerPort };   // C3 只转交权限请求 / 消费决议，不做经纪判定
```
- **契约来源**：边界契约 `C5 对外提供端口：PermissionBrokerPort（供 C3）`；引用图 `C5.PermissionBrokerPort ← C3`。C3 **不实现**经纪逻辑（FR-7.1）。
- **C3 用法**：子 agent 触发需审批工具 → 经本端口转交；决议镜像成 `SubagentEvent.permission` 落库，由唯一 `permissionRequestId` 定向回传（FR-7.2）。

## 6. 用例编排要点

- **6.1 SpawnSubagentService.spawn** —— 见 4.1 步骤：route 校验 fail-closed（未启用 pair 不写 durable、不调 Runtime，AC-9）→ 依赖 DAG 校验（`validateDependencyGraph`，AC-10）→ 解析/创建 LogicalRun（显式 logicalRunId 才关联，active/completed reuse 拒绝，AC-4/5）→ `attemptId←IdGenerator.next()`、`startedAt←Clock.now()` → **先 `Repository.createRunning`**（失败即 fail-closed，FR-5.3）→ 有依赖走 6.2、无依赖走 6.3。
- **6.2 DispatchCoordinator（依赖编排）** —— 有依赖 attempt 置 `dispatch_state=queued`，**不占并发位、不调 Provider**（FR-5.5）；轮询 / 事件驱动等上游同 workflow 最新 durable `terminal(completed)`；上游从未创建 → 5 秒宽限后 `DEPENDENCY_NOT_FOUND`（AC-11）；上游存在但 deadline 未终止 → `DEPENDENCY_TIMEOUT`；上游失败 / 空结果 / ownership 丢失 → 结构化失败，下游 attempt 归 `terminal(failed)`，**绝不调下游 Provider**；上游 completed → `handoff` 把上游真实结果编译进 prompt（标不可信 task data，FR-5.7）→ `markDispatched` → 6.3。
- **6.3 dispatch + 事件消费（SubagentEventCollector）** —— `markRunning`；构造 `RuntimeRunRequest`（独立 child session、独立 AbortController、depth=1）；订阅 `AgentRuntimePort.run` 归一事件流 → 每个 `AgentStreamEvent` 经 `mapStreamEvent` → `SubagentEvent` → `Repository.appendEvent` + 更新内存 Attempt；`partial` 事件 → `checkpointPartial`；`phase_changed`（C2 内存 phase）**不落 durable RunPhase**（FR-3.1 / AC-6）。
- **6.4 终态收口（TerminalReconciler）** —— 流正常结束但**结构化 result 决定 outcome**（非"非错误结束=completed"兜底，FR-6.4 / AC-12）：completed marker + 正文 → `complete`；无 marker / 明确失败 → `settleNonSuccess(failed)`；maxTurns → partial；idle/hard cap → timed_out；error 事件 → 按 `SK.ErrorClassifier` 归因 failed；Stop → cancelled。收口经 `Repository.settleTerminalOnce`（原子，仅第一次生效，NFR-5 / AC-16）；terminal 后迟到 partial/event no-op（FR-2.5 / AC-2）。
- **6.5 InterruptSubagentService（Stop 传播）** —— running → `markSettling`（落 settling，AC-3）→ `AgentRuntimePort.interrupt(turnRef)`，必要时 `forceKillTurn` → `settleNonSuccess(cancelled, ABORTED)`；queued → 组合 AbortSignal 命中 → 直接 `terminal(cancelled)` 不等 deadline（AC-14）；父 `parentAbortSignal` 触发同样向下传播（FR-6.2）。
- **6.6 进程重启 recovery（TerminalReconciler.recover）** —— 启动时经 `Repository.listStaleActiveRuns` 拿遗留 running/settling；**仅当**上一 owner 缺失 / PID 已死才收口为 `terminal(failed, PROCESS process_restarted)`；owner 存活 → 不动；**schema/migration 初始化本身不执行运行态 recovery**（FR-3.4 / AC-8）——避免 Next route / 模块重复 init 把活任务误标 recovery。
- **6.7 detach ≠ abort（FR-3.3 / AC-7）** —— renderer fetch 断开 / 页面切走只 detach，server 侧 Collector 继续消费 + 持久化，**不**触发 `AgentRuntimePort.interrupt`；只有显式 Stop（6.5）才 abort。
- **6.8 权限中转（FR-7）** —— Collector 遇 `permission` 类归一事件 → 经 `C5.PermissionBrokerPort` 转交 + 镜像成 `SubagentEvent.permission` 落库；决议由唯一 `permissionRequestId` 定向回对应 attempt 的 Runtime 调用。C3 **不做** allow/deny 判定。
- 所有用户可见文案用 `c3.*` messageKey，交 `SK.TranslationPort`；错误文案 key 来自 `SK.ErrorClassifier` 的 `messageKey`；关键路径经 `SK.RuntimeLog`（source=`c3.spawn` / `c3.dispatch` / `c3.persistence`）。

## 7. 被驱动适配器（apps/api，隔离 DB）

> 核心零框架；下列适配器实现 `SubagentRunRepository`。C3 核心 `LogicalRun` / `Attempt` / 用例代码**不出现** `better-sqlite3` / `@nestjs/*` / SDK / 进程细节（NFR-1 / AC-17）。

### 7.1 SqliteSubagentRunRepository
- 封装 `better-sqlite3`，落 `subagent_runs`（`logical_run_id` / `attempt` / `route` / `dispatch_state` / 状态列 / `dependencies_json` / structured result/provenance / parent FK）与 `subagent_run_events`（typed lifecycle，关联 `attempt_id`），对齐现有两表 schema。
- **原子收口**：`settleTerminalOnce` 用 `UPDATE ... WHERE phase != 'terminal'` 保证仅第一次生效（NFR-5）；terminal immutable 由 WHERE 条件在 SQL 层再兜一道。
- **checkpoint 上限**：`checkpointPartial` 截断到 64 KiB，`WHERE phase = 'running'` 防 terminal 后覆盖（FR-4.4）。
- **recovery 查询**：`listStaleActiveRuns` 返回 running/settling row（不自动收口——收口由 6.6 TerminalReconciler 判活后决定）；schema init 只补结构、bump revision，不触 runtime recovery。
- **details evidence**：读取返回有效 durable row 才算 managed evidence（FR-8.3）；缺失（等价 404）返回 null，UI 据此暂记 missing、不永久轮询。

### 7.2 C2 / C5 / SK 适配器（不在 C3 实现）
- `AgentRuntimePort` 实现（`RuntimeRouter` + 三 Runtime 适配器）由 **C2 Module** 提供，经 DI 注入；Codex 进程病 fail-fast 归一成 `ClassifiedError` 全锁在 C2 的 `CodexRuntimeAdapter` 内（NFR-4）——C3 只消费该错误把 attempt 归 `terminal(failed, PROCESS)`。
- `PermissionBrokerPort` 实现由 **C5 Module** 提供；`IdGenerator` / `Clock` / `ErrorClassifier` / `RuntimeLog` / `TranslationPort` 由 **SharedKernelModule** 提供。

## 8. 依赖注入接线 (NestJS 侧)

```
SubagentModule (apps/api)
  imports: [SharedKernelModule,          // IdGenerator/Clock/ErrorClassifier/RuntimeLog/TranslationPort
            AgentRuntimeModule,          // 注入 C2.AgentRuntimePort（run/interrupt/forceKillTurn/availability）
            BridgeModule]                // 注入 C5.PermissionBrokerPort
  provides:
    SpawnSubagentUseCase    → SpawnSubagentService(AgentRuntimePort, PermissionBrokerPort, SubagentRunRepository,
                                                   DispatchCoordinator, SubagentEventCollector, TerminalReconciler,
                                                   IdGenerator, Clock, ErrorClassifier, RuntimeLog)
    RetrySubagentUseCase    → RetrySubagentService(SubagentRunRepository, SpawnSubagentService, IdGenerator, Clock)
    InterruptSubagentUseCase→ InterruptSubagentService(AgentRuntimePort, SubagentRunRepository, ErrorClassifier)
    QuerySubagentRunsUseCase→ QuerySubagentRunsService(SubagentRunRepository)
    SubagentRunRepository   → SqliteSubagentRunRepository(Database, Clock)
  exports:
    SpawnSubagentUseCase, SubagentRunRepository   // 契约「对外提供端口」；UI/父会话侧消费
  controllers:
    SubagentController  (POST /api/subagent/spawn 发起 → SSE 事件流;
                         POST /api/subagent/retry 重试;
                         POST /api/subagent/interrupt Stop;
                         GET  /api/subagent/runs?sessionId=  UI 胶囊列表;
                         GET  /api/subagent/runs/:logicalRunId  详情面板 attempts/events)
    SubagentPermissionController (POST /api/subagent/permission 决议回传中转 → PermissionBrokerPort)
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。**无实现级循环依赖**：C3 单向依赖 C2 / C5 / SK 的端口接口，C2 / C5 / SK 不反向依赖 C3；核心包之间只 `import type`。C3 是编排叶子（引用图无 `* ← C3` 之外的入边），因此不需要 `forwardRef`。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `C2.AgentRuntimePort` | C3 依赖 C2（复用 AI 调用） | context-boundaries.md：C3「依赖端口：C2.AgentRuntimePort」+ C2「对外提供 AgentRuntimePort（供 C3 复用）」+ 引用图 `C2.AgentRuntimePort ← C3` |
| `C5.PermissionBrokerPort` | C3 依赖 C5（转交权限） | C3「依赖端口：C5.PermissionBrokerPort」+ C5「对外提供 PermissionBrokerPort（供 C3）」+ 引用图 `C5.PermissionBrokerPort ← C3` |
| `SK.IdGenerator`/`Clock`/`ErrorClassifier` | C3 依赖 SK | SK 对外端口清单（含 ErrorClassifier 的 ABORTED/PROCESS 等类） |
| `SK.RuntimeLog`/`TranslationPort` | C3 依赖 SK（横切） | SK 对外端口清单（横切全上下文） |
| `SpawnSubagentUseCase` | C3 对外提供 | C3「对外提供端口：SpawnSubagentUseCase」 |
| `SubagentRunRepository` | C3 对外提供（+ UI 读） | C3「对外提供端口：SubagentRunRepository」 |

**边界纪律自检**：
- C3 未定义 / 未重写任何 C2 概念（`StreamSession` / `StreamPhase` / `AgentStreamEvent` 只 `import type`）；未重写 C5 权限经纪；未重写 SK 概念。
- C3 核心**不含** AI 调用本身（run/interrupt 经 `AgentRuntimePort`）、权限经纪判定（经 `PermissionBrokerPort`）、会话/消息持久化（属 C1）、Provider 配置管理（属 C7）。
- C3 核心不 import `@anthropic-ai/*` / `better-sqlite3` / `@nestjs/*` / `node:child_process` / codex SDK；DB 全在 `SqliteSubagentRunRepository`，AI/进程全在 C2 适配器（NFR-1 / AC-17）。
- `RunPhase` 是**持久落库**任务相位，与 C2 内存 `StreamPhase` 分属两个上下文、两条轨道，不混用（NFR-2 / AC-6）——这是 C3 区别于 C2 的核心点，也切断"页面切走误 abort / terminal 被覆盖"根因。
- attempt 只按显式 `logical_run_id` 关联，缺省不隐式合并；active/completed ID 误复用应用层拒绝（FR-1.2 / FR-5.4 / AC-4/5）。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，无 dev server / 无真实 SDK-进程-DB）：
  - `canTransitionRunPhase` 合法 / 非法迁移全矩阵（AC-1）；`Attempt` 迁移方法幂等（terminal 后 no-op）。
  - **terminal immutable 回归（AC-2，反例）**：terminal 后注入迟到 partial / error，断言终态与 result 不变（对比 running 阶段 partial 会更新）。
  - **settling 独立相位（AC-3，反例）**：Stop running attempt，断言观察到 settling 落库再到 terminal(cancelled)，非跳过。
  - **显式关联 vs 隐式合并（AC-4，反例）**：给 logicalRunId → attempt=2 并入；不给但同 task_key → 新 LogicalRun。
  - **ID 误复用拒绝（AC-5，反例）**：active reuse → 冲突；completed 静默并入 → 拒绝。
  - **route fail-closed（AC-9，反例）**：未启用 pair → SUBAGENT_MODEL_UNAVAILABLE，spy 断言 `createRunning` / `AgentRuntimePort.run` 未被调（对比合法 route 正常启动）。
  - **依赖编排（AC-10，反例）**：三 task 同 workflow 后两 queued、上游 terminal 前不调 Provider；A→B→A 循环 + 上游失败 → DEPENDENCY_* 结构化失败。
  - **依赖缺失 / 超时归类（AC-11，反例）**：从未创建 → DEPENDENCY_NOT_FOUND（5s 宽限）；存在未终止 → DEPENDENCY_TIMEOUT；error.code 不同。
  - **回合结束≠成功（AC-12，反例）**：run 流正常结束但 result 标 failed / 无 marker → terminal(failed)，断言不兜底 completed。
  - **幂等收口（AC-16）**：并发两次 settleTerminalOnce，仅第一次生效。
- durable vs 内存分离（AC-6，反例）：假 `AgentRuntimePort` 发 `phase_changed` 内存 phase 序列，断言 durable `RunPhase` 只由领域方法迁移、不等于内存 phase 快照；静态扫描核心无 import C2 `StreamPhase`。
- detach ≠ abort（AC-7，反例）：模拟 fetch 断开，spy 断言 Collector 继续、`interrupt` 未被调（对比显式 Stop 才 abort）。
- 进程重启收口（AC-8）：遗留 running + owner PID 已死 → 收口 terminal；schema init 重复 → 不 recovery（对比 owner 存活不收口）。
- 权限转交（AC-13）：假 `PermissionBrokerPort` spy 断言只转交、C3 无 allow/deny 判定。
- queued Stop（AC-14）：queued child 被 Stop → terminal(cancelled) 不等 deadline。
- 跨回合事实源（AC-15，反例）：`latestAttemptSnapshot` 只读 durable 表返回 lifecycle-only；断言无从正文/耗时推断路径。
- 无假数据（AC-18，反例）：无 effective model → 保留 verified requested 标"未报告"；无 durable evidence → 不显胶囊。
- 静态检查（AC-17）：`subagent/` 核心包禁用 import 扫描（`@anthropic-ai/*` / `child_process` / `codex` / `better-sqlite3` / `@nestjs/*` 0 命中）+ RunPhase 只经 Repository 落库、AI/权限只经端口接口。
