# 03 · c2-5 AbortStream 与 #578 编排层切断

## Epic 范围与存在理由

C2-E5「中断回合 AbortStream」——本 epic 是 **GitHub #578「点 stop/abort 后 composer 永久卡死」的编排层结构化切断**。

#578 根因：旧代码把「翻终态 abort」排进优雅 interrupt 的 `.finally`——interrupt 挂起（Runtime 无响应）→ `.finally` 永不执行 → phase 永停 active → canAccept 永 false → 输入框永久锁死。

c2-2 已在**聚合根层**落下安全网一半（`StreamSession.abort` 命令一到即无条件同步翻终态）。c2-5 补上**编排层**另一半：保证「force-abort 定时器无条件先行安排」这一时序不变量。

## 六能力

- CAP-1 ForceAbortScheduler 调度抽象端口
- CAP-2 幂等门 + force-abort 无条件先行 + markSettling
- CAP-3 best-effort interrupt + reconcilePhase 收敛 + #578 端到端回归
- CAP-4 force-abort 到期兜底（仍 active 则 abort(ABORTED) + forceKillTurn）
- CAP-5 关 turn/句柄通知 + late-unregister no-op 契约
- CAP-6 idle/tool timeout 归因区分

## 拆解前厘清的关键设计张力

拆解前先解决两个不动手就会翻车的问题：

1. **force-abort 定时器 vs 核心零框架**：架构 §4.2 写 `clock-based-timeout(FORCE_ABORT_MS, ...)`，但核心禁直调 `setTimeout`，且 AC-4 要求 `scheduleForceAbort` 可 spy。→ **决策**：新增可注入的 C2 driven port `ForceAbortScheduler.schedule(fn, delayMs): cancel`，生产用 setTimeout（属 c2-7）、测试用手动触发假件。
2. **TurnRef 来源**：`interrupt(turnRef)`/`forceKillTurn(turnRef)` 需 TurnRef，但 run 只返回事件流未回传句柄。→ **决策**：核心用 `{streamId}` 构造 TurnRef，native 句柄由适配器按 streamId 内部解析。

调查确认 SK.Clock 只有 `now()`（无 Timer/Scheduler），坐实需要新端口。

## 执行链路

1. **拆解**：读 architecture §4.2/§6.3、epics-stories S5.1~S5.6、reconcilePhase/AbortStreamUseCase 端口、ErrorClassifier（确认 AbortError→ABORTED、timeout→TIMEOUT、spawn→PROCESS 已实现）→ 产出 SPEC + stories（6 故事）。
2. **写 workflow** `wf-c2-5.mjs`：c2-5-1 scheduler 端口独立先行，c2-5-2~6 串行改同一 `abort-stream.ts`。
3. **启动** → 中途因**会话模型失效**部分失败 → resume 恢复（详见 04）。
4. **完成**：8 agent 全绿，Merge 报 584 测试、守卫扫 93 文件 0 命中（含 setTimeout/node:timers 铁律）、exit 0。

## #578 双层落地（本 epic 招牌）

- **聚合根层（c2-2）**：`StreamSession.abort` 无条件同步翻 terminal(aborted)。
- **编排层（c2-5）**：`abort()` 全程无 await——`registry.get` → `schedule`（安全网先行）→ `markSettling` → `void Promise.resolve(interrupt()).then/.catch`（fire-and-forget）。session.abort 与安全网安排**绝不**排进 interrupt 回调链，结构上锁死 #578。

**端到端回归（AC-2，真断言）**：假 interrupt 返回永不 resolve 的 Promise + 手动 fire force-abort 定时器 → 断言 `phase=terminal(aborted)`、`canAccept()=true`、`forceKillTurn` 被调。interrupt 永挂时 `abort()` 方法本身不挂起（不 await 永挂的 interrupt）。

## 评审 3 条 nitpick（全部记入 deferred-work，不擅改）

评审判「无阻断性缺陷」，3 条 nitpick 记入 `deferred-work.md`：

1. **【最值得留意】超时归因 terminalReason.code 误标 USER_ABORTED**：`settleTimeout` 复用 c2-2 聚合根的 `StreamSession.abort()`，而该方法硬编码 `TerminalReasonCode.USER_ABORTED`。于是 idle/tool 超时回合 `error.code` 正确（TIMEOUT/PROCESS），但 `terminalReason.code` 恒为 USER_ABORTED，与 `isUserAbort()` 语义矛盾。**根因在 c2-2 冻结的聚合根，超出 c2-5 范围，走 correct-course**（建议给聚合根加 `abort(reason, terminalReasonCode?)` 重载），不本 epic 擅改。
2. 注入的 SK.Clock 是死依赖（settledAt 由 StreamSession 自带 Clock 记）——构造注入以备后续，符合意图。
3. `settleTimeout` 是服务公有方法但未在 AbortStreamUseCase 端口声明——c2-7 接线若需从端口触发要补，属架构 loose end。

## 提交

断点 `220d711`。精准暂存 abort-stream + force-abort-scheduler + 测试 + epic-c2-5 产物 + wf + sprint-status + deferred-work，不含用户文档/package-lock 改动。
