export const meta = {
  name: 'c2-7-titlegen-permission-nestwiring',
  description: 'C2-E7 TitleGenerator + 权限中转 + NestJS 接线：串行 GenerateTitleService(核心非流式)→ForceAbortScheduler生产实现→权限决议中转端口+Controller→AgentRuntimeModule DI(forwardRef解C1↔C2环)→Chat/Runtime控制器→终态映射闭合，合并门禁再对抗评审',
  phases: [
    { title: 'TitleService', detail: 'c2-7-1 GenerateTitleService 核心非流式标题生成（隔离主回合）' },
    { title: 'SchedulerImpl', detail: 'c2-7-3 SetTimeoutForceAbortScheduler 生产实现（apps/api）' },
    { title: 'PermissionRelay', detail: 'c2-7-2 权限决议中转端口最小扩展 + PermissionController' },
    { title: 'ModuleWiring', detail: 'c2-7-4 AgentRuntimeModule DI + forwardRef 解 C1↔C2 环' },
    { title: 'Controllers', detail: 'c2-7-5 Chat/Runtime 控制器接驱动端口' },
    { title: 'TerminalMapping', detail: 'c2-7-6 终态→C1 StreamStatus 映射接线闭合' },
    { title: 'Merge+Verify', detail: '桶文件导出 + 跑 npm run test 自修到绿' },
    { title: 'Review', detail: '对抗评审 AC-13隔离/forwardRef解环/不做经纪判定/不重写映射' },
  ],
}

const PROJECT_ROOT = '/home/dev/repo/github.com/qin-zhuopu/cc-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在实现 C2-E7：TitleGenerator + 权限中转 + NestJS 接线（C2 基础设施收尾层）。
权威源必读：docs/contexts/c2-agent-runtime/architecture.md（§6.4 终态映射、§6.5 标题、§7.1、§8 DI 接线签名）、docs/contexts/c2-agent-runtime/prd.md（FR-6/FR-7/AC-12/AC-13/AC-15）、_bmad-output/implementation-artifacts/epic-c2-7/SPEC.md（CAP-1~6 契约）、epic-c2-7/stories.yaml（各故事 invoke_dev_with）。

【本 epic 分层铁律 · 最重要 · 决定文件落点】
- 只有 GenerateTitleService（CAP-1）落 packages/core/src/agent-runtime/usecases/，受核心零框架铁律约束：禁 import @nestjs/* / @anthropic-ai/* / better-sqlite3 / node:child_process / node:timers / codex / uuid；禁直调 setTimeout/setInterval/Date.now()/new Date()/randomUUID()（scripts/check-core-imports.mjs 守卫会拦，注释里也别连写 "Date.now(" / "setTimeout("）。取时经注入 SK.Clock。
- 其余全部（AgentRuntimeModule、三个 Controller、SetTimeoutForceAbortScheduler、C7 stub 装配）落 apps/api/src/agent-runtime/，是框架层：允许 import @nestjs/*、允许 setTimeout/clearTimeout、允许接 SDK 适配器。核心铁律不约束 apps/api。

【复用既有，绝不重写/改签名】（先读确认真实签名再装配）：
- c2-1 端口 packages/core/src/agent-runtime/ports/：driving/title-generator.ts（TitleGenerator.generateTitle(input: TitleGenerationInput): Promise<string>）、driving/start-stream-usecase.ts、driving/abort-stream-usecase.ts、driven/agent-runtime-port.ts（AgentRuntimePort: run/interrupt/forceKillTurn/availability + TurnRef{streamId,native?}）、driven/provider-read-port.ts（ProviderReadPort）。
- c2-4 packages/core/src/agent-runtime/usecases/start-stream.ts：StartStreamService（构造 8 参：registry, runtime, providers, history, messages, idGenerator, clock, errorClassifier——务必读文件确认精确顺序）、terminalSubstateToStreamStatus 映射纯函数（就在此文件内，completed→'completed'/aborted→'interrupted'/errored→'error'，绝不重写）、StreamSessionRegistry。
- c2-5 usecases/abort-stream.ts：AbortStreamService（构造 5 参：runtime, registry, scheduler, errorClassifier, clock——读文件确认）；ports/driven/force-abort-scheduler.ts：ForceAbortScheduler 接口 + FORCE_ABORT_MS 常量。
- c2-6 apps/api/src/agent-runtime/runtime-router.ts：RuntimeRouter（构造 adapters map + errorClassifier，实现 AgentRuntimePort，本期只注册 CLAUDE_SDK）；ClaudeSdkRuntimeAdapter。
- C1：apps/api/src/conversation/conversation.module.ts 提供 APPEND_MESSAGE_USECASE / GET_SESSION_HISTORY_USECASE token，TITLE_GENERATOR 当前绑 StubTitleGenerator。
- SK：SharedKernelModule 提供 CLOCK/ID_GENERATOR/RUNTIME_LOG/ERROR_CLASSIFIER/TRANSLATION_PORT token。
接线时构造参数顺序【务必严格对齐 core 里各 service 的 constructor】（对齐既有 conversation.module.ts 的「构造参数顺序严格对齐 core」注释纪律）。绝不用 as any 绕类型、绝不把 C1 实体/StreamStatus import 进 C2 核心做实时判断。

TypeScript（verbatimModuleSyntax 已启用）：类型-only import 用 import type + 模块说明符带 .js 扩展名（NodeNext）；值 import（聚合根/纯函数/枚举/class）走普通 import + .js；字段 readonly。apps/api 侧遵循既有 Module 的 @codepilot/core 桶导入 + import type 风格。
术语中文，禁用「上下文」指代 bounded context（用全称或「领域边界」）。用户可见文案走 c2.* messageKey。
测试：core 用 *.test.ts、apps/api 用 *.spec.ts，同目录。假替身按需自建。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段统一处理）。
完成后报告改/建的文件清单。
`

// ---- 波次1：GenerateTitleService（核心纯逻辑，先行；与波次2 无文件重叠可视为独立但此处串行确保稳定）----
phase('TitleService')
const r1 = await agent(`${RULES}

任务 c2-7-1：GenerateTitleService 非流式一次性标题生成。对齐 SPEC CAP-1、architecture §6.5/§8、PRD FR-6/AC-13、stories.yaml c2-7-1 的 invoke_dev_with。
新建 packages/core/src/agent-runtime/usecases/generate-title.ts：class GenerateTitleService implements TitleGenerator（复用 c2-1 ports/driving/title-generator.ts，绝不重定义端口）。
- 先读 title-generator.ts 确认 generateTitle(input: TitleGenerationInput): Promise<string> 与 TitleGenerationInput 精确形状；读 provider-read-port.ts、agent-runtime-port.ts 确认 run 的入参 RuntimeRunRequest 与归一事件流形状。
- 构造注入端口接口（对齐 architecture §8：AgentRuntimePort（轻量非流式）+ ProviderReadPort；如需归错/日志再注入 SK.ErrorClassifier/RuntimeLog）。
- generateTitle：经 ProviderReadPort 拿 provider 视图 → 组装轻量运行请求（用 input 的近期消息纯文本 + 标题提示）→ 一次性消费 AgentRuntimePort.run 的归一事件流，只提取 text 事件产物拼成标题串返回，消费完即弃。
- 【AC-13 隔离铁律 · 本故事命门】绝不 idGenerator.next() 造用户可见 streamId、绝不 new StreamSession、绝不 registry.register、绝不影响任何 canAccept()——与主回合流式路径完全隔离。构造上最好根本不持有 StreamSessionRegistry。
- Runtime 失败/抛错 → generateTitle 抛出（供 C1 SetSessionTitleService 降级），绝不静默返回空串造假标题。
新建 generate-title.test.ts（假 AgentRuntimePort 产 text 事件 + 假 ProviderReadPort + spy registry）：正常产出返回拼好标题；spy 断言全程 registry.register 零调用、无 new StreamSession（构造不持有 registry 或未调其写方法）；Runtime 抛错 → generateTitle 抛出。
核心零框架铁律（守卫会拦）；import type + .js；readonly；术语中文。不改 index.ts、不跑 npm run test。`,
  { label: 'c2-7-1:generate-title', phase: 'TitleService' })

// ---- 波次2：SetTimeoutForceAbortScheduler（apps/api，独立文件，不碰核心/Module）----
phase('SchedulerImpl')
const r3 = await agent(`${RULES}

任务 c2-7-3：ForceAbortScheduler 的 setTimeout 生产实现。对齐 SPEC CAP-5、architecture §4.2、c2-5 SPEC「setTimeout 生产实现属 c2-7」、stories.yaml c2-7-3。
新建 apps/api/src/agent-runtime/adapters/set-timeout-force-abort-scheduler.ts：
- class SetTimeoutForceAbortScheduler implements ForceAbortScheduler（复用 c2-5 端口，从 @codepilot/core 桶 import type ForceAbortScheduler）。
- schedule(callback, delayMs) 经 setTimeout(callback, delayMs) 安排，返回的 cancel 函数经 clearTimeout 取消；已到期/已触发后再 cancel 为 no-op（不抛）。
- apps/api 框架层允许 setTimeout/clearTimeout（不受核心铁律约束）。
新建 set-timeout-force-abort-scheduler.spec.ts（vitest，vi.useFakeTimers）：schedule 后 vi.advanceTimersByTime 触发 callback；cancel 后推进不触发；重复 cancel 不抛。
本 scheduler 在 c2-7-4 经 AgentRuntimeModule 注入 AbortStreamService（其构造第 3 参 scheduler）。
import type + .js；术语中文；@codepilot/core 桶导入风格对齐既有 apps/api 文件。不跑 npm run test。`,
  { label: 'c2-7-3:scheduler-impl', phase: 'SchedulerImpl' })

// ---- 波次3：权限决议中转端口最小扩展 + PermissionController（改 core 端口 + apps/api Controller + RuntimeRouter/Adapter）----
phase('PermissionRelay')
const r2 = await agent(`${RULES}

任务 c2-7-2：权限决议中转契约 + PermissionController（忠实转发，C2 不做经纪判定）。对齐 SPEC CAP-2、PRD FR-7.2/7.3、stories.yaml c2-7-2。
先读 c2-1 端口 packages/core/src/agent-runtime/ports/driven/agent-runtime-port.ts 确认当前只有 run/interrupt/forceKillTurn/availability。权限【请求】已由 EventMapper 归一成 permission_request 事件（c2-3 事件模型内，本故事不重造事件类型）。本故事接通【决议回传】：
① AgentRuntimePort 最小扩展：新增决议投递签名 resolvePermission(turnRef: TurnRef, decision: PermissionDecision): void | Promise<void>（这是对既有端口的最小扩展，在端口注释记录属 c2-7 扩展）。定义 PermissionDecision 类型（含 permissionRequestId + status: 'allow'|'allow_session'|'deny' + 可选 updatedInput/denyMessage）——放在合适的 core 端口/类型文件（就近 agent-runtime 的 domain 或 ports），import type + .js。
   - RuntimeRouter（apps/api/src/agent-runtime/runtime-router.ts）实现 resolvePermission：按 turnRef.streamId 定位适配器委派（对齐既有 interrupt/forceKillTurn 路由方式）。
   - ClaudeSdkRuntimeAdapter 补最小实现或占位（真实 SDK 决议投递可待适配器完善，但中转契约绝不吞决议——至少记录/转发，别静默丢弃）。
② apps/api/src/agent-runtime/controllers/permission.controller.ts：PermissionController，POST /api/chat/permission，解析决议 body → 经注入的 AgentRuntimePort(RuntimeRouter).resolvePermission 转发 → 对应适配器。
   - C2 侧【绝无】经纪逻辑（无自动批准/超时自动拒绝/任何裁决）——那全归 C5。只忠实透传 permissionRequestId/status/updatedInput/denyMessage。
   - 【安全】此为本机无鉴权端点，注释显式记录无鉴权、生产化前需补访问控制。
apps/api 框架层允许 import @nestjs/*；控制器依赖经 Module 注入（在 c2-7-4 统一注册，本故事先落类与 provider token 需求）。
单测：core 侧若加了 PermissionDecision 类型可加轻量类型/构造测；apps/api 侧 permission.controller.spec.ts（假 AgentRuntimePort spy）：给定决议 → resolvePermission 被调、permissionRequestId/status 忠实透传、C2 未篡改未裁决。
若 core 端口扩展触及 index.ts 导出，先只改端口文件，导出留给合并阶段。import type + .js；术语中文。不跑 npm run test。
注意：本故事会改 packages/core 的端口文件（加 resolvePermission 签名 + PermissionDecision 类型）——这属端口最小扩展，确保 RuntimeRouter 与 ClaudeSdkRuntimeAdapter 都补齐实现，否则 tsc 报未实现接口。`,
  { label: 'c2-7-2:permission-relay', phase: 'PermissionRelay' })

// ---- 波次4：AgentRuntimeModule DI + forwardRef 解环（装配前面所有 service，改 ConversationModule）----
phase('ModuleWiring')
const r4 = await agent(`${RULES}

任务 c2-7-4：AgentRuntimeModule DI 接线 + forwardRef 解 C1↔C2 环。对齐 SPEC CAP-3、architecture §8、stories.yaml c2-7-4。这是 apps/api 能否启动的关键接线闭合点。
先读 apps/api/src/conversation/conversation.module.ts 与 conversation.module.spec.ts 学 useFactory 手工注入范式（core 无 @Injectable，DI 全在此接线；构造参数顺序严格对齐 core constructor）。再读 c2-4 start-stream.ts / c2-5 abort-stream.ts / c2-6 runtime-router.ts 确认各 service 精确构造签名。
新建 apps/api/src/agent-runtime/agent-runtime.module.ts + agent-runtime.tokens.ts（token 常量：START_STREAM_USECASE / ABORT_STREAM_USECASE / AGENT_RUNTIME_PORT / TITLE_GENERATOR / 及内部 registry/scheduler/provider token）：
providers（useFactory，构造签名务必对齐 core，参数顺序错了会 tsc 报错或运行时崩）：
  - StreamSessionRegistry（c2-4，值 import；以 new StreamSessionRegistry() 装配，先读确认可直接实例化、无参或其构造参数）。
  - SetTimeoutForceAbortScheduler（c2-7-3）。
  - C7 ProviderReadPort stub（本期最小只读 stub，返回写死单个 Claude provider；若已有 ProviderManagementModule/stub 则复用，否则本地建最小 stub provider）。
  - ClaudeSdkRuntimeAdapter（c2-6）+ RuntimeRouter（c2-6，构造 adapters map { [RuntimeKind.CLAUDE_SDK]: claudeSdkAdapter } + errorClassifier）作为 AGENT_RUNTIME_PORT 实现。
  - StartStreamService（c2-4，8 参，顺序对齐其 constructor：registry, runtime(=RuntimeRouter), providers(=C7 stub), history(=C1 GET_SESSION_HISTORY_USECASE 经 forwardRef 注入), messages(=C1 APPEND_MESSAGE_USECASE 经 forwardRef 注入), idGenerator, clock, errorClassifier）。
  - AbortStreamService（c2-5，5 参：runtime(=RuntimeRouter), registry, scheduler(=SetTimeout...), errorClassifier, clock）。
  - GenerateTitleService（c2-7-1，构造对齐其 constructor：AgentRuntimePort + ProviderReadPort + 必要 SK 端口）。
imports: [SharedKernelModule, <C7 stub module 或本地 provider>, forwardRef(() => ConversationModule)]。
exports: START_STREAM_USECASE, ABORT_STREAM_USECASE, AGENT_RUNTIME_PORT（供 C3）, TITLE_GENERATOR（供 C1，forwardRef 另一侧）。
controllers: [ChatController, PermissionController, RuntimeController]（ChatController/RuntimeController 类在 c2-7-5 落、PermissionController 在 c2-7-2 落；本故事在 Module 注册它们——若类尚未落，先注册已存在的，缺的在其故事补注册，确保最终三个都注册）。
【解环关键】编辑 apps/api/src/conversation/conversation.module.ts：TITLE_GENERATOR 从 StubTitleGenerator 改绑为经 forwardRef(() => AgentRuntimeModule) 注入的 GenerateTitleService（TITLE_GENERATOR token 从 C2 exports 取）。两侧 forwardRef 才能解环。StubTitleGenerator 退场或仅留 fallback 注释。
编辑根模块 apps/api/src/app.module.ts（读确认路径）注册 AgentRuntimeModule。
新建 agent-runtime.module.spec.ts（对齐 conversation.module.spec.ts 范式，Test.createTestingModule）：断言能解析 START_STREAM_USECASE/ABORT_STREAM_USECASE/TITLE_GENERATOR/AGENT_RUNTIME_PORT；C1↔C2 双向依赖经 forwardRef 解、无 Nest 循环依赖报错。
核心包之间只单向 import type、无实现级环；禁 as any、禁把 C1 实体/StreamStatus import 进 C2 核心。术语中文。不跑 npm run test。`,
  { label: 'c2-7-4:module-wiring', phase: 'ModuleWiring' })

// ---- 波次5：Chat/Runtime 控制器（往 c2-7-4 的 Module 里补，改 Module controllers）----
phase('Controllers')
const r5 = await agent(`${RULES}

任务 c2-7-5：驱动适配器 Chat/Runtime 控制器。对齐 SPEC CAP-4、PRD §0 反假数据、stories.yaml c2-7-5。
新建 apps/api/src/agent-runtime/controllers/chat.controller.ts 与 runtime.controller.ts（PermissionController 属 c2-7-2，已落）：
ChatController：
  - POST /api/chat 解析 body（对齐 StartStreamInput：sessionId/content/mode/model/providerId + 可选字段，先读 start-stream-usecase.ts 确认入参）→ START_STREAM_USECASE.start → 把 StartStreamResult.events 逐事件写为 SSE 帧（观察 apps/api 现有 SSE 能力：NestJS @Sse 或手写 response 流，选与既有一致的方式）。
  - POST /api/chat/interrupt 解析 streamId → ABORT_STREAM_USECASE.abort。
RuntimeController：GET /api/runtime/availability → AGENT_RUNTIME_PORT.availability() 投影（未注册 Runtime 显 unavailable/unknown，绝不显假 ready，反假数据）。
控制器【薄层】：只翻译 HTTP body ↔ 用例入参、事件流 ↔ SSE 帧，不含业务判定；SSE 帧透传归一事件不伪造；用户可见状态字段语义来源对齐 PRD §0。
本故事不实现 SSE 广播 fan-out / 文件日志 / Last-Event-ID 补发 / CLI（属 S9 验收链路），只落最小 SSE 直推。
【安全】/api/chat 等为本机无鉴权端点（sprint-plan「无 UI 本机后端」定位），控制器注释显式记录无鉴权、生产化前需补访问控制。
确认三个控制器都注册进 AgentRuntimeModule.controllers（c2-7-4 已建 Module；本故事把 ChatController/RuntimeController 补进 controllers 数组，若已注册则确认）。
apps/api 框架层允许 import @nestjs/*；依赖经 Module 注入（START_STREAM_USECASE/ABORT_STREAM_USECASE/AGENT_RUNTIME_PORT token）。
新建 chat.controller.spec.ts / runtime.controller.spec.ts（假用例 spy）：POST /api/chat 触发 start 且事件写为 SSE 帧；interrupt 调 abort；availability 返回投影不伪造 ready。
import type + .js；术语中文。不跑 npm run test。`,
  { label: 'c2-7-5:controllers', phase: 'Controllers' })

// ---- 波次6：终态映射接线闭合（在 Module 接线上做闭合确认与测试）----
phase('TerminalMapping')
const r6 = await agent(`${RULES}

任务 c2-7-6：终态 → C1 持久 StreamStatus 映射接线闭合。对齐 SPEC CAP-6、PRD FR-2.5/NFR-8/AC-12/AC-15、architecture §6.4、stories.yaml c2-7-6。
本故事在 c2-7-4 的 AgentRuntimeModule 接线上做映射链路的【闭合确认与测试】，不新增映射逻辑（terminalSubstateToStreamStatus 在 packages/core/src/agent-runtime/usecases/start-stream.ts 已实现并经 c2-4 测过，绝不重写）：
① 确认 StartStreamService 的 messages 依赖经 AgentRuntimeModule（forwardRef）绑定到 C1 真实 APPEND_MESSAGE_USECASE（AppendMessageService），非 stub——回合终态经 persistTerminalTurn → AppendMessageUseCase 写回（含 streamStatus 映射）真正落 C1 持久层。先读 start-stream.ts 确认终态落库路径与方法名。
② 接线/集成层断言（Test.createTestingModule + 假 C1 AppendMessageUseCase spy，或轻量集成）：
   terminal(completed)→写回 streamStatus='completed'、terminal(aborted)→'interrupted'、terminal(errored)→'error'；无「C2 完成但 C1 存 streaming」漂移（AC-12）。
   只经 C1.AppendMessageUseCase 端口写、C2 不直写库、不传 phase 本身给 C1（AC-12）；phase 是内存态、不出现在任何持久化路径（AC-15）。
apps/api 框架层；依赖经 Module 注入。若映射链路已在 c2-7-4/既有 c2-4 测覆盖，本故事补接线级断言（端口绑定正确 + 无漂移）即可，不造重复纯函数测试。
新建/补充 apps/api 侧接线测试（*.spec.ts）。import type + .js；术语中文。报告你补的断言与确认的绑定链路。不跑 npm run test。`,
  { label: 'c2-7-6:terminal-mapping', phase: 'TerminalMapping' })

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C2-E7 各故事已实现：核心 GenerateTitleService（+ 可能的 PermissionDecision 类型/端口扩展）于 packages/core，AgentRuntimeModule/三控制器/SetTimeoutForceAbortScheduler/C7 stub 于 apps/api。
合并 + 验证：
1. 读 packages/core/src/agent-runtime/usecases/generate-title.ts、被 c2-7-2 改动的端口文件（agent-runtime-port.ts 及 PermissionDecision 类型所在文件）确认实际导出名。
2. 编辑 packages/core/src/index.ts：C2 段追加导出 GenerateTitleService（class 值 export）、PermissionDecision（若新增，export type）、resolvePermission 相关类型（若有）；.js 说明符；注意与已有导出防同名冲突，不删改无关行。
3. 项目根跑 npm run test（typecheck + check-core-imports + vitest）。失败就修，重点排查：
   - verbatimModuleSyntax（import type + .js 遗漏）；
   - 核心守卫命中（GenerateTitleService 里误用 setTimeout/Date.now/randomUUID/禁用 import——守卫须对新增核心文件 0 命中，且不误伤 apps/api）；
   - AgentRuntimeModule 构造参数顺序与 core constructor 不符（StartStreamService 8 参 / AbortStreamService 5 参 / RuntimeRouter）；
   - forwardRef 两侧未接好导致 Nest 循环依赖 / DI 无法解析；
   - RuntimeRouter/ClaudeSdkRuntimeAdapter 未实现新增的 resolvePermission 导致 tsc 报未实现接口；
   - index.ts 同名冲突。
   反复修到全绿。守卫保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck 结果 / check-core-imports 命中数 / Test Files 与 Tests 通过数 / 退出码）+ index.ts 追加行 + 特别确认：GenerateTitleService 全程无 registry.register（AC-13）、AgentRuntimeModule 与 ConversationModule 经 forwardRef 解环无循环报错。
用命令 npm run test > /tmp/c2-7-verify.log 2>&1; grep -E "Test Files|Tests |check-core-imports|error TS" /tmp/c2-7-verify.log 避免输出被吞。`,
  { label: 'c2-7:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C2-E7 TitleGenerator + 权限中转 + NestJS 接线。项目根：${PROJECT_ROOT}
读：packages/core/src/agent-runtime/usecases/generate-title.ts(+test)、被改的端口文件（agent-runtime-port.ts + PermissionDecision 类型）、apps/api/src/agent-runtime/ 下 agent-runtime.module.ts(+spec)、agent-runtime.tokens.ts、controllers/{chat,permission,runtime}.controller.ts(+spec)、adapters/set-timeout-force-abort-scheduler.ts(+spec)、runtime-router.ts（确认 resolvePermission 实现）、apps/api/src/conversation/conversation.module.ts（确认 TITLE_GENERATOR 改绑）、app.module.ts、packages/core/src/index.ts 相关导出。
权威源：docs/contexts/c2-agent-runtime/architecture.md §6.4/§6.5/§7.1/§8、prd FR-6/FR-7/AC-12/AC-13/AC-15、_bmad-output/implementation-artifacts/epic-c2-7/SPEC.md。

重点查（每条判断真缺陷 / 可接受）：
1. 【AC-13 TitleGenerator 隔离，最重要】GenerateTitleService.generateTitle 是否绝对没有 new StreamSession / registry.register / 造用户可见 streamId / 影响 canAccept？构造上是否根本不持有 registry？测试是否用 spy 真断言 register 零调用（非空断言）？失败是否抛出而非返回空串造假标题？
2. 【forwardRef 解环 · apps/api 能否启动】AgentRuntimeModule 与 ConversationModule 是否两侧都 forwardRef？C1 侧 TITLE_GENERATOR 是否真改绑到 GenerateTitleService（StubTitleGenerator 退场）？Module spec 是否真断言可解析 4 个 token 且无 Nest 循环依赖报错？
3. 【构造签名对齐】AgentRuntimeModule 装配 StartStreamService（8 参）/AbortStreamService（5 参）/RuntimeRouter 的构造参数顺序是否严格对齐 core constructor？有没有 as any 绕类型？
4. 【C2 不做经纪判定 FR-7.3】PermissionController + resolvePermission 中转路径是否只忠实转发（permissionRequestId/status/updatedInput/denyMessage），绝无自动批准/超时拒绝/任何裁决逻辑？RuntimeRouter 是否按 streamId 定位适配器委派？ClaudeSdkRuntimeAdapter 是否至少不吞决议？
5. 【不重写映射 AC-12/AC-15】终态→StreamStatus 是否复用 c2-4 的 terminalSubstateToStreamStatus 未重写？StartStreamService.messages 是否绑真 C1 AppendMessageUseCase（非 stub）？是否只经端口写、不直写库、不传 phase 本身、phase 不入持久化路径？
6. 【ForceAbortScheduler 生产实现】SetTimeoutForceAbortScheduler 是否 setTimeout/clearTimeout 正确、cancel 幂等不抛？是否落 apps/api（不在核心）？fake timers 测试是否真断言触发/取消？
7. 【分层铁律】GenerateTitleService（核心）是否零框架、无 setTimeout/Date.now/randomUUID/禁用 import（守卫 0 命中）、import type + .js？apps/api 侧用 @nestjs/setTimeout 是否合规（框架层允许）？
8. 【控制器薄层 + 反假数据】三控制器是否只做协议翻译无业务判定？availability 未注册 Runtime 是否显 unavailable/unknown 不显假 ready？SSE 帧是否透传不伪造？无鉴权端点是否有注释记录？
9. 【不越界】是否未实现 Native/Codex 适配器、未实现 SSE 广播 fan-out/文件日志/Last-Event-ID/CLI（属 accept）、未碰 .env/密钥？
10. index.ts 导出正确无同名冲突；术语中文、禁用「上下文」指代 bounded context。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c2-7:review', phase: 'Review' })

return {
  r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null,
  r4ok: r4 != null, r5ok: r5 != null, r6ok: r6 != null,
  mergeReport, review,
}
