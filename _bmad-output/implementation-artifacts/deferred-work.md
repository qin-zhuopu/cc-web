# 延后工作清单（Deferred Work）

> 由 bmad-quick-dev 评审流程追加。每条记录一个真实但非当前故事范围的发现，供后续 story 聚焦处理。追加式，勿改既有条目。

- source_spec: `spec-sk-1-1-define-16-error-codes-and-domain-types.md`
  summary: import 静态守卫升级为 ESLint 规则并扩展拦截能力（node:* 内建、别名绕过 Date.now/Math.random、blocklist 改 allowlist、.mts/.cts 扫描、跨行/块注释）。
  evidence: 本轮守卫为零依赖正则脚本，够用于 sk-1-1 门禁但存在多条已知绕过面（别名调用、node:fs 等内建、backtick 模块说明符、非白名单第三方包）。SK-4 story 4.3「禁用 import 静态检查守卫」正是这条能力的正式落地位；spec Design Notes 已声明「后续 SK-4 可升级为 ESLint 规则」。本轮只做到零依赖脚本级门禁。

- source_spec: `epic-sk-4/SPEC.md`
  summary: SharedKernelModule 冒烟测试补 TranslationPort（真实 JsonTranslationTable 适配器）的 AC-5 行为断言；check-core-imports.mjs 块注释扫描顺延项措辞更新。
  evidence: SK-4 对抗评审低优先项。TranslationPort 的 AC-5（缺失键返回键名、has 返回 false）目前只在核心端口测试的内联 FakeTranslation 上验证，真实占位适配器 JsonTranslationTable 仅有 toBeDefined 断言，缺行为断言。中等问题（JsonTranslationTable 未 implements）已在本轮修复。

- source_spec: `epic-sk-4/SPEC.md`
  summary: SK-4 的 6 个占位适配器（SystemClock/UuidGenerator/NodePlatform/RegexRedactor/RingBufferRuntimeLog/JsonTranslationTable）为 DI 装配用最小实现，需在后续 story 替换为生产级实现（真实脱敏正则、有界环形缓冲、locale 文案表等）。
  evidence: 本轮 SK-4 重点是 SharedKernelModule 接线骨架，占位适配器让 DI 图能装配、能被解析、能被替换。生产级适配器实现（含各自完整单测）属后续工作。

- source_spec: `epic-c1-4/SPEC.md`
  summary: SetSessionTitleService 注入的 Clock 未使用（死依赖）——确认「改名/AI起名是否该 bump updatedAt」的设计意图；若不需要则从该用例构造签名移除 Clock。
  evidence: C1-E4 对抗评审 low 项。构造注入 clock 但全文无 clock.now() 调用，改标题不 touch updatedAt（与归档不 touch 一致，可能刻意）。空串标题守卫（写脏空标题）已在本轮修复。

- source_spec: `epic-c1-4/SPEC.md`
  summary: generateByAi 中 canOverrideTitle('ai') 检查为死分支（user 已早退，剩余 default/ai 对 ai 恒放行），且排在 generateTitle 调用之后——未来若新增「可覆盖为 false 但非 user」的态会白浪费一次 AI 调用；应把覆盖性判定前移到调用之前。
  evidence: C1-E4 对抗评审 nitpick。当前防御性冗余无害。

- source_spec: `epic-c1-4/SPEC.md`
  summary: TitleOrigin 用联合字面量，而同目录 SessionStatus/Mode/Source 用 enum，同一领域枚举/联合混用偏离 architecture §3.2 字面（§3.2 写的是 enum）。建议统一（联合更契合零框架/tree-shake），若统一为联合需同步修订架构文档。
  evidence: C1-E1/E4 对抗评审 nitpick。字面量值一致，DB/跨边界持久化兼容无碍，仅风格偏差。

- source_spec: `epic-c1-5/SPEC.md`
  summary: AppendMessageService 未注入/未用 RuntimeLog，偏离 architecture §6/§7（§7 要求构造注入 RuntimeLog、§6 要求关键写路径经 SK.RuntimeLog source=c1.message）。append/updateStreamStatus 均为关键写路径却无日志。
  evidence: C1-E5 对抗评审 low 项。本轮为纯逻辑用例裁剪了可观测性依赖；接线到 c1-6 时应补 RuntimeLog 注入与写路径日志。

- source_spec: `epic-c1-5/SPEC.md`
  summary: getPromptView 对 taskRunId 的剥离过宽——剔除条件为「凡带 taskRunId 者整条剔除」，依赖「带 taskRunId 必为纯 marker」这一未在类型层固化的约定。建议在 architecture §3.3 或字段处把该前提写死，避免真实内容挂 taskRunId 时被误剔。
  evidence: C1-E5 对抗评审 low 项。当前与现有字段语义自洽、可接受，但约定未固化有后续误用风险。

- source_spec: `epic-c2-5/SPEC.md`
  summary: 【correct-course 候选】超时终态的 terminalReason.code 被记成 USER_ABORTED。AbortStreamService.settleTimeout 只能复用 c2-2 聚合根的 StreamSession.abort()，而该方法硬编码 TerminalReasonCode.USER_ABORTED（stream-session.ts:290）。于是 idle/tool 超时回合的 error.code 虽正确（TIMEOUT/PROCESS），但 terminalReason.code 恒为 USER_ABORTED，与 terminal-reason.ts 的 isUserAbort() 语义矛盾——消费方若用 isUserAbort(terminalReason.code) 判定会把超时误判成「用户主动停的」。建议走 correct-course 给聚合根加带归因码的 abort 重载（如 abort(reason, terminalReasonCode?)）或超时专用迁移方法。
  evidence: C2-E5 对抗评审 nitpick #1（非阻断）。error.code 归因正确（AC-5 据此满足、测试已覆盖），仅 terminalReason.code 这一路误标。根因在 c2-2 已冻结的聚合根 abort 硬编码归因码，超出 c2-5「只复用不改聚合根」范围，故延后而非本 epic 擅改。

- source_spec: `epic-c2-5/SPEC.md`
  summary: AbortStreamService 注入的 SK.Clock 当前为死依赖（abort-stream.ts 内 void this.clock，settledAt 由 StreamSession 自带 Clock 记）；settleTimeout 是服务公有方法但未在 AbortStreamUseCase 端口声明（c2-7 接线若需从端口触发超时归因要补端口方法，定时触发机制属 c2-6）。
  evidence: C2-E5 对抗评审 nitpick #2/#3（非阻断）。Clock 构造注入以备后续故事、符合「一次性注入」意图但当前无用途；settleTimeout 不在端口属架构 loose end，本 epic 定时触发不在范围内，可接受。

- source_spec: `epic-c2-7/SPEC.md`
  summary: agent-runtime.module.spec.ts 在默认 vitest worker pool 下，NestFactory 初始化错误被 `process.abort() is not supported in workers` 掩盖，使 import 期崩溃伪装成无信息量的普通 fail。建议 spec 加 `abortOnError: false` 或改 fork pool，让 DI 装配错误真实浮现——否则未来任何接线错都以同一句 worker 报错出现，验证形同虚设。
  evidence: C2-E7 对抗评审 nitpick #1（非阻断）。本次 2 个阻断（index.ts 漏导出、conversation.module 缺 forwardRef）修复后门禁已全绿（650 测试通过、守卫 0 命中），此项为测试可观测性改进，不影响功能正确性。

- source_spec: `epic-c2-7/SPEC.md`
  summary: conversation.module.ts 的 `AgentRuntimeModule` import 在补 forwardRef 前为「只导入未使用」；若将来开启 `noUnusedLocals` 会报错。本次修复已把它用进 imports 数组，此项已随阻断2修复消解，仅记录以备 tsconfig 严格化时复查。
  evidence: C2-E7 对抗评审 nitpick #2（非阻断，且已随阻断2修复解决）。
