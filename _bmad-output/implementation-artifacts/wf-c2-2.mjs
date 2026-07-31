export const meta = {
  name: 'c2-2-stream-session-aggregate',
  description: 'C2-E2 StreamSession 聚合根+#578回归：串行 聚合根壳→四迁移方法→abort#578回归→canAccept→apply累积，合并门禁再对抗评审',
  phases: [
    { title: 'Aggregate', detail: 'c2-2-1 StreamSession 聚合根壳+snapshot' },
    { title: 'Transitions', detail: 'c2-2-2 四迁移方法幂等' },
    { title: 'AbortInvariant', detail: 'c2-2-3 abort 不变量 + #578 反例回归' },
    { title: 'CanAccept', detail: 'c2-2-4 canAccept 门' },
    { title: 'Apply', detail: 'c2-2-5 apply 事件累积到 TurnArtifacts' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审 phase 不变量/#578/幂等/canAccept/apply' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/agent-runtime/domain/stream/ 下实现 C2 的 StreamSession 聚合根。C2 核心零框架依赖、纯逻辑。
先读权威源 docs/contexts/c2-agent-runtime/architecture.md §3.1/§3.2/§3.4/§3.5 确认 StreamSession 聚合根签名、四迁移方法、abort 不变量、force-abort 无条件先行的准确定义。
现状（C2-E1 已完成，直接复用）：
- domain/stream/stream-phase.ts：StreamPhase(active/settling/terminal 判别联合)、TerminalSubstate、isActive/isTerminal、StreamSessionId。
- domain/stream/phase-transition.ts：canTransitionPhase(from,to) 合法迁移判据（唯一权威，不重写）、reconcilePhase(runtimeStatus,current) force-abort 收敛。
- domain/stream/terminal-reason.ts：TerminalReason 6 归因码 + expectedErrorCode 映射。
- domain/stream/turn-artifacts.ts：TurnArtifacts + buildFinalContent 投影。
- domain/event/agent-stream-event.ts：14 类 AgentStreamEvent + 值对象。
- SK：ports/clock.ts（Clock.now():number）。

本 epic 实现 domain/stream/stream-session.ts 的 StreamSession 聚合根：
- 【复用不重写】迁移必经 canTransitionPhase 判据；force-abort 收敛用 reconcilePhase；终态产物用 buildFinalContent；apply 累积到 TurnArtifacts。
- 【构造注入 Clock】聚合根取时经注入的 Clock，绝不直调 Date.now()/new Date()（注释也别连写 "Date.now("）。
- 【phase 不落库/不混用 C1】phase 是实时内存态，绝不落库、绝不 import C1 StreamStatus。
- 【#578 招牌】force-abort 安全网无条件先行——即使外部 interrupt 永不 resolve（永挂），phase 仍能翻 terminal(aborted)、canAccept()=true，不卡死。根因：原代码把 abort 排在 interrupt 的 .finally 里，interrupt 挂起则 .finally 永不执行。force-abort 必须独立于 interrupt 的 then/finally、无条件先行。

核心包铁律（守卫会拦）：禁 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、child_process；禁直调 Date.now()/new Date()/randomUUID。
本 epic 只实现聚合根行为，不接真实 Runtime 适配器（属 c2-6）、不做 EventMapper（c2-3）、不做 StartStream/AbortStream 用例编排（c2-4/c2-5）、不接 NestJS DI。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import 正常。字段 readonly（聚合根内部可变状态用 private，但快照 snapshot 返回只读）。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。假替身：FrozenClock/MutableClock、可注入 interrupt 永挂的假 AgentRuntimePort。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
完成后报告改/建的文件。
`

phase('Aggregate')
const r1 = await agent(`${RULES}

任务 c2-2-1：实现 StreamSession 聚合根壳 + snapshot。对齐 architecture §3.2。
创建 packages/core/src/agent-runtime/domain/stream/stream-session.ts：
- class StreamSession：构造注入 Clock（及必要的初始 StreamSessionId/初始 phase=active）。内部持有当前 StreamPhase、累积 TurnArtifacts、起始时刻等私有可变状态。
- snapshot(): 返回只读快照（如 { id, phase, artifacts?, ... }，以 §3.2 为准），phase 为当前 StreamPhase。
- 构造时 phase 初始为 active（新回合开始）。取时经注入 Clock。
- phase 不落库、不 import C1 StreamStatus。
创建 stream-session.test.ts：构造聚合根、初始 phase=active、snapshot 返回只读且反映当前状态。
迁移方法/canAccept/apply 属后续故事（可先留方法占位以能编译，或分故事补）。`,
  { label: 'c2-2-1:aggregate', phase: 'Aggregate' })

phase('Transitions')
const r2 = await agent(`${RULES}

任务 c2-2-2：实现四迁移方法（幂等）。对齐 architecture §3.2、AC-1。
编辑 stream-session.ts 补四个迁移方法（名称以 §3.2 为准，典型如 markSettling()/complete(tokenUsage?)/abort(reason)/fail(classified)）：
- 每个方法先用 canTransitionPhase(current, 目标) 判据守卫：合法才迁移、更新 phase（terminal 带对应 substate：complete→completed、abort→aborted、fail→errored）。
- 【幂等】终态后再调任何迁移方法为 no-op（不抛、不改 phase）——canTransitionPhase 对 terminal→* 返回 false 天然拒绝，方法据此静默返回。
- 终态时用 buildFinalContent(artifacts) 组装最终内容（若非 null），记入 snapshot。
- 复用 canTransitionPhase 不重写迁移规则。
在 stream-session.test.ts 补：active→settling→terminal 合法迁移；complete/abort/fail 各达对应 terminal substate；终态后再调迁移方法幂等 no-op（phase 不变、不抛）；非法迁移（如直接 terminal→active）被拒。`,
  { label: 'c2-2-2:transitions', phase: 'Transitions' })

phase('AbortInvariant')
const r3 = await agent(`${RULES}

任务 c2-2-3：实现 abort 不变量 + #578 反例回归（C2 招牌）。对齐 architecture §3.2/§4.2/§6.3、prd #578 相关 AC。
- 编辑 stream-session.ts：确保 abort 路径的 force-abort 安全网【无条件先行】——abort(reason) 立即无条件把 phase 翻 terminal(aborted)（经 canTransitionPhase 守卫，从 active/settling 均可 abort），不依赖任何外部 interrupt 的 resolve。若聚合根需与外部 interrupt 协作，force-abort 的相位翻转必须独立于 interrupt 的 then/finally。
  （注：真实 interrupt 调用属 AbortStreamService 编排 c2-5；本 epic 聚合根层面保证「abort 命令一到，phase 无条件翻 terminal(aborted)」这一不变量。）
- 在 stream-session.test.ts 补 #578 反例回归（关键）：
  1. 构造 active 态聚合根。
  2. 模拟「interrupt 永不 resolve」场景：调 abort(user_aborted) —— 断言即便没有任何 interrupt resolve，snapshot().phase === terminal(aborted) 立即成立、canAccept()===true（不卡死）。
  3. 断言 abort 归因为 ABORTED（TerminalReason.code=user_aborted，expectedErrorCode→ABORTED），不显示成"出错了"（AC-5）。
  4. 用假 Clock（若涉及超时）手动推进；用可注入 interrupt 永挂的假 AgentRuntimePort（若聚合根签名涉及）演示 force-abort 先行于 interrupt。
  这条回归是 C2 存在的核心理由，必须真断言、非空断言。`,
  { label: 'c2-2-3:abort-578', phase: 'AbortInvariant' })

phase('CanAccept')
const r4 = await agent(`${RULES}

任务 c2-2-4：实现 canAccept() 门。对齐 architecture §3.2。
- 编辑 stream-session.ts 补 canAccept(): boolean —— 语义以 §3.2 为准（典型：terminal 态可接受新输入=true；active/settling 进行中=false，或反之，务必读文档确认准确语义）。关键是：#578 场景 abort 后 canAccept() 必须为 true（输入立即恢复可用，不卡死）。
- 在 stream-session.test.ts 补：各相位下 canAccept 语义断言；abort 到 terminal 后 canAccept()=true；active 进行中 canAccept 语义符合文档。`,
  { label: 'c2-2-4:can-accept', phase: 'CanAccept' })

phase('Apply')
const r5 = await agent(`${RULES}

任务 c2-2-5：实现 apply(event) 事件累积到 TurnArtifacts。对齐 architecture §3.2/§3.5。
- 编辑 stream-session.ts 补 apply(event: AgentStreamEvent): void —— 把流式事件累积进内部 TurnArtifacts（text 追加、thinking 追加、tool_use/tool_result 收集，以 §3.5/§3.2 为准）。usage 类事件按 AC-9 只存投影不填 0。apply 只在 active/settling（非终态）有效；终态后 apply 的语义按文档（忽略或拒绝）。
- 终态时 buildFinalContent(累积的 artifacts) 得最终内容。
- 在 stream-session.test.ts 补：apply 多个 text/thinking/tool 事件后 snapshot/artifacts 正确累积；complete 后 buildFinalContent 反映累积内容；空回合（无 apply）complete → buildFinalContent 返回 null（空回合不落库 FR-2.6）。
- 确认 StreamSession 所有方法完整、能编译。
报告 apply 累积逻辑与你补的断言。`,
  { label: 'c2-2-5:apply', phase: 'Apply' })

phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C2-E2 的 StreamSession 聚合根已实现于 domain/stream/stream-session.ts + 测试。
合并+验证：
1. 读 stream-session.ts 确认导出名（StreamSession class 及任何导出类型）。
2. 编辑 packages/core/src/index.ts：C2 段追加导出 StreamSession（class 值用 export，.js 说明符）。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、迁移守卫复用、#578 回归断言、canAccept 语义、apply 累积、phase 不落库/不混用 C1、Clock 注入）。反复到全绿。守卫需保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行 + 特别确认 #578 反例回归测试通过。`,
  { label: 'c2-2:merge+verify', phase: 'Merge+Verify' })

phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C2-E2 StreamSession 聚合根 + #578 abort 回归。项目根：${PROJECT_ROOT}
读 packages/core/src/agent-runtime/domain/stream/stream-session.ts(+test)、phase-transition.ts、terminal-reason.ts、turn-artifacts.ts、index.ts 相关导出。权威源 docs/contexts/c2-agent-runtime/architecture.md §3.1/§3.2/§3.4/§3.5。

重点查（每条判断真缺陷/可接受）：
1. 【#578 招牌，最重要】abort 是否无条件先行——abort 命令一到 phase 立即翻 terminal(aborted)、canAccept()=true，不依赖任何外部 interrupt 的 resolve？测试是否真复现「interrupt 永挂仍翻终态」（而非空断言）？这是 C2 存在的核心理由，重点审。
2. 【复用不重写】四迁移方法是否都经 canTransitionPhase 判据（不在聚合根重写迁移规则）？force-abort 收敛是否用 reconcilePhase？
3. 【幂等】终态后再调迁移方法是否 no-op（不抛、phase 不变）？
4. 【canAccept】语义是否与 §3.2 一致？abort 后是否 =true？
5. 【apply 累积】事件是否正确累积到 TurnArtifacts？空回合 complete → buildFinalContent 返回 null（FR-2.6）？usage 不填 0（AC-9）？
6. 【Clock 注入】取时是否经注入 Clock、无 Date.now/new Date 直调？
7. 【phase 不落库/不混用】聚合根是否零 import C1 StreamStatus、phase 纯内存态？
8. 核心零框架、readonly 快照、import type+.js。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c2-2:review', phase: 'Review' })

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, r4ok: r4 != null, r5ok: r5 != null, mergeReport, review }
