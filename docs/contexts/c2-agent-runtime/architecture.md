---
title: 架构 — C2 AgentRuntime 智能体运行时
context: C2 · AgentRuntime
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C2 · AgentRuntime（智能体运行时）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)；C1 持久 StreamStatus 语义见 [../c1-conversation/architecture.md](../c1-conversation/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS ChatController (HTTP/SSE) / InterruptController
               ↓ 调用驱动端口
        [驱动端口] StartStreamUseCase / AbortStreamUseCase
                   / TitleGenerator（供 C1）/ AgentRuntimePort（供 C3 复用）
               ↓
        [应用核心] StreamSession 聚合根（phase 状态机 + canAccept）
                   + AgentStreamEvent 事件模型 + 用例编排（纯逻辑，零框架）
               ↓ 依赖倒置，只依赖接口
        [出站端口] AgentRuntimePort（C2 自有）
               +   SK: ErrorClassifier / Clock / IdGenerator / RuntimeLog / TranslationPort
               +   C1: AppendMessageUseCase / GetSessionHistoryUseCase（import type）
               +   C7: ProviderRepository（只读，import type）
               ↓ 由适配器实现
        [被驱动适配器] ClaudeSdkRuntimeAdapter / NativeRuntimeAdapter / CodexRuntimeAdapter
                       （各带 EventMapper）+ SK/C1/C7 适配器（经 DI 注入）
```

依赖方向永远指向核心。C2 核心**只依赖 SK 端口、C1/C7 端口接口、以及 C2 自己的出站端口 `AgentRuntimePort` 接口**，绝不 import 框架/SDK/DB/子进程。C3、C5 是 C2 的**上游消费者**（经 `AgentRuntimePort` / `StartStreamUseCase`），C1 与 C2 互为消费（C1 用 `C2.TitleGenerator`，C2 用 `C1.AppendMessageUseCase`）——这条环只在 NestJS Module 层经 `forwardRef` 解，核心包只单向 `import type`。

## 2. 目录结构

```
packages/core/agent-runtime/
├── domain/
│   ├── stream/
│   │   ├── stream-session.ts        # StreamSession 聚合根 + StreamSessionId 值对象
│   │   ├── stream-phase.ts          # StreamPhase 状态机（active/settling/terminal + 子态）
│   │   ├── phase-transition.ts      # 合法迁移谓词 canTransitionPhase + reconcilePhase
│   │   ├── terminal-reason.ts       # TerminalReason 值对象（completed/aborted/errored + 归因）
│   │   └── turn-artifacts.ts        # 累积产物值对象（text/thinking/toolUses/toolResults/tokenUsage）
│   ├── event/
│   │   ├── agent-stream-event.ts    # AgentStreamEvent 联合（14 类事件）
│   │   ├── tool-info.ts             # ToolUseInfo / ToolResultInfo 值对象
│   │   └── usage.ts                 # TokenUsage / ContextUsage 值对象（只存投影，不算）
│   ├── runtime/
│   │   ├── runtime-kind.ts          # RuntimeKind 枚举（claude-sdk/native/codex）
│   │   └── runtime-availability.ts  # RuntimeAvailability 值对象
│   └── message-keys.ts              # C2 自身 i18n 键（c2.*）
├── ports/
│   ├── driving/
│   │   ├── start-stream-usecase.ts  # StartStreamUseCase 端口
│   │   ├── abort-stream-usecase.ts  # AbortStreamUseCase 端口
│   │   └── title-generator.ts       # TitleGenerator 端口（供 C1 消费）
│   └── driven/
│       ├── agent-runtime-port.ts    # AgentRuntimePort 出站端口（三适配器实现 + 供 C3 复用）
│       ├── conversation-ports.ts    # C1 用例端口的本地 import type 别名
│       └── provider-read-port.ts    # C7.ProviderRepository 的本地只读 import type 别名
├── usecases/
│   ├── start-stream.ts              # StartStreamService（实现 StartStreamUseCase）
│   ├── abort-stream.ts              # AbortStreamService（force-abort 无条件先行 + reconcile）
│   ├── generate-title.ts            # GenerateTitleService（非流式一次性）
│   └── stream-session-registry.ts   # 内存 StreamSession 注册表（活跃回合索引，非持久层）
└── index.ts                         # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`ClaudeSdkRuntimeAdapter`、`NativeRuntimeAdapter`、`CodexRuntimeAdapter` 及其 `EventMapper`、`CodexAppServerManager`）位于 `apps/api` 适配器层，不在核心包内。C1/C7 端口只是**类型引用**（`import type`），实现由对应 Module 提供、经 DI 注入。本文件给签名，不给实现。

## 3. 领域模型 (Domain Model)

### 3.1 StreamPhase — 实时相位状态机（领域不变量核心）

```ts
// domain/stream/stream-phase.ts
export enum StreamPhaseKind {
  ACTIVE   = 'active',    // 回合进行中；canAccept()=false；isStreaming gate=on
  SETTLING = 'settling',  // 已请求中断/上游已发终止信号，产物收尾 + turn 关闭中
  TERMINAL = 'terminal',  // 回合已结束（见 TerminalSubstate）
}

export enum TerminalSubstate {
  COMPLETED = 'completed', // 正常完成
  ABORTED   = 'aborted',   // 用户主动 abort / stop（→ ErrorCode.ABORTED）
  ERRORED   = 'errored',   // 出错终止（→ 真实 ErrorCode）
}

export type StreamPhase =
  | { readonly kind: StreamPhaseKind.ACTIVE }
  | { readonly kind: StreamPhaseKind.SETTLING }
  | { readonly kind: StreamPhaseKind.TERMINAL; readonly substate: TerminalSubstate };

export function isTerminal(phase: StreamPhase): boolean;   // kind === TERMINAL
export function isActive(phase: StreamPhase): boolean;     // kind === ACTIVE
```

```ts
// domain/stream/phase-transition.ts
/**
 * 合法迁移：active→settling / active→terminal / settling→terminal。
 * 任意 terminal→* 与 settling→active / terminal→active 回退一律非法（返回 false）。
 */
export function canTransitionPhase(from: StreamPhase, to: StreamPhase): boolean;

/**
 * 中断响应携带的 Runtime 权威状态 → 目标相位纠正（对齐现有 reconcilePhase）。
 * 'running'/unknown → null（不纠正，force-abort 网兜底）；
 * 'idle'/'interrupted'/'error' → terminal 子态。仅用于 AbortStreamService 的 I4 收敛。
 */
export function reconcilePhase(
  runtimeStatus: string | null,
  current: StreamPhase,
): StreamPhase | null;
```

> **边界纪律（NFR-2 / 对齐 CLAUDE.md stop/abort 高发区第 2 点）**：`StreamPhase` 是**实时内存相位**，回答"现在这一刻还在生成吗"，**绝不落库**。它**不是** C1 的持久转录行生命周期 `StreamStatus`（streaming/completed/interrupted/error）。C2 核心**不 import、不建模** C1 的 `StreamStatus` 做实时判断；回合终态时只把 `TerminalSubstate` 映射成 `StreamStatus` 经 `C1.AppendMessageUseCase.updateStreamStatus` 写回（见 6.4）。把 phase 落库或把 C1 持久 StreamStatus 当实时相位读，正是现有 stop/abort 卡死根因，C2 在类型层面切断。

### 3.2 StreamSession — 一次回合的聚合根

```ts
// domain/stream/stream-session.ts
export type StreamSessionId = string;

export interface StreamSessionSnapshot {
  readonly id: StreamSessionId;
  readonly sessionId: string;              // 关联 C1 会话（不含 C1 实体，仅 id）
  readonly runtimeKind: RuntimeKind;       // 发起时锁定
  readonly phase: StreamPhase;
  readonly artifacts: TurnArtifacts;        // 累积产物（见 3.4）
  readonly tokenUsage?: TokenUsage;         // Runtime 上报投影；无值=未记录，不显 0
  readonly contextUsage?: ContextUsage;     // Runtime 上报投影；无值=隐藏
  readonly error?: ClassifiedError;         // 终态 errored/aborted 时的分类结果（SK）
  readonly terminalReason?: TerminalReason; // 终态归因
  readonly startedAt: number;               // 来自 SK.Clock
  readonly settledAt?: number;              // 终态时刻
}

/**
 * StreamSession 是可变聚合根（内存态）。phase 只能经下列领域方法迁移，
 * 外部不得直接赋值 phase（FR-1.2）。每个迁移方法内部先 canTransitionPhase 校验，
 * 非法迁移抛 InvalidPhaseTransition（AC-1）。
 */
export interface StreamSession {
  snapshot(): StreamSessionSnapshot;

  /** isStreaming gate 的唯一判据：≡ phase.kind !== ACTIVE（FR-1.6 / AC-3）。
   *  composer「能否发送」只走这个方法，不散落 phase==='active' 比较。 */
  canAccept(): boolean;

  /** 累积一个归一后的事件到产物（text/thinking/tool_*/usage 等），不改 phase。 */
  apply(event: AgentStreamEvent): void;

  /** active → settling：请求中断/收到上游终止信号但收尾未完成（FR-1.5）。 */
  markSettling(): void;

  /** * → terminal(completed)：正常完成。 */
  complete(tokenUsage?: TokenUsage): void;

  /** * → terminal(aborted)：用户主动中断。error 归 ErrorCode.ABORTED（FR-1.4/3.4）。
   *  幂等：已 terminal 时 no-op（不回退、不二次翻）。 */
  abort(reason: ClassifiedError): void;

  /** * → terminal(errored)：真实错误终止。error 为分类结果（非 ABORTED）。 */
  fail(error: ClassifiedError): void;
}
```

> **abort 不变量（FR-1.4，核心）**：`abort()` / `fail()` / `complete()` 内部若当前已是 terminal 则 no-op（幂等），否则强制迁移到对应 terminal 子态——**没有任何路径能让 phase 停在 active 后不落终态**。这把"每条中断分支都要记得翻 phase"的人工纪律，变成聚合根不变量。

### 3.3 TerminalReason — 终态归因

```ts
// domain/stream/terminal-reason.ts
export enum TerminalReasonCode {
  COMPLETED       = 'completed',        // 正常完成
  USER_ABORTED    = 'user_aborted',     // 用户点停止 → ErrorCode.ABORTED
  IDLE_TIMEOUT    = 'idle_timeout',     // 长时间无事件 → ErrorCode.TIMEOUT
  TOOL_TIMEOUT    = 'tool_timeout',     // 工具超时 → ErrorCode.PROCESS/TIMEOUT
  RUNTIME_ERROR   = 'runtime_error',    // Runtime 上游错误 → 对应真实 ErrorCode
  PROCESS_DIED    = 'process_died',     // Codex app-server 僵死/退出 → ErrorCode.PROCESS
}

export interface TerminalReason {
  readonly code: TerminalReasonCode;
  readonly classified?: ClassifiedError;  // 经 SK.ErrorClassifier 归一（含 ABORTED 独立类）；COMPLETED 正常完成无错误时省略，绝不造假 ClassifiedError（AC-9 反假数据）
}
```

> **FR-3.6 / AC-5（反例）**：`user_aborted`→`ABORTED`、`idle_timeout`→`TIMEOUT`、`tool_timeout`→`PROCESS/TIMEOUT`、`process_died`→`PROCESS`——归类不同，UI 据 `ClassifiedError.code` 区分"我停的" vs "超时" vs "出错"，`ABORTED` 不显示成"出错了"（S5）。

### 3.4 TurnArtifacts — 累积产物值对象

```ts
// domain/stream/turn-artifacts.ts
export interface TurnArtifacts {
  readonly text: string;
  readonly thinking: string;
  readonly toolUses: ReadonlyArray<ToolUseInfo>;
  readonly toolResults: ReadonlyArray<ToolResultInfo>;
}

/**
 * 终态时把产物投影成落 C1 的内容块 JSON（对齐现有 buildFinalMessageContent）：
 *   纯文本 → 返回 text；含 thinking/tool → blocks[]；全空 → null（空回合不落库，FR-2.6）。
 * 孤儿 tool_result（无匹配 tool_use）也作为独立块保留。
 */
export function buildFinalContent(artifacts: TurnArtifacts): string | null;
```

### 3.5 AgentStreamEvent — 统一事件模型

```ts
// domain/event/agent-stream-event.ts
export type AgentStreamEvent =
  | { readonly type: 'text';        readonly text: string }              // 累积后的全文
  | { readonly type: 'thinking';    readonly delta: string }
  | { readonly type: 'tool_use';    readonly tool: ToolUseInfo }
  | { readonly type: 'tool_result'; readonly result: ToolResultInfo }
  | { readonly type: 'tool_output'; readonly data: string }              // 工具实时输出
  | { readonly type: 'status';      readonly text: string }
  | { readonly type: 'result';      readonly tokenUsage?: TokenUsage; readonly terminalReason?: TerminalReasonCode }
  | { readonly type: 'error';       readonly error: ClassifiedError }
  | { readonly type: 'permission_request';  readonly request: PermissionRequest }
  | { readonly type: 'permission_resolved'; readonly permissionRequestId: string; readonly status: 'allow' | 'deny' }
  | { readonly type: 'context_usage'; readonly usage: ContextUsage }
  | { readonly type: 'rate_limit';    readonly info: RateLimitInfo }
  | { readonly type: 'file_changed';  readonly paths: ReadonlyArray<string> }
  | { readonly type: 'phase_changed'; readonly phase: StreamPhase };     // C2 内部产出，非 Runtime 归一
```

> **FR-4.2/4.3**：`text`…`file_changed`（13 类）由各 Runtime 的 `EventMapper` 从原生事件归一（对齐现有 `consumeSSEStream` 的 `onText`/`onThinking`/…回调）；`phase_changed` 由 C2 核心在相位迁移时产出，不来自 Runtime。Mapper 遇未识别原生事件按规则降级（丢弃/包 raw），不伪造、不改变已识别语义。

### 3.6 RuntimeKind 与可用性

```ts
// domain/runtime/runtime-kind.ts
export enum RuntimeKind { CLAUDE_SDK = 'claude-sdk', NATIVE = 'native', CODEX = 'codex' }

// domain/runtime/runtime-availability.ts
export type RuntimeAvailability =
  | { readonly kind: 'ready';        readonly version?: string }
  | { readonly kind: 'unavailable';  readonly reason: string }   // 探测失败，不显假 ready
  | { readonly kind: 'unknown' };
```

## 4. 驱动端口 (Driving Ports)

### 4.1 StartStreamUseCase

```ts
// ports/driving/start-stream-usecase.ts
export interface StartStreamInput {
  sessionId: string;                    // C1 会话 id
  content: string;
  mode: string;                         // code/plan/ask
  model: string;
  providerId: string;                   // → 经 C7.ProviderRepository 解析协议/auth
  files?: ReadonlyArray<FileAttachmentRef>;
  mentions?: ReadonlyArray<MentionRef>;
  systemPromptAppend?: string;
  effort?: string;                      // low/medium/high/max（Runtime 支持时）
  thinking?: { type: string; budgetTokens?: number };
  context1m?: boolean;
  selectedSkills?: ReadonlyArray<string>;
  autoTrigger?: boolean;                // assistant 自动触发：跳过存 user 消息/标题
}

export interface StartStreamResult {
  streamId: StreamSessionId;
  events: AsyncIterable<AgentStreamEvent>;   // 归一后的事件流；订阅式亦可
}

export interface StartStreamUseCase {
  /**
   * 发起一次回合：
   *  1. 若该 sessionId 已有 active 回合 → 先 abort 旧回合（FR-2.4 / AC-11）。
   *  2. 经 C7.ProviderRepository 解析 providerId → 选 RuntimeKind（FR-2.2）。
   *  3. 经 C1.GetSessionHistoryUseCase.getPromptView 拿喂模型历史（FR-2.3）。
   *  4. 创建 StreamSession(phase=active)，注册进 registry，调 AgentRuntimePort.run。
   *  5. 消费归一事件 → session.apply；终态时 complete/abort/fail + 落 C1（FR-2.5/2.6）。
   */
  start(input: StartStreamInput): Promise<StartStreamResult>;
}
```

### 4.2 AbortStreamUseCase

```ts
// ports/driving/abort-stream-usecase.ts
export interface AbortStreamUseCase {
  /**
   * 中断一次回合（FR-3）。若 phase 非 active → 幂等返回（FR-3.1）。
   * 否则：
   *  1. **无条件先行**安排 force-abort 安全网（FR-3.2 / AC-4）——绝不排在 interrupt 之后。
   *  2. session.markSettling()。
   *  3. best-effort 优雅 interrupt（经 AgentRuntimePort.interrupt，通知关闭 turn/thread/Query，FR-3.5）。
   *  4. interrupt 返回权威 runtimeStatus → reconcilePhase 收敛（FR-3.3）。
   *  5. force-abort 到期若仍 active → session.abort(ABORTED)（FR-1.4）。
   */
  abort(streamId: StreamSessionId): Promise<void>;
}
```

> **AbortStreamService 编排（对齐现有 `stopStreamWith`，GitHub #578 修复的结构化沉淀）**：

```ts
// usecases/abort-stream.ts（编排要点，非完整实现）
function abort(streamId): Promise<void> {
  const session = registry.get(streamId);
  if (!session || !isActive(session.snapshot().phase)) return;   // FR-3.1 幂等

  // 1) 安全网 FIRST —— 独立于且早于 interrupt 请求（FR-3.2）
  clock-based-timeout(FORCE_ABORT_MS, () => {
    if (isActive(session.snapshot().phase)) {
      session.abort(errorClassifier.classify(new AbortError()));   // → ABORTED（FR-3.4）
      runtime.forceKillTurn(turnRef);                              // 兜底关闭（FR-3.5）
    }
  });

  session.markSettling();                                          // FR-1.5

  // 2) best-effort 优雅 interrupt —— 立即触发，其副作用同步发生（FR-3.3）
  Promise.resolve(runtime.interrupt(turnRef))
    .then((runtimeStatus) => {
      if (!isActive(session.snapshot().phase)) return;             // reader 可能已 settle
      const next = reconcilePhase(runtimeStatus, session.snapshot().phase);
      if (next && isTerminal(next)) session.complete-or-abort-per(next);  // I4 收敛
    })
    .catch(() => { /* interrupt 失败/超时 —— force-abort 网兜底（这正是 #578） */ });
}
```

### 4.3 TitleGenerator（供 C1）

```ts
// ports/driving/title-generator.ts
export interface TitleGenerationInput {
  sessionId: string;
  recentMessages: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
}
export interface TitleGenerator {
  /** 非流式一次性生成标题字符串（FR-6）。不创建用户可见 StreamSession、
   *  不影响 composer gate（FR-6.3 / AC-13）。失败可抛，由 C1 用例降级（C1 FR-2.4）。 */
  generateTitle(input: TitleGenerationInput): Promise<string>;
}
```
- **契约来源**：边界契约 `C2 对外提供端口：TitleGenerator（供 C1）`，引用图 `C2.TitleGenerator ← C1`。C1 只 `import type` 此接口。

## 5. 出站端口 (Driven Ports)

### 5.1 AgentRuntimePort（C2 自有；供 C3 复用）

```ts
// ports/driven/agent-runtime-port.ts
export interface RuntimeRunRequest {
  streamId: StreamSessionId;
  runtimeKind: RuntimeKind;
  resolvedProvider: ResolvedProviderView;   // 只读，来自 C7（endpoint/auth/model）
  promptView: ReadonlyArray<PromptMessage>;  // 来自 C1.getPromptView
  content: string;
  options: RuntimeRunOptions;                // mode/model/effort/thinking/skills 等
  abortSignal: AbortSignalLike;
}

export interface TurnRef { readonly streamId: StreamSessionId; readonly native?: unknown; }

export interface AgentRuntimePort {
  /** 发起一次原生调用，产出**归一后**的 AgentStreamEvent 流（EventMapper 在适配器内）。 */
  run(request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent>;
  /** 优雅中断，返回 Runtime 权威状态（供 reconcilePhase）；关闭 turn/thread/Query（FR-3.5）。 */
  interrupt(turnRef: TurnRef): Promise<string | null>;
  /** 强制关闭 turn（force-abort 网兜底调用）。 */
  forceKillTurn(turnRef: TurnRef): void;
  /** 非 spawn 的可用性探测（Codex 探 binary/版本，不启进程）。 */
  availability(): Promise<RuntimeAvailability>;
}
```
- **实现位置**：三个适配器 `ClaudeSdkRuntimeAdapter` / `NativeRuntimeAdapter` / `CodexRuntimeAdapter`（见第 7 节）。
- **供 C3 复用**：引用图 `C2.AgentRuntimePort ← C3`。C3 `imports: [AgentRuntimeModule]` 后注入本端口发起子 agent AI 调用，C2 不感知子 agent。

### 5.2 C1 用例端口（本地 import type 别名）

```ts
// ports/driven/conversation-ports.ts
// C2 仅引用 C1 定义的用例端口类型；实现由 C1 Module 提供并注入。
import type { AppendMessageUseCase, GetSessionHistoryUseCase } from '<c1-package>';
export type { AppendMessageUseCase, GetSessionHistoryUseCase };
```
- **契约来源**：C2「回合产物落库经 C1 用例」；引用图 `C1 会话用例 ← C2`（C2 是 C1 用例的消费者）。C2 **只经用例**写会话/消息，不持有 Repository 直写路径（对齐 C1 AC-13）。

### 5.3 C7 ProviderRepository（本地只读 import type 别名）

```ts
// ports/driven/provider-read-port.ts
import type { ProviderRepository } from '<c7-package>';
export type { ProviderRepository };   // C2 只读消费：解析 providerId → 协议/endpoint/auth/model
```
- **契约来源**：引用图 `C7.ProviderRepository → C2 消费`；C7 architecture 明确 "ProviderRepository 供 C2 import 消费，写操作回 ConfigureProviderUseCase"。C2 只读，不写 Provider。

## 6. 用例编排要点

- **6.1 StartStreamService.start** —— `streamId←IdGenerator.next()`、`startedAt←Clock.now()`；若 registry 已有该 sessionId 的 active 回合先 `abort`（FR-2.4）；经 `ProviderRepository` 解析 `providerId` → 定 `runtimeKind`（FR-2.2）；经 `GetSessionHistoryUseCase.getPromptView` 拿历史投影（FR-2.3）；`new StreamSession(active)` 注册进 registry；订阅 `AgentRuntimePort.run` 的归一事件流 → 每个事件 `session.apply(event)` + 转发给驱动适配器（SSE）。
- **6.2 事件消费与终态** —— 流正常结束 → `session.complete(tokenUsage)`；`abortSignal` 触发 → `session.abort(ABORTED)`；上游 error 事件 → `session.fail(classified)`；idle/tool timeout → `session.abort/fail` 按 `TerminalReason` 归因（FR-3.6）。终态后经 `buildFinalContent(artifacts)` 若非 null 且非 autoTrigger → `C1.AppendMessageUseCase.append`（FR-2.5/2.6）。
- **6.3 AbortStreamService.abort** —— 见 4.2 编排：**force-abort 无条件先行** → `markSettling` → best-effort interrupt → `reconcilePhase` 收敛。这是 GitHub #578 的结构化沉淀：interrupt 挂起时 phase 仍经 force-abort 翻终态，`canAccept()` 立刻 true（AC-2/AC-4）。
- **6.4 终态 → C1 持久 StreamStatus 映射（NFR-8 / AC-12）** —— `terminal(completed)` → `updateStreamStatus(msgId, 'completed', tokenUsage)`；`terminal(aborted)` → `'interrupted'`；`terminal(errored)` → `'error'`。C2 只经 `C1.AppendMessageUseCase.updateStreamStatus` 端口写回，**不传 phase 本身**，不直写库。
- **6.5 GenerateTitleService.generateTitle** —— 用轻量非流式 Runtime 调用生成标题字符串；**不创建 StreamSession、不进 registry、不影响 canAccept**（FR-6.3）；失败抛出交 C1 降级。
- **6.6 权限中转（FR-7）** —— Runtime 的权限请求经 EventMapper 归一成 `permission_request` 事件对外发；上层（经 C5 经纪）的决议经驱动端口回传 → 转发 `AgentRuntimePort` 对应适配器。C2 **不做**经纪判定。
- 所有用户可见文案用 `c2.*` messageKey，渲染交 `SK.TranslationPort`；错误文案 key 来自 `SK.ErrorClassifier` 的 `messageKey`；关键路径经 `SK.RuntimeLog`（source=`c2.stream`/`c2.runtime.codex` 等）。

## 7. 被驱动适配器（apps/api，隔离 SDK/进程/HTTP）

> 核心零框架；下列适配器实现 `AgentRuntimePort`，各带一个 `EventMapper` 把原生事件归一成 `AgentStreamEvent`（FR-4.2）。核心 `StreamSession`/用例代码**不出现** `@anthropic-ai/*`/`child_process`/`codex`/HTTP SSE 细节（NFR-1 / AC-14）。

### 7.1 ClaudeSdkRuntimeAdapter
- 封装 `@anthropic-ai/claude-agent-sdk` 的 `Query` 句柄（对齐 `claude-client.ts` + `conversation-registry.ts`）。
- **句柄注册 + lockId 归属**：`run` 时以 `lockId` 注册 `Query`；`interrupt` 组合 `abortConversation(reason)` + `Query.interrupt()`（对齐现有 `abortConversation`：先 abort application-owned signal 再发优雅 interrupt）。**late-unregister（旧 lockId）为 no-op**，超越turn的 teardown 不能 evict 新 turn 的句柄（AC-6）。
- `ClaudeSdkEventMapper`：SDK message → `AgentStreamEvent`（text/thinking/tool_use/tool_result/permission_request/result 等）。
- **运行时模型配置（query() 的 `options.env`）**：本机集成/E2E 统一走 litellm 网关，模型路由到 `Jereh-Kimi-K2.6`。适配器调用 `query()` 时，把下列 env 注入 `options.env`（值的单一真相源是 `apps/api/.env`，模板见入库的 `apps/api/.env.example`）：`ANTHROPIC_BASE_URL=https://litellm.jereh.cn`、`ANTHROPIC_MODEL`/`CLAUDE_CODE_SUBAGENT_MODEL`/`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL=Jereh-Kimi-K2.6`、`ANTHROPIC_AUTH_TOKEN`（密钥，只在 `.env`）、`CLAUDE_CODE_WORKFLOWS=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。
  - **边界**：这些 env 由 apps/api 适配层在运行时读取并注入；核心包 `packages/core` 零框架、禁 `@anthropic-ai/*`、禁读 `process.env`（`scripts/check-core-imports.mjs` 守卫）。
  - **注意**：`.env` 已被 `.gitignore` 排除，`ANTHROPIC_AUTH_TOKEN` 绝不入库/回显。此 env 供 SDK query 与 E2E **运行时**读取，**不注入 workflow 子代理**（子代理继承会话模型）。

### 7.2 NativeRuntimeAdapter
- 封装 Native HTTP provider 的 SSE 流（`fetch` + `AbortController`）。
- `interrupt` = `abortController.abort()` + 读取响应权威状态（若有）。
- `NativeSseEventMapper`：SSE 帧 → `AgentStreamEvent`。

### 7.3 CodexRuntimeAdapter（进程复杂度全隔离在此，FR-5.4 / AC-10）
- 封装 `CodexAppServerManager`（对齐 `codex/app-server-manager.ts`）：
  - **binary 发现**：PATH 遍历 + macOS bundle；多候选**探 `--version` 选最新**（防旧 Homebrew codex 影子新 Codex.app，P0.1）。
  - **spawn**：Windows `.cmd`/`.bat` shim 经 `cmd.exe /d /s /c`（防 spawn EINVAL）；`windowsHide`；proxy-safe env。
  - **fatal config stderr 快失败**：`Failed to deserialize overridden config` / `unknown variant`+config 上下文 → 立即 `fireClose` + `SIGKILL`，**不等 30s linger**（P0.2 / AC-10）。
  - **僵死/退出**：`proc.once('exit')` → 归 `ErrorCode.PROCESS`（`process_died`）；`onClose` 拒绝所有 pending RPC（避免 30s RPC timeout 卡死）。
  - **中断关 turn/thread**：`interrupt` 关闭对应 thread/turn（对齐 CLAUDE.md 优先排查方向第 4 点，防残留）。
  - **dispose**：app exit 时优雅关闭避免 orphan 进程。
- `CodexEventMapper`：Codex JSON-RPC 通知（item lifecycle / fs.changed / auto-review 等）→ `AgentStreamEvent`（含 `file_changed`）。
- **关键纪律**：以上进程级复杂度**全部锁在此适配器内**，任一 Codex 进程病（fatal config / spawn 失败 / 僵死）都 fail-fast 归一成 `ClassifiedError`，**不卡死 C2 核心的回合生命周期，不污染另外两个 Runtime**（NFR-4）。

## 8. 依赖注入接线 (NestJS 侧)

```
AgentRuntimeModule (apps/api)
  imports: [SharedKernelModule,          // ErrorClassifier/Clock/IdGenerator/RuntimeLog/TranslationPort
            ProviderManagementModule,    // 注入只读 C7.ProviderRepository
            forwardRef(() => ConversationModule)]  // C1 用例端口；forwardRef 打破 C1↔C2 环
  provides:
    StartStreamUseCase   → StartStreamService(AgentRuntimePort(多实现路由), ProviderRepository,
                                              GetSessionHistoryUseCase, AppendMessageUseCase,
                                              StreamSessionRegistry, ErrorClassifier, Clock, IdGenerator, RuntimeLog)
    AbortStreamUseCase   → AbortStreamService(AgentRuntimePort, StreamSessionRegistry, ErrorClassifier, Clock, RuntimeLog)
    TitleGenerator       → GenerateTitleService(AgentRuntimePort(轻量非流式), ProviderRepository)
    AgentRuntimePort     → RuntimeRouter([ClaudeSdkRuntimeAdapter, NativeRuntimeAdapter, CodexRuntimeAdapter])
                            // 按 RuntimeKind 路由到对应适配器；各适配器内含其 EventMapper
    StreamSessionRegistry→ InMemoryStreamSessionRegistry   // 内存态，非持久层（NFR-2）
  exports:
    StartStreamUseCase, AbortStreamUseCase,
    TitleGenerator,       // 供 C1 import（forwardRef 另一侧）
    AgentRuntimePort      // 供 C3 import 复用
  controllers:
    ChatController      (POST /api/chat 发起回合 → SSE 流; POST /api/chat/interrupt 中断)
    PermissionController(POST /api/chat/permission 决议回传中转)
    RuntimeController   (GET /api/runtime/availability Runtime 可用性)
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。**C1↔C2 环处理**：C1 依赖 `C2.TitleGenerator`，C2 依赖 `C1.AppendMessageUseCase`/`GetSessionHistoryUseCase`——用 NestJS `forwardRef` 在**两侧** Module 打破循环（C1 侧 `imports: [forwardRef(() => AgentRuntimeModule)]`、C2 侧 `imports: [forwardRef(() => ConversationModule)]`），核心包之间仍只经接口单向 `import type`，无实现级环。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `SK.ErrorClassifier` | C2 依赖 SK | context-boundaries.md：C2「依赖端口：SK.ErrorClassifier」；SK 端口清单含 ErrorClassifier（含 `ABORTED` 独立类） |
| `SK.Clock`/`IdGenerator`/`RuntimeLog`/`TranslationPort` | C2 依赖 SK（横切） | SK 对外端口清单（横切全上下文） |
| `StartStreamUseCase` / `AbortStreamUseCase` | C2 对外提供 | C2「对外提供端口：StartStreamUseCase、AbortStreamUseCase」 |
| `AgentRuntimePort` | C2 对外提供 → C3 消费 | C2「对外提供端口：AgentRuntimePort（供 C3 复用）」+ 引用图 `C2.AgentRuntimePort ← C3` |
| `TitleGenerator` | C2 对外提供 → C1 消费 | C2「对外提供端口：TitleGenerator（供 C1）」+ 引用图 `C2.TitleGenerator ← C1` |
| `C1.AppendMessageUseCase` / `GetSessionHistoryUseCase` | C2 依赖 C1 | C1「对外提供端口」；引用图 `C1 会话用例 ← C2`（C2 经用例读写会话/消息） |
| `C7.ProviderRepository` | C2 依赖 C7（只读） | 引用图 `C7.ProviderRepository → C2 消费`；C7 architecture「供 C2 import 消费」 |

**边界纪律自检**：
- C2 未定义/未重写任何 SK 概念（ErrorClassifier/Clock/IdGenerator 只引用）；未定义 C1 的会话/消息实体、未定义 C7 的 Provider 概念，只 `import type` 其端口。
- C2 核心**不含**会话/消息持久化（`chat_sessions`/`messages` SQL）、子 agent（logical run/attempt/RunPhase）、Provider 配置管理、权限经纪判定、MCP 注册；持久 `StreamStatus` 不在 C2 建模，只经 `C1.AppendMessageUseCase` 端口写回（NFR-2）。
- C2 核心不 import `@anthropic-ai/*` / `better-sqlite3` / `@nestjs/*` / `node:child_process` / codex SDK；SDK/进程/HTTP 全在适配器（NFR-1 / AC-14）。
- `StreamPhase` 是实时内存态、不落库、不与 C1 持久 `StreamStatus` 混用（NFR-2 / AC-15）——切断 stop/abort 卡死误用根因。
- 无实现级循环依赖：C1↔C2 双向经 NestJS `forwardRef` 在接线层解，核心包只单向 `import type`。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，无 dev server / 无真实 SDK-进程-网络）：
  - `canTransitionPhase` 合法/非法迁移全矩阵单测（AC-1）；`StreamSession` 迁移方法幂等性（terminal 后 no-op）。
  - **abort 卡死回归（AC-2，核心反例 smoke）**：假 `AgentRuntimePort.interrupt` 返回**永不 resolve** 的 Promise，用假 Clock 推进 force-abort 定时器，断言 `abort` 后 `phase = terminal(aborted)`、`canAccept()=true`（复现 GitHub #578）。
  - `canAccept()` ≡ `phase !== active` 全态断言（AC-3）；静态断言核心内无散落 `phase==='active'` 被 gate 复用。
  - force-abort 先行（AC-4）：spy 断言 `scheduleForceAbort` 早于 `requestInterrupt`，interrupt 抛错时 force-abort 仍已安排。
  - 归因分类（AC-5，反例）：user_aborted→ABORTED、idle_timeout→TIMEOUT、tool_timeout→PROCESS/TIMEOUT 三路 `ClassifiedError.code` 不同。
  - `abort` 通知适配器关 turn/句柄（AC-6，假适配器 spy）；ClaudeCode late-unregister no-op。
  - `buildFinalContent`：text-only/thinking-only/tool-only/mixed/orphan-result 五种 + 全空返回 null（FR-2.6）。
- EventMapper 表驱动（AC-7/8）：录制三 Runtime 原生事件样本 → 归一成等价 `AgentStreamEvent` 序列；同一逻辑事件跨 Runtime 结构一致；未知原生事件降级不抛。
- 反假数据 smoke（AC-9）：Runtime 未上报 tokenUsage → `result` 事件字段空、落 C1 留空、断言 UI 无假 0。
- 终态映射（AC-12）：completed/aborted/errored → C1 的 completed/interrupted/error，假 `AppendMessageUseCase` 断言只经端口写、无直写库、无 phase 泄漏。
- TitleGenerator 隔离（AC-13）：调用不创建 StreamSession、不进 registry、不影响 canAccept。
- Codex 隔离（AC-10）：fatal config stderr 触发 fail-fast（不等 30s）单测；核心包 `child_process`/`codex`/`@anthropic-ai/*` 0 命中扫描。
- 静态检查（AC-14/15）：`agent-runtime/` 核心包禁用 import 扫描 + phase 不入持久化路径 + 不 import C1 `StreamStatus` 做实时判断。
