export const meta = {
  name: 'c2-1-agent-runtime-domain',
  description: 'C2-E1 AgentRuntime 领域与端口骨架：波次1相位/归因/事件/键→波次2判定/产物→波次3端口+守卫→合并门禁→对抗评审',
  phases: [
    { title: 'Types', detail: 'c2-1-1 相位/c2-1-3 归因/c2-1-5 事件/c2-1-8 键 并行' },
    { title: 'PureFns', detail: 'c2-1-2 canTransitionPhase/c2-1-4 buildFinalContent 并行' },
    { title: 'PortsGuard', detail: 'c2-1-6 端口/c2-1-7 守卫 并行' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审相位状态机/归因映射/事件/端口边界' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/agent-runtime/ 下为 C2（AgentRuntime 领域边界）建模。C2 核心逻辑零框架依赖。
先读权威源 docs/contexts/c2-agent-runtime/architecture.md（§3.5 是 14 类事件、相位状态机、归因码、TurnArtifacts 的权威定义）确认签名再实现。
目录：packages/core/src/agent-runtime/ 下 domain/stream/、domain/event/、domain/（message-keys）、ports/。不要污染 SK/C1 既有文件。

C2 核心铁律（关键）：
- 【phase 不落库、不与 C1 混用】phase 是 C2 实时内存态，绝不落库、绝不与 C1 持久 StreamStatus 混用（NFR-2/AC-15）。C2 类型层不 import C1 的 StreamStatus。
- 【单向 import type】C2 只能 import type 引用 SK（ClassifiedError/ErrorClassifier 等）与 C1 用例端口、C7 ProviderRepository 的类型，绝不 import 它们的运行实现，绝不反向被依赖。C1↔C2 环在接线层用 forwardRef 解，本 epic 不碰。
- 【本 epic 只定义类型/枚举/纯函数判定/端口骨架】不实现 StreamSession 聚合根行为（属 epic-c2-2）、不定义 EventMapper 契约（属 c2-3）、不接 SDK（c2-6）、不接 NestJS DI。

核心包铁律（import 守卫会拦 packages/core）：禁 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、child_process/node:child_process；禁直调 Date.now()/new Date()/randomUUID（注释里也别连写 "Date.now("）。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import 正常。字段全 readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
完成后报告创建的文件路径。
`

// ---- 波次1：无相互依赖的类型（并行）----
phase('Types')
const wave1 = await parallel([
  () => agent(`${RULES}

任务 c2-1-1：定义 StreamPhase 相位类型与判定 + StreamSessionId。对齐 architecture §3.5。
创建 packages/core/src/agent-runtime/domain/stream/stream-phase.ts：
- StreamPhaseKind: 'active' | 'settling' | 'terminal'。
- TerminalSubstate: 'completed' | 'aborted' | 'errored'。
- 判别联合 StreamPhase：active/settling 无子态，terminal 带 substate（如 { kind:'active' } | { kind:'settling' } | { kind:'terminal', substate: TerminalSubstate }，以 §3.5 为准）。
- isActive(phase)/isTerminal(phase) 判定纯函数。
- StreamSessionId 值对象（string 品牌类型或别名，注释说明）。
- 【铁律】phase 是实时内存态，注释写明绝不落库、绝不与 C1 StreamStatus 混用；本文件不 import C1 任何类型。不实现聚合根迁移方法（属 c2-2）。
创建 stream-phase.test.ts：构造各相位、isActive/isTerminal 断言、terminal 带 substate 类型收窄。`,
    { label: 'c2-1-1:phase', phase: 'Types' }),

  () => agent(`${RULES}

任务 c2-1-3：定义 TerminalReason 归因 + 到 SK.ErrorClassifier 的映射约定。对齐 architecture §3.5、AC-5。
创建 packages/core/src/agent-runtime/domain/stream/terminal-reason.ts：
- TerminalReasonCode: 'completed' | 'user_aborted' | 'idle_timeout' | 'tool_timeout' | 'runtime_error' | 'process_died'（6 类）。
- TerminalReason 值对象（只读）：含 code: TerminalReasonCode 与可选 classified?: ClassifiedError（import type 自 SK，不重定义）。
- 映射约定（注释或纯函数，不实现 classify 本身）：user_aborted→ABORTED、idle_timeout→TIMEOUT、tool_timeout→PROCESS 或 TIMEOUT、process_died→PROCESS、runtime_error→由 ErrorClassifier 分类、completed→无错误。约定须让 ABORTED 不被显示成"出错了"（AC-5）。
- import type { ClassifiedError } from SK（路径 '../../../domain/error/classified-error.js' 或经桶文件，以实际为准；用 import type）。
- 只定义值对象与映射约定，不实现 abort 用例（属 c2-2）。
创建 terminal-reason.test.ts：6 类归因码断言、映射约定断言（user_aborted 对应 ABORTED 语义等）。`,
    { label: 'c2-1-3:terminal-reason', phase: 'Types' }),

  () => agent(`${RULES}

任务 c2-1-5：定义 14 类 AgentStreamEvent 判别联合 + 值对象。对齐 architecture §3.5（务必先读确认 14 类的准确 type 与字段）。
创建 packages/core/src/agent-runtime/domain/event/agent-stream-event.ts：
- 14 类事件判别联合 AgentStreamEvent（以 §3.5 为准，典型含 text/thinking/tool_use/tool_result/result/phase_changed/error/usage 等；请逐字对齐文档的 14 类 type 与字段）。
- 值对象：ToolUseInfo、ToolResultInfo、TokenUsage、ContextUsage（只读）。result 事件的 tokenUsage 可空（无上报留空、不填 0，AC-9）。
- phase_changed 事件标注为 C2 核心产出（注释）。
- 引用 StreamPhase 用 import type + .js；引用 ClassifiedError（error 事件）用 import type 自 SK。
- 只定义事件联合与值对象，不定义 EventMapper 契约/降级（属 c2-3）、不接 SDK。
创建 agent-stream-event.test.ts：14 类各构造合法字面量、type 判别收窄、usage 无值留空断言（不填 0）。`,
    { label: 'c2-1-5:events', phase: 'Types' }),

  () => agent(`${RULES}

任务 c2-1-8：定义 C2 自身 i18n 消息键常量表。仿 SK message-keys.ts / C1_MESSAGE_KEYS 范式（as const + Object.freeze 只读）。
创建 packages/core/src/agent-runtime/domain/message-keys.ts：
- export const C2_MESSAGE_KEYS = {...} as const（Object.freeze 运行时只读）：c2.* 命名空间，覆盖状态/错误/中断提示的用户可见文案 key（如 c2.stream.aborted / c2.stream.completed / c2.error.* 视文档）。
- 只贡献 c2.* 键，不重定义 SK 错误文案（错误 key 来自 SK.ErrorClassifier.messageKey，此处不复制）。不实现渲染/翻译（交 SK.TranslationPort）。
创建 message-keys.test.ts：断言只读、键以 c2. 开头、无重复值。`,
    { label: 'c2-1-8:message-keys', phase: 'Types' }),
])

// ---- 波次2：纯函数判定（依赖波次1的相位/产物类型，并行）----
phase('PureFns')
const wave2 = await parallel([
  () => agent(`${RULES}

任务 c2-1-2：定义纯函数 canTransitionPhase 与 reconcilePhase。对齐 architecture §3.5、AC-1。
波次1已建 domain/stream/stream-phase.ts（StreamPhaseKind/TerminalSubstate/StreamPhase）。
编辑或新建 domain/stream/phase-transition.ts（与 stream-phase 同目录）：
- canTransitionPhase(from: StreamPhase, to: StreamPhase): boolean 纯函数——合法：active→settling、active→terminal、settling→terminal；非法：任意 terminal→*（终态不可迁出）、任意 *→active（不可回退到 active）。这是 phase 状态机不变量的唯一合法迁移判据（聚合根将在 c2-2 复用，本故事不实现聚合根）。
- reconcilePhase(runtimeStatus: string, current: StreamPhase): StreamPhase | null 纯函数——running/unknown → null（force-abort 兜底，表示不 reconcile）；idle/interrupted/error → 对应 terminal 子态（completed/aborted/errored，以文档为准）。
- 无副作用、不直调时钟/随机。import type { StreamPhase } from './stream-phase.js'。
创建 phase-transition.test.ts：canTransitionPhase 合法/非法迁移全矩阵断言（覆盖 3 相位 × 目标）；reconcilePhase 对 running/unknown/idle/interrupted/error 各分支断言。`,
    { label: 'c2-1-2:transition', phase: 'PureFns' }),

  () => agent(`${RULES}

任务 c2-1-4：定义 TurnArtifacts 值对象 + 纯函数 buildFinalContent。对齐 architecture §3.5、FR-2.6。
波次1已建 domain/event/agent-stream-event.ts（含 ToolUseInfo/ToolResultInfo 等值对象）。
创建 packages/core/src/agent-runtime/domain/stream/turn-artifacts.ts：
- TurnArtifacts 只读值对象：text?: string、thinking?: string、toolUses?: ReadonlyArray<ToolUseInfo>、toolResults?: ReadonlyArray<ToolResultInfo>（以 §3.5 为准）。
- buildFinalContent(artifacts: TurnArtifacts): string | null 纯函数，五路投影（以文档为准）：纯文本→返回 text；含 thinking/tool→组装 blocks[] 序列化或结构（以文档定义为准）；孤儿 tool_result 保留；全空回合→返回 null（FR-2.6：空回合不落库）。
- 无副作用纯函数。import type ToolUseInfo/ToolResultInfo from '../event/agent-stream-event.js'。
创建 turn-artifacts.test.ts：五路投影 + 空回合返回 null 断言。`,
    { label: 'c2-1-4:artifacts', phase: 'PureFns' }),
])

// ---- 波次3：端口 + 守卫（并行）----
phase('PortsGuard')
const wave3 = await parallel([
  () => agent(`${RULES}

任务 c2-1-6：定义 RuntimeKind/RuntimeAvailability + 驱动/出站端口骨架。对齐 architecture §3.6/§4/§5。先读文档确认端口签名。
创建 packages/core/src/agent-runtime/ports/ 下：
- runtime-kind.ts：RuntimeKind（如 'claude'|'native'|'codex'，以文档为准）、RuntimeAvailability。
- 驱动端口（ports/driving/）：StartStreamUseCase、AbortStreamUseCase、TitleGeneratorPort（接口签名骨架，不实现用例）。
- 出站端口：AgentRuntimePort（ports/driven/，接口签名）。
- conversation-ports.ts / provider-read-port.ts：仅 import type 转出 C1 用例端口类型与 C7 ProviderRepository 类型（核心只单向 import type；不 import 运行实现）。
- 只给接口签名，不实现 StartStreamService/AbortStreamService/registry（属 c2-2）、不接 NestJS DI/forwardRef。
用 import type + .js 引用领域类型。不建 index.ts（合并阶段处理）。创建至少一个 ports 类型层测试。`,
    { label: 'c2-1-6:ports', phase: 'PortsGuard' }),

  () => agent(`${RULES}

任务 c2-1-7：为 agent-runtime/ 核心包建立/扩展禁用 import 静态守卫。对齐 AC-14。
现状：scripts/check-core-imports.mjs 已扫 packages/core/src 全部（含新增 agent-runtime/ 子树），禁用清单含 @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、Date.now(、randomUUID。
本故事增量：确认守卫覆盖 packages/core/agent-runtime/ 全目录，并补充 child_process / node:child_process 到禁用 import 清单（C2 会涉及子进程 Runtime，核心严禁直接 import 子进程模块）。若清单已含则确认；若缺则补。
- 给 scripts/check-core-imports.test.ts 补回归用例：含 child_process import 的样本被拦、干净样本通过。
- 保持对 apps/api 不误伤（守卫只扫 packages/core）。不削弱现有能力。
报告：你确认/新增的扫描规则、补的测试。`,
    { label: 'c2-1-7:guard', phase: 'PortsGuard' }),
])

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C2-E1 的类型/枚举/纯函数/端口文件已由前序波次创建于 packages/core/src/agent-runtime/ 下，守卫已扩展 child_process 检测。
合并+验证：
1. 扫描 packages/core/src/agent-runtime/ 下所有导出（StreamPhase 及判定、TerminalReason、AgentStreamEvent 及值对象、TurnArtifacts+buildFinalContent、canTransitionPhase/reconcilePhase、RuntimeKind、各端口、C2_MESSAGE_KEYS），读文件确认实际导出名。
2. 编辑 packages/core/src/index.ts，在现有导出后追加一段 C2 导出（注释分节 // ==== C2 AgentRuntime ====）。类型/接口用 export type，值（枚举、纯函数、C2_MESSAGE_KEYS 常量）用 export。模块说明符带 .js。不删改现有 SK/C1 导出行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、类型引用、守卫规则、C2 误 import C1 StreamStatus 等铁律违规）。反复到全绿。不得违反核心/C2 铁律，不得让守卫误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加的 C2 导出行。`,
  { label: 'c2-1:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C2-E1 AgentRuntime 领域与端口骨架。项目根：${PROJECT_ROOT}
读 packages/core/src/agent-runtime/ 全部文件 + packages/core/src/index.ts 的 C2 导出段 + scripts/check-core-imports.mjs 的 child_process 规则。权威源 docs/contexts/c2-agent-runtime/architecture.md §3.5/§3.6/§4/§5。

重点查（每条判断真缺陷/可接受）：
1. 【phase 不落库/不混用 C1】agent-runtime/ 是否零 import C1 的 StreamStatus？phase 是否被当纯内存态（注释与类型是否明确不落库）？
2. 【单向 import type】C2 是否只 import type 引用 SK/C1/C7 类型，无任何运行实现 import、无反向依赖？ClassifiedError 是否 import type 自 SK 不重定义？
3. 【canTransitionPhase】合法（active→settling/terminal、settling→terminal）与非法（terminal→*、*→active）迁移是否正确？测试是否全矩阵真断言？
4. 【reconcilePhase】running/unknown→null、其余→terminal 子态是否正确？
5. 【14 类事件】是否完整覆盖 §3.5 的 14 类、字段逐字一致？usage 无值是否留空不填 0（AC-9）？
6. 【TerminalReason 映射】6 类归因码 + 映射约定（user_aborted→ABORTED 等 AC-5）是否正确？
7. 【buildFinalContent】五路投影 + 空回合→null 是否正确、纯函数？
8. 【端口】只签名骨架无实现（不含 StreamSession 聚合根、不含用例实现）？守卫是否真拦 child_process（AC-14）？
9. 核心零框架、禁直调 Date.now/randomUUID、readonly、import type+.js。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c2-1:review', phase: 'Review' })

return {
  wave1ok: wave1.map((r) => r != null),
  wave2ok: wave2.map((r) => r != null),
  wave3ok: wave3.map((r) => r != null),
  mergeReport,
  review,
}
