export const meta = {
  name: 'c1-5-message-lifecycle',
  description: 'C1-E5 消息用例：串行 append+touch→updateStreamStatus→getHistory→getPromptView→tokenUsage，合并门禁再对抗评审',
  phases: [
    { title: 'Append', detail: 'c1-5-1 append 消息并同一 now touch 会话' },
    { title: 'StreamStatus', detail: 'c1-5-2 updateStreamStatus 经 canTransition 守卫' },
    { title: 'History', detail: 'c1-5-3 getHistory 升序+分页' },
    { title: 'PromptView', detail: 'c1-5-4 getPromptView 剥离 render-only' },
    { title: 'TokenUsage', detail: 'c1-5-5 tokenUsage 只存不算' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审原子性/推进守卫/投影剥离' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/conversation/usecases/ 下实现 C1 消息生命周期用例。C1 核心零框架依赖、纯逻辑。
现状（C1-E1~E4 已完成）：
- domain/message/：Message（id/sessionId/role('user'|'assistant')/content/createdAt/streamStatus/tokenUsage?/isHeartbeatAck/taskRunId?）、message.ts；StreamStatus + canTransition(from,to)（streaming→终态合法、终态→回退非法）；TokenUsage（全可选投影）；MessageContent（含 toPlainText）。role 仅 user|assistant（以 message.ts 为准，忽略端口注释里可能残留的 system）。
- ports/driving/append-message-usecase.ts（AppendMessageUseCase + AppendMessageInput，含 sessionId）、get-session-history-usecase.ts（GetSessionHistoryUseCase：getHistory + getPromptView，HistoryQuery）。先读确认签名。
- ports/driven/message-repository.ts（MessageRepository：append/listBySession/updateStreamStatus/deleteBySession，先读确认签名）、session-repository.ts（touch(id, updatedAt)）。
- SK：ports/clock.ts、id-generator.ts、runtime-log.ts。
本 epic 实现两个 service，放 usecases/：
  - AppendMessageService implements AppendMessageUseCase（append + updateStreamStatus），放 usecases/append-message.ts。
  - GetSessionHistoryService implements GetSessionHistoryUseCase（getHistory + getPromptView），放 usecases/get-session-history.ts。
构造注入（architecture §7）：MessageRepository/SessionRepository/Clock/IdGenerator（AppendMessageService）；MessageRepository（GetSessionHistoryService）。核心不 new、不直调 Date.now/randomUUID（注释也别连写 "Date.now("）。
编排规则（architecture §6）：
- append(input)：id←IdGenerator.next()、now←Clock.now()，构造 Message（createdAt=now、streamStatus 初值按接口/输入、tokenUsage 无则 undefined 不落假0）→ MessageRepository.append → 用【同一个 now】SessionRepository.touch(sessionId, now)（严禁对 touch 再取一次 Clock.now()，保证 createdAt 与会话 updatedAt 一致，AC-7/NFR-7）。
- updateStreamStatus(messageId, to)：取当前消息 streamStatus，用 canTransition(from, to) 守卫；合法→MessageRepository.updateStreamStatus；非法→拒绝（抛或返回失败，按接口语义）。绝不绕过 canTransition。
- getHistory(query)：MessageRepository.listBySession → 按 createdAt 升序 → 分页（query 的 offset/limit 或等价，按 HistoryQuery 字段）。
- getPromptView(query)：在 getHistory 基础上剥离 render-only 消息——isHeartbeatAck===true 的心跳应答、taskRunId 关联的 render-only marker 消息，只保留真正进模型上下文的消息（AC-9：含标记的消息 getHistory 与 getPromptView 返回不同）。
- tokenUsage 只存不算：append 存入的 tokenUsage 原样保留，无值 undefined，绝不派生/补 0（AC-10 反假数据）。
核心包铁律：禁 import @nestjs/*/better-sqlite3/@anthropic-ai/*/uuid；禁 phase（无 StreamSession/.phase/active/settling/terminal）。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import 正常。readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。假替身：FakeMessageRepository(Map<sessionId, Message[]>)、FakeSessionRepository、FrozenClock、SequentialIdGenerator。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
先读相关端口文件确认签名再实现。完成后报告改/建的文件。
`

phase('Append')
const r1 = await agent(`${RULES}

任务 c1-5-1：实现 AppendMessageService.append（追加消息并同一 now touch 会话）。
- 创建 packages/core/src/conversation/usecases/append-message.ts：class AppendMessageService implements AppendMessageUseCase，构造注入 MessageRepository/SessionRepository/Clock/IdGenerator。
- append(input: AppendMessageInput): id←IdGenerator.next()、now←Clock.now()（只取一次），构造 Message（id/sessionId/role/content/createdAt=now/streamStatus 初值/tokenUsage 取自 input 无则不设/isHeartbeatAck 取自 input 或默认 false/taskRunId 取自 input）→ MessageRepository.append(message) → SessionRepository.touch(input.sessionId, now)【复用同一 now，不重新取时钟】→ 返回 Message（按接口）。
- 创建 append-message.test.ts：用 FakeMessageRepository+FakeSessionRepository+FrozenClock+SequentialIdGenerator 断言：append 用注入 id/now、message.createdAt===会话被 touch 的 updatedAt（同一 now，AC-7）、消息进了 repo、tokenUsage 无值时 undefined（AC-10）。
updateStreamStatus 属 c1-5-2（方法可先占位）。`,
  { label: 'c1-5-1:append', phase: 'Append' })

phase('StreamStatus')
const r2 = await agent(`${RULES}

任务 c1-5-2：实现 updateStreamStatus 经 canTransition 守卫。
- 编辑 append-message.ts 补 updateStreamStatus(messageId, to)（以 AppendMessageUseCase 接口签名为准）：取当前消息（经 MessageRepository，找不到按接口语义）→ canTransition(current.streamStatus, to) 守卫：合法→MessageRepository.updateStreamStatus(messageId, to)；非法→拒绝（抛明确错误或返回失败，按接口）。绝不绕过 canTransition 直接写。
- 在 append-message.test.ts 补：streaming→completed/interrupted/error 合法推进成功；completed→streaming 等终态回退被拒绝（canTransition=false）；断言非法推进时 repo.updateStreamStatus 未被调用。`,
  { label: 'c1-5-2:stream-status', phase: 'StreamStatus' })

phase('History')
const r3 = await agent(`${RULES}

任务 c1-5-3：实现 GetSessionHistoryService.getHistory（升序+分页）。
- 创建 packages/core/src/conversation/usecases/get-session-history.ts：class GetSessionHistoryService implements GetSessionHistoryUseCase，构造注入 MessageRepository。
- getHistory(query: HistoryQuery): MessageRepository.listBySession(query.sessionId) → 按 createdAt 升序排序 → 按 query 分页（offset/limit 或等价，以 HistoryQuery 字段为准）→ 返回 ReadonlyArray<Message>。
- 创建 get-session-history.test.ts：预置多条不同 createdAt 的消息，断言 getHistory 按 createdAt 升序、分页 offset/limit 正确、空会话返回空。
getPromptView 属 c1-5-4（方法可先占位）。`,
  { label: 'c1-5-3:history', phase: 'History' })

phase('PromptView')
const r4 = await agent(`${RULES}

任务 c1-5-4：实现 getPromptView 剥离 render-only 字段/消息。
- 编辑 get-session-history.ts 补 getPromptView(query): 在 getHistory 排序基础上，剥离 render-only 消息——isHeartbeatAck===true 的心跳应答消息、以及 taskRunId 关联的 render-only marker 消息（按 architecture §4.4/§6 语义；若判定规则需明确，固定为「isHeartbeatAck===true 的消息剔除」，taskRunId 的处理按文档，注释写清规则），只保留真正进模型上下文的消息。
- 在 get-session-history.test.ts 补：预置含 isHeartbeatAck=true 与普通消息的会话，断言 getHistory 全含、getPromptView 剥离了心跳消息（AC-9：两者返回不同）；纯普通消息时两者一致。`,
  { label: 'c1-5-4:prompt-view', phase: 'PromptView' })

phase('TokenUsage')
const r5 = await agent(`${RULES}

任务 c1-5-5：确认 tokenUsage 只存不算、不落假 0（AC-10 反假数据）。
- 检查 append-message.ts 的 append：input 带 tokenUsage 则原样存入 Message.tokenUsage；不带则 Message.tokenUsage 为 undefined（绝不设 {} 或 0 值字段）。若前序实现有落假值，修正。
- 确认整个 AppendMessageService/GetSessionHistoryService 无任何对 token 的派生计算（不求和、不补 totalTokens）。
- 在 append-message.test.ts 补：append 带完整 tokenUsage 往返保留；append 不带 tokenUsage → 存回的 message.tokenUsage===undefined（非 {}/非 0）；append 带部分 tokenUsage（只 inputTokens）→ 其余字段 undefined 不补 0。
- 确认两个 service 的 implements 完整（所有接口方法都实现，无遗漏导致编译错误）。
报告 tokenUsage 的存储路径与你补的反假数据断言。`,
  { label: 'c1-5-5:token-usage', phase: 'TokenUsage' })

phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C1-E5 两个用例已实现：usecases/append-message.ts（AppendMessageService）、usecases/get-session-history.ts（GetSessionHistoryService）+ 测试。
合并+验证：
1. 读两文件确认导出名。
2. 编辑 packages/core/src/index.ts：C1 用例服务段追加导出 AppendMessageService、GetSessionHistoryService（class 值用 export，.js 说明符）。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、append 同一 now、canTransition 守卫、投影剥离、token 反假数据、implements 完整）。反复到全绿。守卫需保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行。`,
  { label: 'c1-5:merge+verify', phase: 'Merge+Verify' })

phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C1-E5 消息生命周期用例。项目根：${PROJECT_ROOT}
读 packages/core/src/conversation/usecases/append-message.ts(+test)、get-session-history.ts(+test)、ports/driving/append-message-usecase.ts、get-session-history-usecase.ts、ports/driven/message-repository.ts、domain/message/stream-status.ts、index.ts 相关导出。权威源 docs/contexts/c1-conversation/architecture.md §3.3/§3.5/§4/§6。

重点查（每条判断真缺陷/可接受）：
1. 【append+touch 原子/同一 now】append 是否只取一次 Clock.now()，message.createdAt 与 SessionRepository.touch 的 updatedAt 是否用同一 now（AC-7）？有没有对 touch 再取一次时钟（缺陷）？先 append 后 touch 的顺序是否合理？
2. 【canTransition 守卫】updateStreamStatus 是否必经 canTransition，非法推进（终态回退）是否被拒绝、且不写 repo？有没有绕过守卫的路径？
3. 【getHistory】是否按 createdAt 升序、分页正确？边界（空会话、offset 超界）？
4. 【getPromptView 剥离】是否真剥离了 isHeartbeatAck 等 render-only 消息（AC-9：与 getHistory 返回不同）？剥离规则是否明确固定？
5. 【tokenUsage 只存不算】无值是否 undefined 而非 {}/0？有无派生计算/补 totalTokens（AC-10）？
6. implements 是否完整？找不到消息/会话的语义是否一致、有无未处理 undefined？
7. 依赖构造注入、无 Date.now/randomUUID 直调、核心零框架、禁 phase、readonly、import type+.js。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c1-5:review', phase: 'Review' })

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, r4ok: r4 != null, r5ok: r5 != null, mergeReport, review }
