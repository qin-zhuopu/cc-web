export const meta = {
  name: 'c2-5-abort-stream',
  description: 'C2-E5 中断回合 AbortStream（#578 切断）：串行 scheduler端口→幂等门+安全网先行→interrupt+reconcile+#578回归→到期兜底abort+forceKill→关句柄→超时归因，合并门禁再对抗评审',
  phases: [
    { title: 'SchedulerPort', detail: 'c2-5-1 ForceAbortScheduler 调度抽象端口' },
    { title: 'GuardAndSafetyNet', detail: 'c2-5-2 幂等门 + force-abort 无条件先行 + markSettling' },
    { title: 'InterruptReconcile', detail: 'c2-5-3 best-effort interrupt + reconcile + #578 端到端回归' },
    { title: 'ForceAbortExpiry', detail: 'c2-5-4 到期兜底 abort(ABORTED) + forceKillTurn' },
    { title: 'CloseHandle', detail: 'c2-5-5 关 turn/句柄通知契约' },
    { title: 'TimeoutAttribution', detail: 'c2-5-6 idle/tool timeout 归因区分' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审 #578先行/reconcile/兜底/归因/关句柄' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/agent-runtime/ 下实现 C2 的 AbortStream 中断用例编排 + force-abort 调度端口。C2 核心零框架依赖、纯逻辑。
先读权威源 docs/contexts/c2-agent-runtime/architecture.md §4.2（AbortStreamUseCase 编排：force-abort 无条件先行 → markSettling → best-effort interrupt → reconcilePhase 收敛 → 到期兜底）、§6.3（#578 结构化沉淀）、§8（DI 接线签名），读 _bmad-output/implementation-artifacts/epic-c2-5/SPEC.md 确认 CAP-1~6 契约、读 prd FR-3/NFR-3/AC-2/AC-4/AC-5/AC-6。

【本 epic 存在的核心理由 · #578】GitHub #578「点 stop/abort 后 composer 永久卡死」的根因：旧代码把「翻终态 abort」排进优雅 interrupt 的 .finally——interrupt 挂起（Runtime 无响应）→ .finally 永不执行 → phase 永停 active → canAccept 永 false → 输入框永久锁死。
本 epic 在【编排层】切断它：force-abort 安全网【无条件先行】安排（早于且独立于 interrupt），interrupt 挂起/抛错绝不阻塞相位翻转。绝不把 session.abort 或安全网安排排进 interrupt(...).then/.finally/.catch。

现状（C2-E1/E2/E3/E4 已完成，直接复用，绝不重定义/改签名）：
- ports/driving/abort-stream-usecase.ts：AbortStreamUseCase { abort(streamId: StreamSessionId): Promise<void> }（本 epic implements 它）。
- ports/driven/agent-runtime-port.ts：AgentRuntimePort.interrupt(turnRef): Promise<string|null>（返回权威 runtimeStatus）、forceKillTurn(turnRef): void、TurnRef { readonly streamId; readonly native? }。
- domain/stream/phase-transition.ts：reconcilePhase(runtimeStatus: string|null, current): StreamPhase|null（值 import；'idle'→terminal(completed)、'interrupted'→terminal(aborted)、'error'→terminal(errored)、'running'/null/未知→null 不纠正）、canTransitionPhase。
- domain/stream/stream-session.ts：StreamSession（值 import）：snapshot()、canAccept()、markSettling()、complete(tokenUsage?)、abort(reason:ClassifiedError)、fail(error:ClassifiedError)。abort 已无条件同步翻 terminal(aborted)、幂等（terminal 后 no-op）。
- domain/stream/stream-phase.ts：isActive/isTerminal/StreamPhaseKind/TerminalSubstate/StreamSessionId/StreamPhase（值 import 用 isActive/isTerminal/枚举）。
- domain/stream/terminal-reason.ts：TerminalReason/TerminalReasonCode（归因码，值 import）。
- usecases/stream-session-registry.ts：StreamSessionRegistry（c2-4，值 import）：get(streamId)/getActiveBySession/delete。AbortStream 经 registry.get(streamId) 取回合。
- SK：ports/error-classifier.ts（ErrorClassifier.classify(error:unknown):ClassifiedError；classifyByName 已实现 name='AbortError'+无 timeout 语义→ErrorCode.ABORTED、含 timeout 语义→TIMEOUT；message 含 spawn/child process/exited with code→PROCESS）、ports/clock.ts（Clock.now():number）、domain/error/classified-error.ts（ClassifiedError）、domain/error/error-code.ts（ErrorCode，含 ABORTED/TIMEOUT/PROCESS）。

本 epic 职责（只落纯逻辑用例编排 + 调度端口契约）：
- 新建 ports/driven/force-abort-scheduler.ts：ForceAbortScheduler { schedule(callback:()=>void, delayMs:number):()=>void }（返回 cancel）+ FORCE_ABORT_MS 常量。生产 setTimeout 实现属 c2-7，本 epic 只端口契约 + 假件测。
- 新建 usecases/abort-stream.ts：AbortStreamService implements AbortStreamUseCase，构造注入 AgentRuntimePort + StreamSessionRegistry + ForceAbortScheduler + SK.ErrorClassifier + SK.Clock（对齐 §8）。

核心包铁律（守卫会拦，扫 packages/core/src）：禁 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、child_process、codex、node:timers；禁直调 setTimeout/setInterval/Date.now()/new Date()/randomUUID（注释里也别连写 "Date.now("）。force-abort 延时经注入的 ForceAbortScheduler，取时经注入 Clock。
不接真实 Runtime 适配器的 interrupt/forceKillTurn/late-unregister（属 c2-6）、不写 scheduler 的 setTimeout 生产实现/不接 NestJS DI（属 c2-7）、不接 SDK/进程/HTTP、不实现真实 idle·tool 计时机制（属 c2-6，本 epic 只落「给定超时信号→正确归因翻终态」）。
turnRef 由核心以 { streamId } 构造，核心不持有/不解释 native 句柄。归因一律经 SK.ErrorClassifier.classify，绝不手拼 ClassifiedError 造假 code。复用 c2-2 聚合根/c2-1 reconcilePhase/terminal-reason，绝不重写迁移或归类。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import（StreamSession/reconcilePhase/isActive/isTerminal/枚举/TerminalReasonCode 等）正常 import + .js。字段 readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。假替身：假 AgentRuntimePort（可注入 interrupt 永挂/返回各 runtimeStatus/spy 调用序列、spy forceKillTurn）、假 ForceAbortScheduler（记录被安排、手动 fire、spy cancel）、Frozen/MutableClock、假 StreamSessionRegistry 或直接 new StreamSession + registry。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
完成后报告改/建的文件。
`

// ---- 波次1：调度端口 ----
phase('SchedulerPort')
const r1 = await agent(`${RULES}

任务 c2-5-1：定义 ForceAbortScheduler 调度抽象端口。对齐 SPEC CAP-1、architecture §4.2（clock-based-timeout）、AC-4。
新建 packages/core/src/agent-runtime/ports/driven/force-abort-scheduler.ts：
- 接口 ForceAbortScheduler { schedule(callback: () => void, delayMs: number): () => void }（返回 cancel 函数，调用即取消未到期的安排）。
- 定义 FORCE_ABORT_MS 常量（读 architecture §4.2 确认数值/语义；若文档未给定具体值，取合理默认如 5000 并注释说明可由构造覆盖）。
- 【核心零框架铁律】绝不 import node:timers、绝不直调 setTimeout/setInterval（守卫会拦）。本端口是「core 里安排延时且 AC-4 可 spy 先行」的抽象——生产用 setTimeout（属 c2-7 接线），测试用手动触发假件。注释写明生产实现归属 c2-7。
新建 force-abort-scheduler.test.ts：用最小假 scheduler 实现契约，断言 schedule 记录 callback/delayMs、可手动 fire 触发回调、cancel 后 fire 不再触发。
import type + .js；readonly；术语中文。不接 SDK/DI、不实现 setTimeout 生产实现。`,
  { label: 'c2-5-1:scheduler-port', phase: 'SchedulerPort' })

// ---- 波次2：幂等门 + 安全网先行 + markSettling ----
phase('GuardAndSafetyNet')
const r2 = await agent(`${RULES}

任务 c2-5-2：AbortStreamService 幂等门 + force-abort 无条件先行 + markSettling。对齐 SPEC CAP-2、architecture §4.2、FR-3.1/3.2/1.5、AC-4。
新建 packages/core/src/agent-runtime/usecases/abort-stream.ts：
- class AbortStreamService implements AbortStreamUseCase（c2-1 端口）。构造注入 AgentRuntimePort + StreamSessionRegistry + ForceAbortScheduler + SK.ErrorClassifier + SK.Clock（对齐 §8）。
- abort(streamId)：
  ① registry.get(streamId) 取 session；无 session 或 !isActive(session.snapshot().phase) → 幂等 return（FR-3.1，no-op，不安排安全网、不 interrupt、不 markSettling）。
  ② 【#578 时序铁律 · 最重要】无条件先行：scheduler.schedule(forceAbortCallback, FORCE_ABORT_MS) 安排 force-abort 安全网——【必须早于且独立于】任何 interrupt 调用，绝不把 session.abort 或 schedule 排进 interrupt(...) 的 .then/.finally/.catch。保存返回的 cancel 供后续 cancel。
  ③ session.markSettling()（FR-1.5）。
  本故事 forceAbortCallback 可先留占位（到期兜底逻辑 c2-5-4 补：仅先判 isActive 再占位/或空实现），interrupt 调用 c2-5-3 补——但【安排安全网的时序位置本故事就要正确】（先于 interrupt，即便 interrupt 还没写，也要把 schedule 放在方法里 markSettling 之前、且结构上不依赖 interrupt）。
- 复用 c2-2 markSettling、c2-1 isActive；绝不重写迁移。
- classifyAbort 辅助：构造 name='AbortError' 的 Error 交注入 errorClassifier.classify 归 ABORTED（供 c2-5-4 用，可本故事先建）。
新建 abort-stream.test.ts：假 ForceAbortScheduler（记录+手动 fire+spy）、假 AgentRuntimePort（spy interrupt）、假/真 StreamSessionRegistry + StreamSession、FrozenClock。用【共享调用序列数组】记录 schedule 与 interrupt 的调用先后，断言：
- 非 active 回合（先 abort 掉或本就 terminal）→ abort 为 no-op（schedule/markSettling/interrupt 均未调）。
- active 回合 abort：schedule 调用序列【早于】任何 interrupt（AC-4）；markSettling 被调、phase=settling。
（interrupt 抛错时 force-abort 仍已安排的断言可本故事先立骨架、c2-5-3 interrupt 接入后补全。）
核心零框架、无 setTimeout/Date.now 直调；import type + .js；术语中文。`,
  { label: 'c2-5-2:guard+safetynet', phase: 'GuardAndSafetyNet' })

// ---- 波次3：interrupt + reconcile + #578 回归 ----
phase('InterruptReconcile')
const r3 = await agent(`${RULES}

任务 c2-5-3：best-effort 优雅 interrupt + reconcilePhase 收敛 + #578 端到端回归（本 epic 招牌）。对齐 SPEC CAP-3、architecture §4.2/§6.3、FR-3.3、AC-2。
编辑 usecases/abort-stream.ts：markSettling 后（安全网已先行安排）经注入的 AgentRuntimePort.interrupt(turnRef) 发 best-effort 优雅中断：
- turnRef 由核心以 { streamId } 构造（TurnRef.native 可选，句柄由适配器按 streamId 内部解析，核心不碰 native）。
- interrupt 返回 Promise<string|null> 权威 runtimeStatus → 经 c2-1 reconcilePhase(runtimeStatus, session.snapshot().phase) 收敛：
  返回 terminal 相位则据子态翻终态（TerminalSubstate.COMPLETED→session.complete()、ABORTED→session.abort(classifyAbort(...))、ERRORED→session.fail(...归因)）；返回 null（running/unknown）→ 不纠正、交安全网兜底。
- 【#578 时序铁律】interrupt 挂起/抛错【绝不阻塞相位翻转】：用 .catch 只吞错（可留 TODO 经 RuntimeLog 记录），【绝不】在 .then/.finally/.catch 里把 phase 翻回 active、【绝不】把安全网安排挪到 interrupt 之后。abort(streamId) 方法本身可在安排安全网+markSettling+触发 interrupt 后即返回（interrupt 的收敛在其 then 里异步完成，不 await 阻塞方法返回——或按 §4.2 编排结构，reconcile 收敛为 fire-and-forget 的 then），确保 interrupt 永挂时方法不挂起。
- 复用 c2-1 reconcilePhase（不重写映射）、c2-2 迁移方法。
在 abort-stream.test.ts 补：
- interrupt 返回 'interrupted'→terminal(aborted)、'idle'→terminal(completed)、'error'→terminal(errored)、'running'/null→不纠正（仍 settling，等安全网）。
- 【#578 招牌回归 AC-2，必须真断言】假 interrupt 返回【永不 resolve】的 Promise（new Promise(()=>{})）+ 假 ForceAbortScheduler 手动 fire（配合 c2-5-4 的到期回调；若 c2-5-4 未完成则本故事先断言「fire 后经占位回调 session 仍能翻终态」的骨架，c2-5-4 补全兜底逻辑后此断言转真）→ 断言 abort 编排走完、fire 定时器后 session phase=terminal(aborted)、canAccept()=true。非空断言。
- interrupt 抛错（reject）→ 不影响：安全网仍已安排、phase 不被翻回 active。
核心零框架；import type + .js；术语中文。`,
  { label: 'c2-5-3:interrupt+reconcile+578', phase: 'InterruptReconcile' })

// ---- 波次4：到期兜底 ----
phase('ForceAbortExpiry')
const r4 = await agent(`${RULES}

任务 c2-5-4：force-abort 到期兜底——仍 active 则 abort(ABORTED) + forceKillTurn。对齐 SPEC CAP-4、architecture §4.2、FR-3.2/3.4/3.5、AC-5/AC-6。
编辑 usecases/abort-stream.ts 把 c2-5-2 的 forceAbortCallback 占位补全为真实到期兜底：
- 到期回调：if isActive(session.snapshot().phase) → session.abort(classifyAbort(errorClassifier))（构造 name='AbortError' 交 classify 归 ErrorCode.ABORTED）无条件翻 terminal(aborted) + runtime.forceKillTurn({ streamId })（FR-3.5 兜底关句柄）；否则（已 terminal/已收敛）→ no-op（幂等）。
- 收敛后 cancel 未到期安全网：在 interrupt 的 reconcile 成功翻终态处（c2-5-3）调用 c2-5-2 保存的 cancel 函数，避免安全网多余触发；但即便未 cancel，聚合根 abort 幂等（terminal 后 no-op）也保证安全——【两层防线都要在】（cancel + 幂等）。
- 归因经 SK.ErrorClassifier 归 ABORTED，绝不手拼 ClassifiedError。复用 c2-2 abort（幂等无条件翻终态）、c2-1 isActive。
在 abort-stream.test.ts 补：
- interrupt 永挂 → 手动 fire 定时器 → session.abort(ABORTED)（phase=terminal(aborted)、canAccept()=true）+ forceKillTurn 被调、turnRef.streamId 正确（AC-6）。这坐实 c2-5-3 的 #578 回归为真断言。
- interrupt 已让回合 terminal（如返回 'interrupted'）→ 手动 fire 定时器 → 回调 no-op（幂等、不二次翻，phase/settledAt 不变）。
- abort 归因 ClassifiedError.code===ABORTED（AC-5，与真实错误 code 不同）。
- 收敛路径下 cancel 被调（安全网不多余触发）。
核心零框架、无 setTimeout/Date.now 直调；import type + .js；术语中文。`,
  { label: 'c2-5-4:force-abort-expiry', phase: 'ForceAbortExpiry' })

// ---- 波次5：关句柄 ----
phase('CloseHandle')
const r5 = await agent(`${RULES}

任务 c2-5-5：关 turn/句柄通知契约（核心侧）+ late-unregister no-op 边界注明。对齐 SPEC CAP-5、architecture §4.2/§7.1、FR-3.5、AC-6。
在 usecases/abort-stream.ts 现有编排上补齐/固化「abort 必通知适配器关句柄」的契约（不新增复杂逻辑）：
- 确认优雅路径 interrupt({streamId}) 与兜底路径 forceKillTurn({streamId}) 都传入正确 streamId 的 turnRef；核心【绝不】触碰 TurnRef.native 结构（native 由适配器 c2-6 解析）。
- late-unregister（旧 lockId 的 teardown 不 evict 新 turn 句柄）为 no-op 是适配器 c2-6 侧语义，本故事【不】在核心实现它，仅在注释/测试注明该契约边界归属 c2-6。
在 abort-stream.test.ts 补（假 AgentRuntimePort spy）：
- abort 优雅收敛路径 → interrupt 被调且 turnRef.streamId 正确。
- abort 兜底路径（interrupt 永挂+fire 定时器）→ forceKillTurn 被调且 turnRef.streamId 正确。
- 核心未消费 native 字段（可断言核心传入的 turnRef 仅设 streamId，或用只含 streamId 的 turnRef 也能正常工作）。
复用既有 AgentRuntimePort（c2-1）；import type + .js；核心零框架；术语中文。`,
  { label: 'c2-5-5:close-handle', phase: 'CloseHandle' })

// ---- 波次6：超时归因 ----
phase('TimeoutAttribution')
const r6 = await agent(`${RULES}

任务 c2-5-6：idle-timeout / tool-timeout 归因区分。对齐 SPEC CAP-6、architecture §6.2、FR-3.6、AC-5。
读 architecture §6.2 与 domain/stream/terminal-reason.ts 确认权威归类（idle-timeout→TIMEOUT、tool-timeout→PROCESS 或按文档；user-abort→ABORTED）。
在 usecases/abort-stream.ts（或同目录纯函数）落 idle-timeout / tool-timeout → 正确归因翻终态的核心归类：
- 归因一律经 SK.ErrorClassifier.classify：idle-timeout 构造含 'timeout'/'timed out' 语义的错误→TIMEOUT；tool-timeout 构造含 'spawn'/'child process'/进程语义的错误→PROCESS（读 error-classifier.ts 确认关键词命中，务必让 classify 真归到目标 code，不命中就调整构造的错误消息，绝不手拼 ClassifiedError）；user-abort→ABORTED（name='AbortError' 无 timeout 语义）。
- 这两类超时都走 session.abort/fail 翻终态（复用 c2-2 聚合根）；本故事只落「给定超时信号→正确归因翻终态」的核心归类，不造假定时器/不实现真实 idle·tool 计时（依赖具体 Runtime，属 c2-6）。
在 abort-stream.test.ts 补：
- user-abort→ABORTED、idle-timeout→TIMEOUT、tool-timeout→PROCESS 三路 ClassifiedError.code 互不相同（AC-5）。
- 三路都翻终态、canAccept()=true。
复用 c2-1 terminal-reason、SK.ErrorClassifier（不重写归类）；确认 AbortStreamService 完整、能编译。
核心零框架；import type + .js；术语中文。报告归因映射与你补的断言。`,
  { label: 'c2-5-6:timeout-attribution', phase: 'TimeoutAttribution' })

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C2-E5 的 AbortStreamService + ForceAbortScheduler 端口已实现于 usecases/ 与 ports/driven/ 下 + 测试。
合并+验证：
1. 读 usecases/abort-stream.ts、ports/driven/force-abort-scheduler.ts 确认实际导出名。
2. 编辑 packages/core/src/index.ts：C2 段追加导出 AbortStreamService（class 值 export）、ForceAbortScheduler（接口 export type）、FORCE_ABORT_MS（值 export）；.js 说明符；注意与已有导出防同名冲突。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、force-abort 先行时序、interrupt 永挂不阻塞、reconcile 复用、归因经 ErrorClassifier、import type + .js、守卫含 setTimeout/node:timers 0 命中、同名冲突）。反复到全绿。守卫需保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行 + 特别确认 #578 端到端回归（interrupt 永挂→安全网兜底翻终态、canAccept=true）测试通过。`,
  { label: 'c2-5:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C2-E5 AbortStream 中断编排 + ForceAbortScheduler 端口。项目根：${PROJECT_ROOT}
读 packages/core/src/agent-runtime/usecases/abort-stream.ts(+test)、ports/driven/force-abort-scheduler.ts(+test)、相关端口（ports/driving/abort-stream-usecase.ts、ports/driven/agent-runtime-port.ts）、domain/stream/phase-transition.ts（reconcilePhase）、domain/stream/stream-session.ts（c2-2，确认未被改）、index.ts 相关导出。权威源 docs/contexts/c2-agent-runtime/architecture.md §4.2/§6.3/§8、prd FR-3/NFR-3/AC-2/AC-4/AC-5/AC-6、_bmad-output/implementation-artifacts/epic-c2-5/SPEC.md。

重点查（每条判断真缺陷/可接受）：
1. 【#578 force-abort 无条件先行，最重要】force-abort 安全网的【安排】是否【早于且独立于】interrupt？是否绝对没有把 session.abort 或 schedule 排进 interrupt(...) 的 .then/.finally/.catch？interrupt 挂起/抛错时相位翻转是否不受影响？AC-4 spy 是否真断言 schedule 调用序列早于 interrupt（而非空断言）？这是本 epic 存在的核心理由，重点审。
2. 【#578 端到端回归 AC-2】是否真复现「interrupt 返回永不 resolve 的 Promise + fire force-abort 定时器 → phase=terminal(aborted)、canAccept()=true」？是否真断言（非空断言）？abort(streamId) 方法本身在 interrupt 永挂时是否不挂起（不 await 永挂的 interrupt）？
3. 【幂等 FR-3.1】phase 非 active 时 abort 是否 no-op（不安排安全网/不 interrupt/不 markSettling）？force-abort 到期回调在回合已 terminal 时是否 no-op（不二次翻）？
4. 【reconcile 收敛 FR-3.3】interrupt 返回 idle/interrupted/error 是否分别翻 completed/aborted/errored？running/null 是否不纠正（等安全网）？是否复用 c2-1 reconcilePhase 未重写？
5. 【归因 AC-5】user-abort→ABORTED、idle-timeout→TIMEOUT、tool-timeout→PROCESS 三路 code 是否真不同？是否一律经 SK.ErrorClassifier.classify（未手拼 ClassifiedError 造假 code）？
6. 【关句柄 AC-6】abort 优雅路径 interrupt、兜底路径 forceKillTurn 是否被调、turnRef.streamId 正确？核心是否未触碰 native 句柄结构？
7. 【调度端口 CAP-1】ForceAbortScheduler 是否核心零框架（无 node:timers、无直调 setTimeout）？收敛后是否 cancel 未到期安全网（cancel + 幂等两层防线）？
8. 【不越界】未实现具体 Runtime 适配器 interrupt/forceKillTurn/late-unregister（c2-6）？未写 scheduler 的 setTimeout 生产实现/未接 NestJS DI（c2-7）？未造假 idle/tool 真实计时机制？
9. 【复用不重写】StreamSession 迁移方法/reconcilePhase/terminal-reason 是否复用未重写？registry 用 c2-4 的？
10. 核心零框架、无 setTimeout/Date.now/randomUUID 直调、import type+.js、phase 不落库、index.ts 导出正确无同名冲突。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c2-5:review', phase: 'Review' })

return {
  r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null,
  r4ok: r4 != null, r5ok: r5 != null, r6ok: r6 != null,
  mergeReport, review,
}
