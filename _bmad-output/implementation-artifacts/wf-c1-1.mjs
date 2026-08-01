export const meta = {
  name: 'c1-1-domain-ports',
  description: 'C1-E1 会话/消息领域+端口骨架：波次1值对象→波次2实体→波次3端口+守卫→合并门禁→对抗评审',
  phases: [
    { title: 'ValueObjects', detail: 'c1-1-3 StreamStatus/c1-1-4 TitleOrigin/c1-1-5 消息键 并行' },
    { title: 'Entities', detail: 'c1-1-1 ChatSession/c1-1-2 Message 并行（引用波次1类型）' },
    { title: 'PortsGuard', detail: 'c1-1-6 端口骨架/c1-1-7 import 守卫 并行' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审领域模型、禁 phase、端口划分' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core 里为 C1（Conversation 领域边界）建模。C1 核心逻辑零框架依赖。

C1 目录约定（对齐 architecture）：packages/core/src/conversation/ 下——domain/session/、domain/message/、domain/（message-keys）、ports/driving/、ports/driven/。
【重要：文件都放在 packages/core/src/conversation/ 子树下，不要污染 SK 的 domain/error、ports/clock 等既有文件。】

核心包铁律（import 守卫 scripts/check-core-imports.mjs 会拦 packages/core）：禁止 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid；禁止直调 Date.now()/new Date()/randomUUID（注释里也别出现连写 "Date.now(" 字样）。
C1 专属铁律：C1 只能 import type 依赖 SK（如 Clock/IdGenerator 类型），绝不反向依赖 C2（TitleGeneratorPort 只 import type 引用别名，不 import C2 实现）；【禁 phase】C1 严禁出现 phase/active/settling/terminal/StreamSession 概念——那属 C2 运行时。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名。strict、ES2022、NodeNext。字段一律 readonly（不可变领域模型）。
术语：禁用「上下文」指代 bounded context，用全称或「领域边界」。注释中文。
测试用 vitest，测试文件与被测同目录 *.test.ts。不要运行 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段统一处理）。
反假数据（AC-10）：可选字段无值时 undefined，严禁落假 0/假空串。
完成后报告创建的文件路径。
`

// ---- 波次1：值对象（无实体依赖，并行）----
phase('ValueObjects')
const wave1 = await parallel([
  () => agent(`${RULES}

任务 c1-1-3：定义 StreamStatus 持久生命周期枚举 + canTransition 谓词。对齐 architecture §3.5。
创建 packages/core/src/conversation/domain/message/stream-status.ts：
- StreamStatus 枚举/联合：'streaming' | 'completed' | 'interrupted' | 'error'（持久转录行生命周期，即「这条消息最终完整/中断/出错」）。
- canTransition(from: StreamStatus, to: StreamStatus): boolean 纯函数：streaming→任一终态(completed/interrupted/error) 合法；终态→任何 非法；streaming→streaming 视需要（幂等可为 true，请注释说明选择）。
- 【禁 phase 关键】JSDoc 中文注释明确：StreamStatus 只表达持久转录行生命周期，绝不表达「现在还在流式吗」的实时相位（那由 C2 回答）；本文件不得出现 phase/active/settling/terminal/StreamSession 字样。
创建 stream-status.test.ts：全量转移矩阵——streaming→三终态各合法、三终态→任何回退非法、覆盖全部组合断言。`,
    { label: 'c1-1-3:stream-status', phase: 'ValueObjects' }),

  () => agent(`${RULES}

任务 c1-1-4：定义 TitleOrigin 来源枚举 + canOverrideTitle 覆盖优先级谓词。对齐 architecture §3.2。
创建 packages/core/src/conversation/domain/session/title-origin.ts：
- TitleOrigin：'default' | 'ai' | 'user'。
- canOverrideTitle(current: TitleOrigin, incoming: TitleOrigin): boolean：优先级 default < ai < user。user 严禁被 ai/default 覆盖；default 可被任何来源覆盖；ai 可被 ai/user 覆盖不被 default 覆盖。请注释写清规则。
创建 title-origin.test.ts：3x3 全矩阵单测（AC-3），逐组合断言 canOverrideTitle 结果。
只定义值对象与谓词，不含 setByUser/generateByAi 用例（属 epic-c1-4）。`,
    { label: 'c1-1-4:title-origin', phase: 'ValueObjects' }),

  () => agent(`${RULES}

任务 c1-1-5：定义 C1 自身 i18n 消息键常量表。仿 SK 的 packages/core/src/domain/error/message-keys.ts 范式（as const + 只读 + satisfies）。
创建 packages/core/src/conversation/domain/message-keys.ts：
- export const C1_MESSAGE_KEYS = { ... } as const —— 含至少 c1.session.defaultTitle（默认标题 'New Chat' 经 key 而非硬编码，NFR-5）、标题来源 badge 文案 key（如 c1.title.origin.default/ai/user）。键为 c1.* 命名空间。
- C1 只贡献键、不含具体文案（locale 表在 apps/api）。
创建 message-keys.test.ts：断言键表只读、命名以 c1. 开头、无重复值、含 defaultTitle 键。`,
    { label: 'c1-1-5:message-keys', phase: 'ValueObjects' }),
])

// ---- 波次2：实体（引用波次1类型，并行）----
phase('Entities')
const wave2 = await parallel([
  () => agent(`${RULES}

任务 c1-1-1：定义 ChatSession 会话本体实体 + 三枚举。对齐 architecture §3.1/§3.2。
波次1已创建 packages/core/src/conversation/domain/session/title-origin.ts（导出 TitleOrigin）。
创建 packages/core/src/conversation/domain/session/chat-session.ts：
- SessionId 类型（string 品牌类型或别名，注释说明）。
- SessionStatus / SessionMode / SessionSource 三枚举（取值以 architecture §3.2 为准；若文档未明确，用合理最小集合并注释来源，如 SessionStatus: 'active'|'archived'；SessionMode: 视文档；SessionSource: 'web'|... 视文档）。请先读 docs/contexts/c1-conversation/architecture.md §3.1/§3.2 取准确取值。
- interface ChatSession，仅 10 个会话本体字段且全 readonly：id(SessionId)、title(string)、titleOrigin(TitleOrigin，import type 自 ./title-origin.js)、status、mode、source、workingDirectory、projectName、createdAt(number)、updatedAt(number)。
- 【字段归属铁律】运行时/Provider/Codex 字段（sdkSessionId/codexThreadId/runtimeStatus/providerId/contextSummary*）严禁进入 ChatSession。JSDoc 注释点明这条。
创建 chat-session.test.ts：类型层断言（构造合法 ChatSession 字面量通过、缺字段/多运行时字段用 @ts-expect-error）、枚举取值断言。`,
    { label: 'c1-1-1:chat-session', phase: 'Entities' }),

  () => agent(`${RULES}

任务 c1-1-2：定义 Message 实体 + MessageRole 枚举 + TokenUsage 投影值对象。对齐 architecture §3.3。
波次1已创建 stream-status.ts（导出 StreamStatus）。
创建 packages/core/src/conversation/domain/message/message.ts（及必要的 token-usage.ts）：
- MessageId 类型。MessageRole 枚举：'user'|'assistant'|'system'（以 architecture §3.3 为准）。
- TokenUsage 投影值对象（interface，全 readonly）：如 inputTokens?/outputTokens?/... 【只存不算的投影：全部可选，无值 undefined，严禁落假 0（AC-10）】。放 token-usage.ts。
- MessageContent 占位类型：本故事不实现编解码（属 epic-c1-2）。定义一个占位 —— 在 packages/core/src/conversation/domain/message/message-content.ts 里 export type MessageContent = unknown（或最小占位 + 注释「编解码属 c1-2」）。Message.content 引用它。
- interface Message，全 readonly：id(MessageId)、role(MessageRole)、content(MessageContent)、createdAt(number)、streamStatus(StreamStatus，import type 自 ./stream-status.js)、tokenUsage?(TokenUsage)、isHeartbeatAck(boolean)、taskRunId?(string)。
创建 message.test.ts + token-usage 相关断言：合法 Message 字面量、tokenUsage 省略时为 undefined（不落假0）、streamStatus 类型引用正确。`,
    { label: 'c1-1-2:message', phase: 'Entities' }),
])

// ---- 波次3：端口骨架 + 守卫（并行）----
phase('PortsGuard')
const wave3 = await parallel([
  () => agent(`${RULES}

任务 c1-1-6：定义 C1 驱动端口 + 被驱动端口骨架。对齐 architecture §4/§5。先读 docs/contexts/c1-conversation/architecture.md §4/§5 确认端口签名。
已存在实体：conversation/domain/session/chat-session.ts、domain/message/message.ts、stream-status.ts、title-origin.ts。
创建：
- ports/driving/ 下 4 个驱动端口接口（用例入口）：ManageSession、SetSessionTitle、AppendMessage、GetSessionHistory。各含必要输入类型（CreateSessionInput/ListSessionsQuery/AppendMessageInput/HistoryQuery 等）。仅接口签名骨架，无实现体（用例逻辑属 c1-3/4/5）。
- ports/driven/ 下 2 个被驱动端口：SessionRepository、MessageRepository（出站持久化契约，接口签名）。
- TitleGeneratorPort：【只 import type 本地引用别名】——C2 定义与实现，C1 只在需要处 import type 一个别名占位（如 import type { TitleGeneratorPort } from '../../../<C2占位>'；若 C2 尚未定义，可在本文件内定义一个最小 import type 别名注释「实际由 C2 提供，C1 绝不 import C2 实现、绝不反向依赖 C2、绝不自己拼 AI 标题提示词」）。请谨慎：不要真的 import 任何 C2 运行实现。稳妥做法：在 ports/driven/title-generator-port.ts 里定义 C1 侧所需的最小 TitleGeneratorPort 接口形状 + 注释说明其权威定义在 C2、此处为 C1 消费视角的类型契约。
全部文件放 packages/core/src/conversation/ports/ 下。用 import type + .js 引用领域类型。不建 index.ts（合并阶段处理）。
创建至少一个 ports 的类型层测试（如构造符合端口输入类型的对象通过编译）。`,
    { label: 'c1-1-6:ports', phase: 'PortsGuard' }),

  () => agent(`${RULES}

任务 c1-1-7：为 C1 conversation 核心包建立/扩展禁用 import 静态守卫。对齐 NFR-1/NFR-2、AC-11/AC-8。
现状：scripts/check-core-imports.mjs 已扫描 packages/core/src 全部（含新增的 conversation/ 子树），禁用清单含 @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、Date.now(、randomUUID。
本故事的增量：【禁 phase 守卫】——C1 特有约束是核心严禁出现 phase 概念。请扩展 scripts/check-core-imports.mjs：新增一组「禁用标识」扫描，针对 conversation/ 子树（或全 core）检测 phase 相关标识：StreamSession、.phase、'active'/'settling'/'terminal' 作为相位标识、以及 crypto 直接 import。命中即失败。
注意实现分寸：
- 'active'/'settling'/'terminal' 作为普通英文词可能误伤（如注释、其他语义）。稳妥做法：只在 conversation/ 子树扫描这些相位标识，且优先匹配强信号 StreamSession 与 .phase（成员访问），对 active/settling/terminal 可仅扫 conversation 下的标识符出现并允许通过注释白名单（谨慎，别过度）。请在脚本里清晰注释你的匹配策略与已知局限。
- 保持对既有 SK 代码 0 误伤（SK 代码里没有 phase，但别让规则波及 apps/api）。
- 给 scripts/check-core-imports.test.ts 补回归用例：含 StreamSession/.phase 的 conversation 样本被拦、干净样本通过。
报告：你新增的扫描规则、匹配策略、误伤防护、补的测试。`,
    { label: 'c1-1-7:guard', phase: 'PortsGuard' }),
])

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C1-E1 的领域实体/值对象/端口/消息键文件已由前序波次创建于 packages/core/src/conversation/ 下，守卫已扩展 phase 检测。
合并+验证：
1. 扫描 packages/core/src/conversation/ 下所有导出（值对象、实体、枚举、TokenUsage、C1_MESSAGE_KEYS、端口接口与输入类型），读文件确认实际导出名。
2. 编辑 packages/core/src/index.ts，在现有 SK 导出后追加一段 C1 导出（注释分节 // ==== C1 Conversation ====）。类型/接口用 export type，值常量（如 C1_MESSAGE_KEYS、canTransition/canOverrideTitle 若是函数值）用 export。模块说明符带 .js。不删改现有 SK 导出行。
   注意 canTransition/canOverrideTitle 是运行时函数值，用 export（非 export type）；StreamStatus/TitleOrigin 若是 type 联合用 export type，若是 enum 是值用 export。以文件实际定义为准。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、守卫 phase 规则误伤、类型引用），反复到全绿。不得违反核心/ C1 铁律，不得让守卫误伤 apps/api 或 SK。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加的 C1 导出行。`,
  { label: 'c1-1:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C1-E1 会话/消息领域模型+端口骨架。项目根：${PROJECT_ROOT}
读 packages/core/src/conversation/ 全部文件 + packages/core/src/index.ts 的 C1 导出段 + scripts/check-core-imports.mjs 的 phase 规则。

权威来源：docs/contexts/c1-conversation/architecture.md §3.1/§3.2/§3.3/§3.5、§4/§5。

重点查（每条判断真缺陷/可接受）：
1. 【禁 phase 铁律】conversation/ 下是否真的零 phase 概念（无 StreamSession/.phase/active/settling/terminal 作相位）？StreamStatus 是否只表达持久生命周期而非实时相位？守卫的 phase 规则是否真能拦住（还是空规则）？
2. 【字段归属】ChatSession 是否只有 10 个会话本体字段、全 readonly？是否混入了运行时/Provider 字段（sdkSessionId/runtimeStatus/providerId 等）——这是必须拦的越界。
3. 【反假数据 AC-10】TokenUsage 是否全可选、无值 undefined 而非假 0？
4. 【C1 不反向依赖 C2】TitleGeneratorPort 是否只 import type/类型契约，没 import 任何 C2 运行实现？C1 是否只 import type 依赖 SK？
5. canTransition（streaming→终态合法、终态→回退非法）与 canOverrideTitle（default<ai<user，user 不被覆盖）逻辑是否正确、测试是否全矩阵真断言？
6. 端口划分：4 驱动端口=用例入口、2 被驱动端口=出站持久化契约，是否只有签名骨架无实现体？
7. verbatimModuleSyntax（import type + .js）、字段 readonly、核心零框架 import。

按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c1-1:review', phase: 'Review' })

return {
  wave1ok: wave1.map((r) => r != null),
  wave2ok: wave2.map((r) => r != null),
  wave3ok: wave3.map((r) => r != null),
  mergeReport,
  review,
}
