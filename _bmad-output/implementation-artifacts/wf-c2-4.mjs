export const meta = {
  name: 'c2-4-start-stream',
  description: 'C2-E4 发起回合 StartStream：串行 registry+发起骨架→Runtime选择→历史投影→单active约束→事件消费终态→落C1，合并门禁再对抗评审',
  phases: [
    { title: 'Registry+Skeleton', detail: 'c2-4-1 StreamSessionRegistry + StartStreamService.start 发起骨架' },
    { title: 'RuntimeSelect', detail: 'c2-4-2 ProviderReadPort 解析 → RuntimeKind 锁定' },
    { title: 'HistoryProjection', detail: 'c2-4-3 只经 C1.getPromptView 拿历史' },
    { title: 'SingleActive', detail: 'c2-4-4 单 active 约束：先 abort 旧回合' },
    { title: 'EventConsume', detail: 'c2-4-5 事件消费与终态归因' },
    { title: 'PersistC1', detail: 'c2-4-6 终态非空非autoTrigger 落 C1' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审 单active/只经用例/事件消费/落库/反假数据' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/agent-runtime/usecases/ 下实现 C2 的 StartStream 用例编排 + 内存注册表。C2 核心零框架依赖、纯逻辑。
先读权威源 docs/contexts/c2-agent-runtime/architecture.md §4.1（StartStreamUseCase）、§5.1/5.2/5.3（AgentRuntimePort/C1用例端口/C7只读端口）、§6.1/6.2/6.4（编排要点）确认签名与编排顺序，读 _bmad-output/implementation-artifacts/epic-c2-4/SPEC.md 确认 CAP-1~6 契约。

现状（C2-E1/E2/E3 已完成，直接复用，绝不重定义/改签名）：
- ports/driving/start-stream-usecase.ts：StartStreamUseCase 端口 + StartStreamInput（sessionId/content/mode/model/providerId/files?/mentions?/systemPromptAppend?/effort?/thinking?/context1m?/selectedSkills?/autoTrigger?）+ StartStreamResult（streamId/events:AsyncIterable<AgentStreamEvent>）。本 epic implements 它。
- ports/driven/agent-runtime-port.ts：AgentRuntimePort（run(req):AsyncIterable<AgentStreamEvent> / interrupt / forceKillTurn / availability）+ RuntimeRunRequest（streamId/runtimeKind/resolvedProvider/promptView/content/options/abortSignal）+ RuntimeRunOptions + AbortSignalLike + TurnRef。
- ports/driven/provider-read-port.ts：ProviderReadPort.resolve(providerId):Promise<ResolvedProviderView>（只读！）+ ResolvedProviderView（protocol/model?/authStyle/hasCredentials/source）+ ProviderProtocol（anthropic/openai-compatible/xai/openrouter/bedrock/vertex/google/gemini-image/openai-image/unknown）。
- ports/driven/conversation-ports.ts：转出 AppendMessageUseCase / GetSessionHistoryUseCase（C1 用例端口，import type）+ PromptMessage（=C1 Message）。
- domain/stream/stream-session.ts：StreamSession 聚合根（值 import）：构造(init:{id,sessionId,runtimeKind}, clock)、snapshot()、canAccept()、apply(event)、markSettling()、complete(tokenUsage?)、abort(reason:ClassifiedError)、fail(error:ClassifiedError)。
- domain/stream/turn-artifacts.ts：buildFinalContent(artifacts):string|null（值 import；空回合返回 null）。
- domain/stream/terminal-reason.ts：TerminalReason/TerminalReasonCode（归因码）。
- domain/stream/stream-phase.ts：StreamPhase/StreamSessionId/isActive/isTerminal/StreamPhaseKind/TerminalSubstate。
- RuntimeKind enum：注意有两处同名——domain/runtime/runtime-kind.ts 与 ports/runtime-kind.ts。StreamSession(init.runtimeKind) 用的是 domain/runtime/ 那处；AgentRuntimePort/RuntimeRunRequest 用的是 ports/ 那处。二者字面量值相同（claude-sdk/native/codex）。务必分清各引用点该用哪一处，绝不新增第三处、绝不改签名（若两处类型在赋值处不兼容，用 import type 分别引用并在边界做值层面的等价传递，不要 as any、不要合并两个 enum——这属既有技术债，本 epic 只复用不动它）。
- SK：ports/clock.ts（Clock.now():number）、ports/id-generator.ts（IdGenerator，读该文件确认方法名，如 next()/generate()）、domain/error/classified-error.ts（ClassifiedError）、错误分类器端口（读 packages/core/src/domain/error/ 下确认 ErrorClassifier 接口与把 AbortError 归 ABORTED 的用法）。

本 epic 职责（只落纯逻辑用例编排 + 内存注册表）：
- 新建 usecases/stream-session-registry.ts：活跃回合内存索引（register/get/getActiveBySession(sessionId)/delete，纯内存 Map，非持久层、不落库、不 import C1 持久 StreamStatus）。
- 新建 usecases/start-stream.ts：StartStreamService implements StartStreamUseCase，构造注入 registry + AgentRuntimePort + ProviderReadPort + GetSessionHistoryUseCase + AppendMessageUseCase + IdGenerator + Clock + ErrorClassifier。

核心包铁律（守卫会拦，扫 packages/core/src）：禁 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、child_process、codex；禁直调 Date.now()/new Date()/randomUUID（注释里也别连写 "Date.now("）。streamId 经注入 IdGenerator；取时经 StreamSession 注入的 Clock。
不接真实 Runtime 适配器/EventMapper（属 c2-6）、不实现 AbortStream 的 force-abort 安全网/reconcile（属 c2-5，本 epic 单 active 的「abort 旧回合」只是聚合根同步翻终态）、不接 NestJS DI（属 c2-7）、不接 SDK/进程/HTTP、不解析原生帧（只消费已归一 AgentStreamEvent）。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import（StreamSession/buildFinalContent/RuntimeKind enum/isActive 等）正常 import + .js。字段 readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。假替身：假 IdGenerator（返回可预期 id）、Frozen/MutableClock、假 AgentRuntimePort（产可控 AsyncIterable 事件序列 + 可注入 abortSignal）、假 ProviderReadPort（返回不同 protocol）、假 GetSessionHistoryUseCase、假 AppendMessageUseCase（记录调用）、假 ErrorClassifier。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
完成后报告改/建的文件。
`

// ---- 波次1：registry + 发起骨架 ----
phase('Registry+Skeleton')
const r1 = await agent(`${RULES}

任务 c2-4-1：实现 StreamSessionRegistry 内存注册表 + StartStreamService.start 发起骨架。对齐 SPEC CAP-1、architecture §6.1、AC-14。
1. 新建 usecases/stream-session-registry.ts：
   - class StreamSessionRegistry：内部纯内存 Map<StreamSessionId, StreamSession>（或加 sessionId→streamId 索引）。
   - API：register(session)、get(streamId):StreamSession|undefined、getActiveBySession(sessionId):StreamSession|undefined（返回该 C1 会话当前 active 的回合，用 snapshot().phase 经 isActive 判断）、delete(streamId)。
   - 非持久层：绝不落库、不 import C1 持久 StreamStatus、不取时（无需 Clock）。
2. 新建 usecases/start-stream.ts：
   - class StartStreamService implements StartStreamUseCase。构造注入 registry + AgentRuntimePort + ProviderReadPort + GetSessionHistoryUseCase + AppendMessageUseCase + IdGenerator + Clock + ErrorClassifier（本故事可只用到 registry/IdGenerator/Clock/AgentRuntimePort，其余留待后续故事，但构造签名一次留全，避免后续反复改构造）。
   - start(input) 骨架：streamId ← IdGenerator（读 id-generator.ts 确认方法名）；new StreamSession({id:streamId, sessionId:input.sessionId, runtimeKind:<暂用一个占位/默认，c2-4-2 补真实解析>}, clock)；注册进 registry。返回 { streamId, events }（events 可先返回一个空的/占位 AsyncIterable，c2-4-5 补真实事件流）。
   - 绝不直调 randomUUID/Date.now。
   注：本故事只落 registry + start 骨架（生成 id→建 StreamSession(active)→注册），Runtime 选择/历史/单active/事件消费/落库由 c2-4-2~6 补。占位不要写死假业务值到最终产物、不要 as any 掩盖类型。
创建 stream-session-registry.test.ts + start-stream.test.ts：
- registry：register 后 get 拿到、getActiveBySession 只返回 active 回合（terminal 的不返回）、delete 后 get 为 undefined。
- start 骨架：streamId 来自注入 IdGenerator、StreamSession snapshot().phase 为 active、已注册进 registry（getActiveBySession 拿得到）、startedAt 来自注入 Clock。断言核心无 Date/uuid 直调（靠守卫）。`,
  { label: 'c2-4-1:registry+skeleton', phase: 'Registry+Skeleton' })

// ---- 波次2：Runtime 选择 ----
phase('RuntimeSelect')
const r2 = await agent(`${RULES}

任务 c2-4-2：Runtime 选择——ProviderReadPort 解析 → RuntimeKind，发起时锁定。对齐 SPEC CAP-2、architecture §3.6/§5.3、FR-2.2。
波次1 已建 registry + start 骨架。现编辑 usecases/start-stream.ts：
- 在 start 内经注入的 ProviderReadPort.resolve(input.providerId) 拿 ResolvedProviderView（只读！只调 resolve，绝不调写方法）。
- 实现纯映射 protocol → RuntimeKind（可抽为模块内纯函数 resolveRuntimeKind(view) 便于测试）：anthropic→CLAUDE_SDK；openai-compatible/xai/openrouter/bedrock/vertex/google 等 HTTP 系→NATIVE（以 §3.6/§5.3 语义为准，读文档确认）；无法判定/unknown 的降级路径要明确——按文档默认或经 ErrorClassifier 归错，绝不静默选错 Runtime、绝不臆造。gemini-image/openai-image 若非对话 Runtime，按文档处理（读文档；不确定就明确标注并选安全降级）。
- 把解析出的 RuntimeKind 锁定：落入 new StreamSession 的 init.runtimeKind（替换 c2-4-1 的占位），发起后不再变。
- 注意 RuntimeKind 两处同名 enum：StreamSession.init.runtimeKind 用 domain/runtime/ 那处；后续 RuntimeRunRequest.runtimeKind 用 ports/ 那处。分清引用点。
在 start-stream.test.ts 补（假 ProviderReadPort 返回不同 protocol 的 ResolvedProviderView）：anthropic→CLAUDE_SDK、openai-compatible→NATIVE 等不同 protocol 路由到不同 RuntimeKind；锁定进 StreamSession.snapshot().runtimeKind；只调 resolve（不调写方法）。`,
  { label: 'c2-4-2:runtime-select', phase: 'RuntimeSelect' })

// ---- 波次3：历史投影 ----
phase('HistoryProjection')
const r3 = await agent(`${RULES}

任务 c2-4-3：历史投影——只经 C1.GetSessionHistoryUseCase.getPromptView 拿喂模型历史。对齐 SPEC CAP-3、architecture §6.1、FR-2.3、C1 AC-13。
编辑 usecases/start-stream.ts：
- 在 start 内经注入的 GetSessionHistoryUseCase.getPromptView({ sessionId: input.sessionId }) 拿 ReadonlyArray<PromptMessage>（喂模型要用 getPromptView 剔除 render-only，绝不用 getHistory）。
- 把拿到的投影原样作为 RuntimeRunRequest.promptView（构造出 RuntimeRunRequest 备 c2-4-5 调 run 用；本故事先把 request 组装好：streamId/runtimeKind(ports那处)/resolvedProvider(c2-4-2 的 view)/promptView/content:input.content/options(从 input 归约 mode/model/effort/thinking/context1m/selectedSkills/systemPromptAppend)/abortSignal）。
- C2 不重新加工/过滤历史（投影语义归 C1），核心不出现任何 SQL/表访问/Repository。
在 start-stream.test.ts 补（假 GetSessionHistoryUseCase 记录调用）：start 只调 getPromptView（不调 getHistory）、传入 sessionId 正确、返回投影原样进 RuntimeRunRequest.promptView（可通过假 AgentRuntimePort.run 捕获入参断言）。`,
  { label: 'c2-4-3:history', phase: 'HistoryProjection' })

// ---- 波次4：单 active 约束 ----
phase('SingleActive')
const r4 = await agent(`${RULES}

任务 c2-4-4：单 active 约束——新回合前先 abort 旧 active 回合。对齐 SPEC CAP-4、architecture §6.1、FR-2.4、AC-11。
编辑 usecases/start-stream.ts：
- start 在创建新 StreamSession 之前，先 registry.getActiveBySession(input.sessionId) 查旧 active 回合；若存在则调其 StreamSession.abort(reason)（reason 经注入 ErrorClassifier 把 AbortError/中断归 ABORTED；读 domain/error/ 确认 classify 用法），使旧回合同步翻 terminal(aborted)。然后再建新回合注册。
- 复用 c2-2 聚合根 abort（同步无条件翻终态），绝不重写迁移规则。本故事只做「聚合根层同步 abort 旧回合」，不实现 AbortStream 的 force-abort 安全网先行/best-effort interrupt/reconcile（那属 c2-5 完整中断编排）。
- 旧回合 abort 后按需从 registry 处理（getActiveBySession 依赖 isActive 判断，旧回合已 terminal 自然不再是 active；是否 delete 旧回合看 registry 设计，保证 getActiveBySession 语义正确即可）。
在 start-stream.test.ts 补：同一 sessionId 连续两次 start 后——旧回合 snapshot().phase = terminal(aborted)、canAccept()=true；新回合 phase=active；registry.getActiveBySession(sessionId) 返回的恰是新回合（至多一个 active）。`,
  { label: 'c2-4-4:single-active', phase: 'SingleActive' })

// ---- 波次5：事件消费与终态 ----
phase('EventConsume')
const r5 = await agent(`${RULES}

任务 c2-4-5：事件消费与终态归因。对齐 SPEC CAP-5、architecture §6.1/§6.2、FR-2.1/FR-3.6、AC-9。
编辑 usecases/start-stream.ts：
- start 调注入的 AgentRuntimePort.run(request) 拿已归一 AgentStreamEvent 的 AsyncIterable。绝不解析任何 SDK/SSE/JSON-RPC 原生帧（归一在适配器内，属 c2-6）。
- 消费事件流：逐事件 session.apply(event) 累积产物，同时把事件对外转发构成 StartStreamResult.events（AsyncIterable——可用 async generator 包一层：一边 yield 事件给上层，一边 apply 到 session）。
- 终态驱动：
  * 流正常耗尽 → session.complete(tokenUsage 投影)（tokenUsage 来自 result 事件的投影，无上报则不填，AC-9）。
  * abortSignal 触发（request.abortSignal.aborted 或收到 abort）→ session.abort(经 ErrorClassifier 的 ABORTED)。
  * 上游 error 事件 → session.fail(classified)（error 事件里的分类错误）。
  * idle-timeout/tool-timeout → 走 abort/fail 但 TerminalReason 归因 TIMEOUT/PROCESS（复用 c2-1 terminal-reason；本故事若无真实定时器机制，按事件/信号驱动归因即可，超时定时器的完整机制属 c2-5，勿造假定时器）。
- 只消费已归一事件、复用 c2-2 的 apply/迁移方法（值 import），绝不重写。
在 start-stream.test.ts 补（假 AgentRuntimePort 产可控事件序列）：
- 正常序列（text→result 后耗尽）→ 终态 terminal(completed)、finalContent 反映累积、result token 投影存入（无上报→undefined 不填 0）。
- 含 error 事件 → 终态 terminal(errored)、snapshot().error 为分类结果。
- abortSignal 触发 → 终态 terminal(aborted)。
- 转发：上层从 StartStreamResult.events 能拿到与 apply 相同的事件序列。`,
  { label: 'c2-4-5:event-consume', phase: 'EventConsume' })

// ---- 波次6：落 C1 ----
phase('PersistC1')
const r6 = await agent(`${RULES}

任务 c2-4-6：落 C1——终态非空且非 autoTrigger 才经 AppendMessageUseCase.append。对齐 SPEC CAP-6、architecture §6.2/§6.4、FR-2.5/2.6、AC-12/AC-9。
编辑 usecases/start-stream.ts：
- 回合落终态后，经 buildFinalContent(session.snapshot().artifacts)（值 import c2-1，复用不重写）投影 finalContent。
- 若 finalContent 非 null 且 input.autoTrigger 非真 → 经注入的 AppendMessageUseCase.append({ sessionId, role:'assistant', content:<由 finalContent 构造的 MessageContent>, streamStatus:<终态映射>, tokenUsage:<投影或省略> }) 落一条 assistant 消息。读 c1 的 append-message-usecase.ts 与 message-content 确认 content 该传的形状（若需把纯文本 finalContent 包成 MessageContent，用 C1 的编解码工具或最小 text 内容块——读 conversation/domain/message 确认，勿臆造结构）。
- 终态 → 持久 StreamStatus 映射（§6.4）：terminal(completed)→'completed'、terminal(aborted)→'interrupted'、terminal(errored)→'error'。经 AppendMessageUseCase 端口（append 的 streamStatus 或 updateStreamStatus），不传 phase 本身、不直写库、不持有 Repository。
- tokenUsage：无 Runtime 上报时省略，绝不填 0（AC-9）。
- 空回合（buildFinalContent 返回 null）不落 assistant 消息；autoTrigger 回合跳过落库。
- 回合终态后从 registry 摘除该回合（delete，防内存泄漏），registry 仍非持久层。
在 start-stream.test.ts 补（假 AppendMessageUseCase 记录调用）：
- 非空 completed 终态 → 恰调一次 append（role=assistant、content 来自 finalContent、streamStatus='completed'、tokenUsage 投影或省略）。
- aborted 终态 → streamStatus 映射 'interrupted'；errored → 'error'。
- 空回合（无产物）终态 → append 不被调用。
- autoTrigger=true 回合 → 跳过落库（append 不被调）。
- 只经用例写、无直写库（靠守卫 + 断言只调 AppendMessageUseCase）。
确认 StartStreamService 完整、能编译。报告落库映射与你补的断言。`,
  { label: 'c2-4-6:persist-c1', phase: 'PersistC1' })

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C2-E4 的 StartStreamService + StreamSessionRegistry 已实现于 usecases/ 下 + 测试。
合并+验证：
1. 读 usecases/start-stream.ts、usecases/stream-session-registry.ts 确认实际导出名。
2. 编辑 packages/core/src/index.ts：C2 段追加导出 StartStreamService、StreamSessionRegistry（class 值用 export、.js 说明符；若有导出的辅助类型/映射函数按需 export/export type）。注意与已有导出防同名冲突。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、RuntimeKind 两处同名的引用点分清、import type + .js、只消费已归一事件、单 active abort 复用聚合根、只经 C1 用例落库、tokenUsage 不填 0、空回合/autoTrigger 不落、守卫、同名冲突）。反复到全绿。守卫需保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行。`,
  { label: 'c2-4:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C2-E4 StartStream 用例编排 + StreamSessionRegistry。项目根：${PROJECT_ROOT}
读 packages/core/src/agent-runtime/usecases/start-stream.ts(+test)、usecases/stream-session-registry.ts(+test)、相关端口（ports/driving/start-stream-usecase.ts、ports/driven/*）、domain/stream/stream-session.ts（c2-2 定义，确认未被改）、index.ts 相关导出。权威源 docs/contexts/c2-agent-runtime/architecture.md §4.1/§5/§6.1/§6.2/§6.4、prd FR-2/AC-9/AC-11/AC-12/AC-14、_bmad-output/implementation-artifacts/epic-c2-4/SPEC.md。

重点查（每条判断真缺陷/可接受）：
1. 【单 active AC-11，重点】同一 sessionId 连续 start 时，旧 active 回合是否先被 abort 翻 terminal(aborted)、canAccept()=true？新回合 active？getActiveBySession 是否保证至多一个 active？测试是否真断言（非空断言）？
2. 【只经 C1 用例 AC-12/AC-13】历史是否只经 getPromptView（不用 getHistory、不读 messages 表）？落库是否只经 AppendMessageUseCase.append（不直写库、不持有 Repository）？
3. 【落库条件 FR-2.5/2.6】空回合（buildFinalContent→null）是否不落 assistant 消息？autoTrigger 回合是否跳过落库？非空非autoTrigger 才 append？
4. 【终态归因与映射 §6.2/§6.4】complete/abort/fail 各路径 phase 正确？终态→持久 StreamStatus 映射对（completed→completed、aborted→interrupted、errored→error）？
5. 【反假数据 AC-9】result token 无上报是否 undefined 不填 0？落库 tokenUsage 无值是否省略？
6. 【只消费已归一事件】start 是否只消费 AgentStreamEvent、不解析任何 SDK/SSE/JSON-RPC 原生帧？未越界实现 EventMapper/适配器（c2-6）？
7. 【不越界】未实现 AbortStream force-abort 安全网先行/reconcile（属 c2-5）？未接 NestJS DI（属 c2-7）？单 active 的 abort 仅聚合根同步翻终态？
8. 【复用不重写】StreamSession 迁移方法/apply/buildFinalContent 是否复用（未在用例重写迁移规则）？RuntimeKind 两处同名 enum 是否只复用未新增第三处、未 as any 掩盖？
9. 【registry 非持久层 NFR-2/AC-15】纯内存 Map？未落库、未 import C1 持久 StreamStatus？回合终态后是否从 registry 摘除防泄漏？
10. 核心零框架、无 Date.now/randomUUID 直调（streamId 经 IdGenerator、时间经注入 Clock）、import type+.js、index.ts 导出正确无同名冲突。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c2-4:review', phase: 'Review' })

return {
  r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null,
  r4ok: r4 != null, r5ok: r5 != null, r6ok: r6 != null,
  mergeReport, review,
}
