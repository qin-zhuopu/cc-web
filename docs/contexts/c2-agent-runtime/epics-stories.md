---
title: 史诗与故事 — C2 AgentRuntime 智能体运行时
context: C2 · AgentRuntime
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C2 · AgentRuntime（智能体运行时）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C2 核心包（domain + ports），零框架 | FR-1~7 的类型基础、NFR-1/2 |
| E2 StreamSession phase 状态机 | phase 不变量 + canAccept + abort 保证翻终态 | FR-1 |
| E3 AgentStreamEvent 事件模型 | 14 类统一事件 + 累积产物 + 终态投影 | FR-4 |
| E4 发起回合 StartStream | Runtime 选择 + 历史投影 + 事件消费 + 落 C1 | FR-2 |
| E5 中断回合 AbortStream | force-abort 先行 + reconcile + 关 turn（#578 切断） | FR-3 |
| E6 三 Runtime 适配器 + EventMapper | ClaudeSDK / Native / Codex 隔离归一 | FR-5、FR-4.2 |
| E7 TitleGenerator + 权限中转 + 接线 | 供 C1 标题、权限事件中转、NestJS Module + forwardRef | FR-6、FR-7、DI |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `StreamPhase`（`active`/`settling`/`terminal` + `TerminalSubstate`）与 `StreamSessionId`。**AC**：三相位 + 三终态子态类型完整。（FR-1.1/1.2）
- **S1.2** 定义 `canTransitionPhase` 合法迁移谓词 + `reconcilePhase`。**AC-1**：`active→settling→terminal` 合法、`terminal→*` 非法。（FR-1.3/3.3）
- **S1.3** 定义 `TerminalReason`（含 6 类归因码）+ 与 `SK.ErrorClassifier` 的映射约定。**AC-5**：user_aborted→ABORTED、idle/tool timeout 归类不同。（FR-3.6）
- **S1.4** 定义 `TurnArtifacts` 值对象 + `buildFinalContent`（text/thinking/tool/orphan/全空→null）。**AC**：五路投影 + 空回合返回 null。（FR-2.6 / FR-4）
- **S1.5** 定义 `AgentStreamEvent` 联合（14 类）+ `ToolUseInfo`/`ToolResultInfo`/`TokenUsage`/`ContextUsage`。**AC**：事件类型完整，usage 只存投影不算。（FR-4.1 / 0 反假数据）
- **S1.6** 定义 `RuntimeKind`/`RuntimeAvailability`；定义驱动端口（StartStream/AbortStream/TitleGenerator）与出站端口（AgentRuntimePort）+ `import type` 引用 C1 用例端口、C7 ProviderRepository。**AC**：`index.ts` 只导出端口与领域类型。（FR-2/3/5/6）
- **S1.7** 建立禁用 import 静态扫描。**AC-14**：`agent-runtime/` 对 `@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`Date.now`/`randomUUID` 0 命中。（NFR-1）
- **S1.8** 定义 C2 message-keys（`c2.*`，状态/错误/中断提示）。**AC**：用户可见文案经 key + `SK.TranslationPort`，错误 key 复用 `SK.ErrorClassifier.messageKey`。（NFR-7）

## E2 · StreamSession phase 状态机（领域不变量核心）

- **S2.1** 实现 `StreamSession` 聚合根 + `snapshot()`；phase 只能经领域方法迁移（外部不可直接赋值）。**AC-1**：非法迁移抛/拒绝。（FR-1.2）
- **S2.2** 实现 `markSettling`/`complete`/`abort`/`fail` 四个迁移方法，各自内部 `canTransitionPhase` 校验 + 幂等（terminal 后 no-op）。**AC-1**：迁移合法性 + 幂等断言。（FR-1.2/1.3/1.5）
- **S2.3** 实现 **abort 不变量**：任意 abort 路径后 phase ∈ terminal 子态，绝不停 active。**AC-2**：反例——注入 interrupt 永不 resolve，phase 仍翻 `terminal(aborted)`（复现 GitHub #578）。（FR-1.4）
- **S2.4** 实现 `canAccept()` ≡ `phase !== active`。**AC-3**：active→false、settling/terminal→true；静态断言 gate 唯一走此方法，核心无散落 `phase==='active'` 复用。（FR-1.6）
- **S2.5** 实现 `apply(event)` 把归一事件累积进 `TurnArtifacts`（不改 phase）。**AC**：text/thinking/tool 累积正确，孤儿 tool_result 保留。（FR-4 / FR-2.6 支撑）

## E3 · AgentStreamEvent 事件模型

- **S3.1** 落地 14 类 `AgentStreamEvent` + 值对象编解码。**AC-7**：事件结构稳定，跨 Runtime 归一目标一致。（FR-4.1）
- **S3.2** 定义 EventMapper 契约（原生事件 → AgentStreamEvent）+ 未知事件降级规则（丢弃/包 raw）。**AC-8**：未知原生事件降级不抛、不污染已识别事件。（FR-4.2/4.3）
- **S3.3** `result` 事件携带 tokenUsage 投影；无上报留空。**AC-9**：未上报 tokenUsage → 字段空、不填 0。（FR-4.4 / 0 反假数据）
- **S3.4** `phase_changed` 事件由核心相位迁移产出（非 Runtime 归一）。**AC**：迁移时对外发 phase_changed，来源为 C2 核心。（FR-4.1）

## E4 · 发起回合 StartStream

- **S4.1** 实现 `StartStreamService.start`：`streamId←IdGenerator`、`startedAt←Clock`，创建 `StreamSession(active)` 注册进 registry。**AC**：id/时间经 SK 注入，核心无 Date/uuid 直调。（FR-2.1 / NFR-1）
- **S4.2** Runtime 选择：经只读 `C7.ProviderRepository` 解析 `providerId` → `runtimeKind`，发起时锁定。**AC**：不同协议路由到不同 RuntimeKind。（FR-2.2）
- **S4.3** 历史投影：经 `C1.GetSessionHistoryUseCase.getPromptView` 拿喂模型历史，C2 不读 `messages` 表。**AC**：只经 C1 用例取历史。（FR-2.3）
- **S4.4** 单 active 约束：`start` 前若该 session 已有 active 回合先 `abort` 旧回合。**AC-11**：旧回合翻终态、新回合 active，同一 session 至多一个 active。（FR-2.4）
- **S4.5** 事件消费与终态：订阅 `AgentRuntimePort.run` 归一事件 → `session.apply`；正常结束→complete、abortSignal→abort、error→fail、timeout→按归因。**AC**：各终态路径断言 phase 正确。（FR-2.1 / FR-3.6）
- **S4.6** 落 C1：终态经 `buildFinalContent` 非 null 且非 autoTrigger → `C1.AppendMessageUseCase.append`；空回合不落。**AC-12**：只经用例写、无直写库；空回合无 assistant 消息。（FR-2.5/2.6）

## E5 · 中断回合 AbortStream（GitHub #578 结构化切断）

- **S5.1** 实现 `AbortStreamService.abort`：phase 非 active 幂等返回。**AC**：无活跃回合 abort 为 no-op。（FR-3.1）
- **S5.2** **force-abort 安全网无条件先行**：先安排 force-abort 定时器（经 SK.Clock），再发 interrupt；绝不排在 interrupt 的 `.finally`/`.then` 后。**AC-4**：spy 断言 `scheduleForceAbort` 早于 `requestInterrupt`，interrupt 抛错时 force-abort 仍已安排。（FR-3.2）
- **S5.3** best-effort 优雅 interrupt + `reconcilePhase` 收敛：interrupt 返回权威 runtimeStatus，terminal 则微任务收敛，running/unknown 不纠正。**AC-2**：interrupt 永不 resolve 时 force-abort 兜底翻终态。（FR-3.3）
- **S5.4** abort 归 `ABORTED` 独立类（经 `SK.ErrorClassifier`），phase 落 `terminal(aborted)`。**AC-5**：abort 与真实错误 `ClassifiedError.code` 不同。（FR-3.4）
- **S5.5** abort 通知适配器关 turn/thread/Query 句柄（防残留导致下一轮语义错乱）。**AC-6**：假适配器断言 `interrupt`/`forceKillTurn`/句柄注销被调；ClaudeCode late-unregister no-op。（FR-3.5）
- **S5.6** idle-timeout / tool-timeout 走 abort 路径翻终态但归因不同（TIMEOUT/PROCESS）。**AC-5**：三路归类断言不同。（FR-3.6）

## E6 · 三 Runtime 适配器 + EventMapper

- **S6.1** `ClaudeSdkRuntimeAdapter` + `ClaudeSdkEventMapper`：封装 `Query` 句柄 + `lockId` 归属 + `abortConversation`+`Query.interrupt` 组合中断。**AC-6/7**：SDK 事件归一等价、late-unregister no-op。（FR-5.2）
  - **运行时模型配置**：`query()` 的 `options.env` 从 `apps/api/.env`（模板 `apps/api/.env.example`）读取——litellm 网关 `ANTHROPIC_BASE_URL=https://litellm.jereh.cn`、模型 `Jereh-Kimi-K2.6`、密钥 `ANTHROPIC_AUTH_TOKEN`（只在 `.env`，不入库）。详见 architecture.md §7.1。集成/E2E 测试运行时同源读取，不注入 workflow 子代理。
- **S6.2** `NativeRuntimeAdapter` + `NativeSseEventMapper`：HTTP SSE 流 + `AbortController` 中断。**AC-7**：SSE 帧归一等价。（FR-5.3）
- **S6.3** `CodexRuntimeAdapter` 进程管理隔离：binary 发现（多候选选最新）/ Windows `.cmd` shim 经 cmd.exe / spawn / dispose orphan 规避。**AC-10**：核心包 `child_process`/`codex` 0 命中。（FR-5.4）
- **S6.4** Codex fatal config stderr 快失败：签名命中→`fireClose`+`SIGKILL`，不等 30s linger；`onClose` 拒 pending RPC。**AC-10**：fail-fast 单测（不等 30s）。（FR-5.4 / NFR-4）
- **S6.5** `CodexEventMapper`：JSON-RPC 通知（item lifecycle / fs.changed / auto-review）→ AgentStreamEvent（含 file_changed）。**AC-7**：Codex 事件归一等价。（FR-4.2）
- **S6.6** `RuntimeRouter` 按 `RuntimeKind` 路由到三适配器之一，实现 `AgentRuntimePort`；`availability()` 非 spawn 探测。**AC**：路由正确、可用性探测不启进程。（FR-5.1）
- **S6.7** 故障隔离：任一 Runtime 进程病 fail-fast 归 `ClassifiedError`，不阻塞其他 Runtime、不卡死核心。**AC-10**：Codex 病态不影响 ClaudeSDK/Native。（NFR-4）

## E7 · TitleGenerator + 权限中转 + 接线

- **S7.1** 实现 `GenerateTitleService.generateTitle`：非流式一次性调用，不创建 StreamSession、不进 registry、不影响 canAccept。**AC-13**：不影响 gate；失败可抛供 C1 降级。（FR-6）
- **S7.2** 权限事件产出：Runtime 权限请求归一成 `permission_request` 事件对外发。**AC**：携带 permissionRequestId/工具名/输入/token。（FR-7.1）
- **S7.3** 决议中转：接收上层（经 C5 经纪）决议回传，转发对应适配器；C2 不做经纪判定。**AC**：忠实中转、无经纪逻辑。（FR-7.2/7.3）
- **S7.4** `AgentRuntimeModule`：imports SharedKernelModule + ProviderManagementModule + `forwardRef(ConversationModule)`；provides/exports 用例端口 + AgentRuntimePort（供 C3）+ TitleGenerator（供 C1）。**AC**：C1↔C2 环经 forwardRef 解，核心包仅单向 import type。（DI 章节）
- **S7.5** 驱动适配器：`ChatController`（POST /api/chat SSE + interrupt）/ `PermissionController` / `RuntimeController`。**AC**：用户可见状态字段带 source breadcrumb（phase/canAccept/ABORTED/tokenUsage）。
- **S7.6** 终态→C1 StreamStatus 映射：completed/aborted/errored → completed/interrupted/error，经 `updateStreamStatus`，不传 phase、不直写库。**AC-12/15**：无"C2 完成 C1 存 streaming"漂移；phase 不入持久化路径。（NFR-8 / NFR-2）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S1.2, S2.1, S2.2 |
| AC-2 | S2.3, S5.3 |
| AC-3 | S2.4 |
| AC-4 | S5.2 |
| AC-5 | S1.3, S5.4, S5.6 |
| AC-6 | S5.5, S6.1 |
| AC-7 | S3.1, S6.1, S6.2, S6.5 |
| AC-8 | S3.2 |
| AC-9 | S3.3 |
| AC-10 | S6.3, S6.4, S6.7 |
| AC-11 | S4.4 |
| AC-12 | S4.6, S7.6 |
| AC-13 | S7.1 |
| AC-14 | S1.7 |
| AC-15 | S7.6 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + phase 状态机 + 事件模型）**：E1 全部、E2 全部、E3 全部。产出零框架 C2 核心骨架 + phase 不变量 + `canAccept` + abort 保证翻终态 + AgentStreamEvent + 单测（含 #578 反例回归）。
- **Sprint 2（发起 + 中断用例）**：E4 全部、E5 全部。产出 StartStream/AbortStream 用例 + force-abort 先行 + reconcile + 关 turn，用假 `AgentRuntimePort`/假 Clock 跑通 #578 反例 smoke。
- **Sprint 3（三适配器 + 接线）**：E6 全部、E7 全部。产出三 Runtime 适配器 + EventMapper（表驱动归一测试）+ Codex 进程隔离 + fail-fast + NestJS Module/Controller + forwardRef 解 C1↔C2 环 + 终态映射 C1。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，无需真实 SDK/进程/网络，用假 `AgentRuntimePort` + 假 Clock/IdGenerator + 假 C1 用例端口）。
- **abort 卡死回归通过（AC-2 核心反例）**：interrupt 永不 resolve 时 phase 仍翻 `terminal(aborted)`、`canAccept()=true`（GitHub #578 结构化切断）。
- 禁用 import 静态扫描 0 命中（AC-14）；phase 不入持久化路径、不与 C1 `StreamStatus` 混用（AC-15）；Codex 进程复杂度锁在 `CodexRuntimeAdapter`（AC-10）。
- 归因分类反例通过（AC-5：ABORTED vs TIMEOUT vs PROCESS）；无假 tokenUsage 0（AC-9）；终态→C1 映射无漂移（AC-12）。
- 跨上下文端口引用闭合：`C2.AgentRuntimePort ← C3`、`C2.TitleGenerator ← C1`、`C1 会话用例 ← C2`、`C7.ProviderRepository → C2 消费`；C1↔C2 环经 forwardRef 解。
