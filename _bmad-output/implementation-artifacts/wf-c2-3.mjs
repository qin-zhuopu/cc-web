export const meta = {
  name: 'c2-3-event-mapper',
  description: 'C2-E3 事件映射：波次1 事件构造/token投影/phase_changed 并行→波次2 EventMapper契约+未知降级→合并门禁→对抗评审',
  phases: [
    { title: 'EventUtils', detail: 'c2-3-1 构造/判别 + c2-3-3 token投影 + c2-3-4 phase_changed 并行' },
    { title: 'Mapper', detail: 'c2-3-2 EventMapper 契约 + 未知事件降级不崩' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审映射契约/未知降级/token投影' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/agent-runtime/ 下为 C2 定义事件映射契约。C2 核心零框架依赖、纯逻辑。
先读权威源 docs/contexts/c2-agent-runtime/architecture.md §3.5（14 类 AgentStreamEvent、EventMapper 契约、phase_changed 核心产出）确认签名。
现状（C2-E1/E2 已完成，直接复用，绝不重定义）：
- domain/event/agent-stream-event.ts：14 类 AgentStreamEvent 判别联合 + ToolUseInfo/ToolResultInfo/TokenUsage(RuntimeTokenUsage)/ContextUsage/PermissionRequest/RateLimitInfo 值对象已定义（c2-1-5）。本 epic 一律 import type 引用，绝不重新声明联合成员、不改值对象签名。
- domain/stream/stream-session.ts：聚合根 apply(event) 消费 AgentStreamEvent（c2-2）。

本 epic 职责：
- c2-3-1：为 14 类事件补【构造工厂 + 判别 type guard】（归一目标的可用面），不重定义类型。
- c2-3-2：定义 EventMapper 契约（端口/接口 + 纯函数骨架）：外部 Runtime 原始事件 → 内部 AgentStreamEvent。未知/无法识别事件降级：不抛、不伪造已识别事件、不静默改变语义；按文档规则丢弃（返回无归一结果/null）或包 raw。当前 14 类联合无 raw 载体，故核心侧安全路径=返回 null/跳过；若需新增 raw 载体属 correct-course，本 epic 不擅自扩联合。EventMapper 具体各 Runtime 实现属 c2-6，本 epic 只契约+骨架。
- c2-3-3：result 事件 token 投影——无上报留空不填 0（AC-9）。
- c2-3-4：phase_changed 事件由 C2 核心产出（StreamSession 相位变化时），明确其语义与构造。

核心包铁律（守卫会拦）：禁 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、child_process；禁直调 Date.now()/new Date()/randomUUID（注释也别连写 "Date.now("）。
不接 SDK（属 c2-6）、不做 StartStream/AbortStream 用例（c2-4/5）、不接 NestJS DI。phase 不落库/不混用 C1。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import 正常。readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
完成后报告改/建的文件。
`

// ---- 波次1：事件工具（并行，互不依赖）----
phase('EventUtils')
const wave1 = await parallel([
  () => agent(`${RULES}

任务 c2-3-1：为 14 类 AgentStreamEvent 补构造工厂 + 判别 type guard（不重定义类型）。
创建 packages/core/src/agent-runtime/domain/event/event-factory.ts（或合适命名）：
- 为常用事件类型提供构造工厂函数（如 textEvent(text)、thinkingEvent(delta)、toolUseEvent(info)、resultEvent(...)、errorEvent(classified) 等，以 §3.5 的 14 类为准），返回对应 AgentStreamEvent 成员。工厂只组装结构、不含 I/O。
- 提供判别 type guard（如 isTextEvent(e): e is TextEvent 等，或一个按 type 收窄的辅助），让消费方安全判别。
- 一律 import type 引用 c2-1 的 AgentStreamEvent 及值对象，绝不重新声明联合成员/改签名。
创建 event-factory.test.ts：工厂产出的事件 type/字段正确、type guard 正确收窄。`,
    { label: 'c2-3-1:factory', phase: 'EventUtils' }),

  () => agent(`${RULES}

任务 c2-3-3：result 事件 token 投影（无上报留空不填 0，AC-9）。
- 在 domain/event/ 下（新建 result-projection.ts 或并入 event-factory）提供一个纯函数，把 Runtime 上报的原始 usage 数据投影为 result 事件的 tokenUsage（RuntimeTokenUsage）：有上报则原样投影，无上报字段留空（undefined），绝不填 0（AC-9 反假数据）。
- import type 引用 RuntimeTokenUsage/result 事件类型。
创建对应 *.test.ts：完整 usage 投影保留、缺字段留 undefined、完全无 usage 时 result.tokenUsage 为 undefined（不造 0）。`,
    { label: 'c2-3-3:token-projection', phase: 'EventUtils' }),

  () => agent(`${RULES}

任务 c2-3-4：phase_changed 事件由 C2 核心产出。对齐 §3.5（phase_changed 是唯一由 C2 核心而非 Runtime 产出的事件）。
- 在 domain/event/ 下提供 phase_changed 事件的构造工厂（如 phaseChangedEvent(from, to) 或以 §3.5 字段为准），明确其为核心产出（注释）：当 StreamSession 相位变化时由核心发出，不来自外部 Runtime、不经 EventMapper。
- import type 引用 StreamPhase 与 phase_changed 事件类型（来自 c2-1）。
创建对应 *.test.ts：phaseChangedEvent 构造正确、字段反映相位变化、type 为 phase_changed。`,
    { label: 'c2-3-4:phase-changed', phase: 'EventUtils' }),
])

// ---- 波次2：EventMapper 契约 + 未知降级 ----
phase('Mapper')
const r2 = await agent(`${RULES}

任务 c2-3-2：定义 EventMapper 契约 + 未知原生事件降级不崩。对齐 §3.5、AC-8、FR-4.3。
波次1已建事件工厂/type guard/phase_changed 工厂。
创建 packages/core/src/agent-runtime/ports/event-mapper.ts（或 domain/event/ 下，以架构目录约定为准）：
- EventMapper 契约接口：把外部 Runtime 原始事件（unknown / 原始类型）映射为内部 AgentStreamEvent 或表示"无归一结果"（null）。签名如 mapEvent(raw: unknown): AgentStreamEvent | null（以 §3.5/§5.1 为准）。
- 【未知事件降级不崩】提供一个契约层的降级约定/纯函数骨架：无法识别的原始事件 → 返回 null（丢弃，安全跳过），绝不抛异常、绝不伪造已识别事件、绝不静默改变已识别事件语义（AC-8）。当前 14 类联合无 raw/unknown 载体，故降级=返回 null/跳过；注释写明「若需保留 raw 需新增载体，属 correct-course，本 epic 不扩联合」。
- EventMapper 具体各 Runtime（Claude/Native/Codex）实现属 c2-6，本 epic 只定义契约接口 + 降级语义骨架，不接 SDK。
- import type 引用 AgentStreamEvent。
创建 event-mapper.test.ts：用一个最小内联 fakeMapper 实现契约，断言——已识别原始事件→对应 AgentStreamEvent；未识别原始事件（如 {type:'weird'}/null/非对象）→返回 null 不抛（AC-8 降级不崩）；不伪造、不改变已识别事件语义。`,
  { label: 'c2-3-2:mapper', phase: 'Mapper' })

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C2-E3 文件已产出：event-factory（构造/type guard）、token 投影、phase_changed 工厂、event-mapper 契约 + 各测试。
合并+验证：
1. 读上述文件确认实际导出名。
2. 编辑 packages/core/src/index.ts：C2 段追加导出（事件工厂函数、type guard、token 投影函数、phaseChangedEvent、EventMapper 契约类型）。函数/值用 export，接口/类型用 export type，.js 说明符。注意与 c1/c2 已有导出防同名冲突（如需别名，仿之前 RuntimeTokenUsage 做法）。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、未知降级返回 null 而非抛、token 不填 0、import type、守卫、同名冲突）。反复到全绿。守卫 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行。`,
  { label: 'c2-3:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C2-E3 EventMapper 契约与事件工具。项目根：${PROJECT_ROOT}
读 packages/core/src/agent-runtime/domain/event/ 新增文件、ports/event-mapper.ts（若在此）、agent-stream-event.ts（c2-1 定义，确认未被改）、index.ts 相关导出。权威源 docs/contexts/c2-agent-runtime/architecture.md §3.5、prd AC-7/8/9。

重点查（每条判断真缺陷/可接受）：
1. 【不重定义】c2-3-1 是否只加构造工厂/type guard，没重新声明 14 类联合成员、没改值对象签名（AC-7）？
2. 【未知降级不崩】EventMapper 对未识别原始事件（{type:'weird'}/null/非对象/undefined）是否返回 null 不抛？是否伪造已识别事件或改变已识别语义（应无）？测试是否真断言不崩（而非空断言）？
3. 【token 投影 AC-9】result token 无上报是否留 undefined 不填 0？部分上报是否只留有值字段？
4. 【phase_changed 核心产出】是否明确标注由 C2 核心产出、不经 mapper/不来自 Runtime？
5. 核心零框架、不接 SDK、禁直调 Date.now/randomUUID、import type+.js、phase 不落库。
6. index.ts 导出是否正确（函数 export、类型 export type）、无同名冲突？
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c2-3:review', phase: 'Review' })

return { wave1ok: wave1.map((r) => r != null), r2ok: r2 != null, mergeReport, review }
