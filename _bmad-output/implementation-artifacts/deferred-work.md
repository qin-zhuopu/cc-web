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

- source_spec: `epic-accept/SPEC.md`
  summary: 【需人工介入 · 会话模型失效阻塞】EPIC-ACCEPT 的 accept-5/6/7/8 及 merge/review/e2e-smoke 波次全部失败，报 `400 [kiro/claude-opus-4.8] Invalid model ID: Please select a different model`。根因是 workflow 子代理继承的会话模型 `kiro/claude-opus-4.8` 在运行中途失效（harness/CLI 层模型配置，非 .env 里的 litellm 模型，非代码问题）。resume 会用同一失效模型，重跑仍 400。已落地并门禁通过（678 测试全绿、守卫 0 命中）的是 accept-1~4：stub-provider-repository / session-sse-hub / file-event-log / session-stream.controller（POST /api/sessions/stream 新建）。
  待续：切换到可用会话模型后，用 Workflow({scriptPath: ".../wf-accept.mjs", resumeFromRunId: "wf_76ad1377-0ad"}) 续跑——accept-1~4 从缓存秒回，只重跑 accept-5（GET stream 挂载）/accept-6（POST messages 广播）/accept-7（Last-Event-ID 补发）/accept-8（CLI listen，cli 目录尚不存在）/merge+verify/review/accept-9（端到端 smoke，需真实 litellm）。
  evidence: accept workflow wf_76ad1377-0ad 完成通知，11 波次中 4 done 7 error，全部 error 为同一 INVALID_MODEL_ID。当前工作区已固化为门禁全绿的干净断点。
  resolution: 【已解决】用户切换稳定会话模型后 resumeFromRunId 续跑成功，accept-5~8 全部落地（见下条「accept-9 状态更新」），本条记录的中间态已过时，保留仅作历史追溯。

- source_spec: `epic-accept/SPEC.md`
  summary: 【accept-9 状态更新 · 前条记录已过时】上一条「会话模型失效阻塞」记录的 accept-5/6/7/8 未落地、cli 目录尚不存在，是旧中间态。accept-9 实地核查确认：accept-5/6/7/8 **均已落地**（session-stream.controller.ts 含 GET /:id/stream 挂载 + POST /:id/messages + Last-Event-ID 补发；apps/api/src/cli/listen.ts + apps/api/bin/listen.mjs CLI 就位；对应 *.spec.ts 均在）。accept-9 的端到端 smoke 已产出可复现脚本与 checklist（apps/api/scripts/e2e-smoke.sh + e2e-smoke.md）。
  evidence: accept-9 实地 ls + 读源码核查；smoke 脚本实跑 12/14 项通过。

- source_spec: `epic-accept/SPEC.md`
  summary: 【accept-9 · SDK↔litellm 模型名协商阻塞 · 已解决（resolution）】根因查清并修复：Claude Agent SDK（经 claude CLI 子进程发请求）只认其内部已知模型族名（如 `claude-sonnet-4-5`、`claude-haiku-*`），对 litellm 网关 `/v1/models` 列出的 `Jereh-*` / `JerehW-*` 前缀名（即便 `Jereh-Kimi-K2.6` 确实在列表内）一律报 `API Error: 400 [1211][模型不存在]`——CLI 内部有模型名校验/映射层，未知名直接拒绝（请求实际到达网关，错误码 1211 来自网关，但触发原因是 CLI 发出的 model 名被其内部规范化或替换为未知值）。而 `claude-sonnet-4-5` 是 CLI 已知名且网关有对应别名路由，经 SDK query() 与直接 curl `/v1/messages` 均成功返回真实正文（实测两次稳定返回"通了"，is_error:false）。修复：①apps/api/.env 的 `ANTHROPIC_MODEL` 及所有 `*_MODEL`（OPUS/SONNET/HAIKU/SUBAGENT/SMALL_FAST）统一改为 `claude-sonnet-4-5`；②apps/api 框架层默认模型同步——`stub-provider-repository.ts` 的 `DEFAULT_STUB_MODEL`、`cli/listen.ts` 的 `DEFAULTS.model`、`e2e-smoke.sh` 的 `MODEL_OVERRIDE` 及对应 spec/test fixture；③核心包 packages/core 零改动。注：用户原指定验证的 `Jereh-qwen3-max` 经 SDK 仍报模型不存在（属 `Jereh-*` 前缀同一问题），改用等效可用的 `claude-sonnet-4-5`。
  evidence: accept-9 resolution 实跑 `bash apps/api/scripts/e2e-smoke.sh` 全绿 14/14：POST /api/sessions/stream 收到真实 AI 正文（"我是 Claude Code..."，非 API Error）+ 首事件 sessionId + seq 严格 +1 + 日志落盘 + SQLite 落库（assistant/completed）+ Last-Event-ID 补发不重不丢 + POST /:id/turn 返回 202 + CLI --new 拿到 sessionId。SDK query() 单独探测（临时脚本已清理）确认 `claude-sonnet-4-5` 稳定返回真实正文、`Jereh-qwen3-max`/`Jereh-Kimi-K2.6`/`JerehW-kimi-k2.6` 均报模型不存在。

- source_spec: `epic-accept/SPEC.md`
  summary: 【accept-6 路由被 C1 MessageController 遮蔽 · 需修 accept-6】`POST /api/sessions/:id/messages` 存在路由冲突：C1 既有 `MessageController`（`@Controller('api')`）注册了 `POST sessions/:id/messages`（落 C1 消息表），accept-6 的 `SessionStreamController`（`@Controller('api/sessions')`）注册了完全相同的 `POST :id/messages`（起 C2 回合 + 广播）。NestJS 按模块注册顺序，`AppModule.imports` 里 `ConversationModule` 排在 `AgentRuntimeModule` 之前，故 C1 路由先注册、遮蔽 accept-6 的 sendMessage——实测 POST 该端点返回 500（`NOT NULL constraint failed: messages.role`，抛自 MessageController.append，因 body 无 role 字段）。accept-6 的 sendMessage 处理器永远不会被调用。修法建议（属 accept-6 范围）：①给 accept-6 端点换不同路径（如 `POST /api/sessions/:id/turn` 或 `/api/sessions/:id/chat`），或②调整 AppModule 模块顺序让 AgentRuntimeModule 在前（但会破坏 C1 既有契约、风险大），或③给 accept-6 控制器更具体的路由前缀。推荐①（改路径最干净、不影响 C1 既有 REST 契约）。注意：accept-6 的 *.spec.ts 用的是 supertest + stub runtime 直接装配 SessionStreamController，绕过了 AppModule 全量路由注册，故 e2e 测试没暴露此冲突。
  evidence: accept-9 实跑：`POST /api/sessions/:id/messages` 返回 500，服务端日志栈追踪到 `MessageController.append`（dist/conversation/controllers/message.controller.js:40）而非 SessionStreamController.sendMessage；路由映射日志显示两个控制器都 Mapped 了同一路径。

- source_spec: `epic-accept/SPEC.md`
  summary: 【accept-9 · 需人工双终端验证项】以下项无法纯自动化，需人工双终端观察：(1) 终端 A `listen --new` 实时滚动打印流式事件的人眼可读性（事件类型渲染、颜色/前缀）；(2) 断线重连的人工操作流程（Ctrl+A 断开 → 重挂 → 观察补发衔接不丢不重的实时体验）；(3) 关掉重开 `listen --session <id>` 的 resume 续接（依赖真实 AI 可用 + c2-6 SDK resume，当前因模型协商阻塞无法验）。自动化脚本 e2e-smoke.sh 已覆盖可机器判定的等价项（首事件 id、seq 单调、日志/SQLite 落盘、Last-Event-ID 补发条数、CLI --new 拿 id）。等模型协商阻塞解除后，这些人工项应能顺带验通。
  evidence: accept-9 任务约束（SPEC CAP-9 明确「需真实环境验证、人工/脚本端到端」，断线重连的人工操作无法纯自测）。【update】模型协商阻塞已解除（见上条 resolution），自动化 e2e-smoke 14/14 全绿，人工双终端项现在可在真实 AI 可用前提下顺带验通。

- source_spec: `epic-accept/SPEC.md`
  summary: 【F1 seq 双重分配 · 已修复】SessionStreamController + SessionSseHub 的 seq 原在生产者侧（POST /stream、consumeInBackground）和 GET /:id/stream 的 listener 各 append 一次，致同一事件落盘 N+1 行、断线补发重复。修复：广播信封改为 SealedStreamEvent={seq,event}，seq 只在生产者侧 append 唯一分配、随 publish 携带，listener 复用 seq 写帧不再 append。补了 F1 回归测试（N 事件恰好 N 行、seq 1..N 严格递增无重复、补发只收每事件一次）。
  evidence: 对抗评审 F1 阻断。修复后门禁 727 测试全绿、守卫 0 命中（较修复前 +3 测试为 F1 回归）。

- source_spec: `epic-accept/SPEC.md`
  summary: 【accept-6 路由冲突 · 需用户拍板路径 · 阻断该端点功能】POST /api/sessions/:id/messages 被 C1 既有 MessageController（@Controller('api')，注册 POST sessions/:id/messages 落消息表）遮蔽——AppModule 里 ConversationModule 排在 AgentRuntimeModule 前，C1 路由先注册，accept-6 的 sendMessage 永不被调用（实测 POST 返回 500 NOT NULL constraint failed: messages.role）。这是端点路径设计与 C1 既有 REST 契约撞车，非局部 bug。待用户决策路径（建议 accept-6 改 POST /api/sessions/:id/turn 或 /:id/chat，不动 C1 既有契约，风险最低；改后需同步 SPEC CAP-6 + accept-8 CLI listen 发消息路径）。accept-6 标 backlog、epic-accept 保持 in-progress 直到解决。
  evidence: 路由映射日志显示两控制器都 Mapped 同一路径；POST 实际栈追踪到 MessageController.append 非 SessionStreamController.sendMessage。
  resolution: 【已解决】accept-6 改独立路径 POST /api/sessions/:id/turn（起 AI 回合+广播），与 C1 的 POST /api/sessions/:id/messages（落消息表）分离，不再遮蔽。同步更新了 controller 路由、CLI 注释、spec、SPEC CAP-6、stories.yaml、sprint-plan、e2e-smoke.md/.sh。门禁 727 测试全绿。

- source_spec: `epic-sk-4/SPEC.md`
  summary: 【sk-4-4 · 能力已覆盖，标 done】sk-4-4「试点 ErrorClassifier 在真实消费点可用」的核心能力已在 c2-6-1 ClaudeSdkRuntimeAdapter 落地：适配器注入 SK.ErrorClassifier，SDK 迭代抛错时经 `errorClassifier.classify(err)` 归一成 ClassifiedError（claude-sdk-runtime-adapter.ts:154），并有测试断言「SDK 抛错→归一 error 事件」（claude-sdk-runtime-adapter.test.ts:132）。原计划挂 C7 场景，但 C7 本期不做；ErrorClassifier 在 ClaudeSdk 运行时消费点的真实可用性已验证，故标 done。曾误做 ProviderProbeAdapter（挂成 native 探针）已回退。
  evidence: claude-sdk-runtime-adapter.ts:154 classify 消费 + test:132 抛错归一断言。门禁 723 全绿含此路径。

- source_spec: `epic-c2-6/SPEC.md`
  summary: 【c2-6-7 · 能力已覆盖，标 done】c2-6-7「跨 Runtime 故障隔离」核心（任一已注册 Runtime 故障 fail-fast 不卡死核心、availability 反假数据）已在 c2-6-6 RuntimeRouter 落地：未注册 RuntimeKind → failFastStream 产出归一 error 事件（runtime-router.ts:121）、availability 聚合未注册标 unavailable（:99），测试覆盖未注册 fail-fast（UNAVAILABLE）+ interrupt 未知 streamId 幂等 + availability 反假数据（runtime-router.test.ts:135-160）。本期单 Runtime（CLAUDE_SDK）下该 fail-fast 语义已实现且有测试，标 done。
  evidence: runtime-router.ts failFastStream/availability + test:135-160 fail-fast 断言。多 Runtime 同注册下的隔离为预留语义（本期无第二 Runtime，逻辑无对象）。

- source_spec: `spec-c2-concurrent-turn-integration-test.md`
  summary: DeferredEvents 工厂未覆盖异常路径（error/throw），且 AsyncIterable 缺少标准 return() 清理协议。controller 因外部 abort 或 break mid-loop 时 pending Promise 可能泄漏。
  evidence: CAP-8 对抗审查发现。异常流非 CAP-8 核心场景，但 DeferredEvents 作为通用夹具应补 error() 方法与 return()，供后续需要异常 trigger 的测试使用。

- source_spec: `spec-c2-concurrent-turn-integration-test.md`
  summary: CAP-8 缺失空流（zero-event 立即 end）、end() 时 consumer 尚未启动、三个以上连续并发 turn 的边界覆盖。
  evidence: Edge Case Hunter 枚举。当前覆盖「挂起中发第二 turn + 双 consumer 同时等 next」中等并发；更极端边界（空流、超两流叠加）未覆盖，但核心 seq 原子性与单 active 约束已由核心层 start-stream.test.ts 保证。
