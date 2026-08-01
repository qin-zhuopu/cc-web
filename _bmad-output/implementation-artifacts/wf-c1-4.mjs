export const meta = {
  name: 'c1-4-title-state-machine',
  description: 'C1-E4 标题来源状态机：串行 setByUser→generateByAi+覆盖规则→降级→不拼prompt反例，合并门禁再对抗评审',
  phases: [
    { title: 'SetByUser', detail: 'c1-4-1 setByUser origin=user' },
    { title: 'GenerateAi', detail: 'c1-4-2 generateByAi + canOverrideTitle 约束' },
    { title: 'Degrade', detail: 'c1-4-3 生成失败降级保持原标题不崩' },
    { title: 'NoPrompt', detail: 'c1-4-4 反例断言 C1 不拼 prompt 只调端口' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审覆盖规则/降级/不拼prompt' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/conversation/usecases/ 下实现 C1 标题来源状态机用例。C1 核心零框架依赖、纯逻辑。
现状（C1-E1/E2/E3 已完成）：
- domain/session/title-origin.ts：TitleOrigin('default'|'ai'|'user') + canOverrideTitle(current, incoming)（default<ai<user，user 不被 ai/default 覆盖）已实现，直接复用。
- ports/driving/set-session-title-usecase.ts：SetSessionTitleUseCase 接口骨架 + 输入类型（先读确认签名）。
- ports/driving/get-session-history-usecase.ts：GetSessionHistoryUseCase（提供 getPromptView 投影出 recentMessages 纯文本，供喂 TitleGenerator）。
- ports/driven/title-generator-port.ts：TitleGeneratorPort（C1 消费视角契约，权威定义在 C2）。先读确认其方法签名（如 generateTitle(input): Promise<string>，input 含 recentMessages: ReadonlyArray<{role, text}>）。
- ports/driven/session-repository.ts：setTitle(id, title, origin) / getById。
- SK：ports/clock.ts、id-generator.ts、以及 RuntimeLog 端口（packages/core/src/ports/runtime-log.ts，append 记日志）。
- usecases/manage-session.ts：ManageSessionService（rename 现抛未实现——本 epic 可让 rename 委托 setByUser，或保持，以接口为准）。

本 epic 实现 SetSessionTitleService implements SetSessionTitleUseCase，放 packages/core/src/conversation/usecases/set-session-title.ts。
构造注入（architecture §7）：SessionRepository、GetSessionHistoryUseCase、TitleGeneratorPort、Clock、RuntimeLog。核心不 new、不直调 Date.now/randomUUID。
编排规则（architecture §6）：
- setByUser(id, title)：直接 setTitle(title, origin='user')——用户手改恒生效（canOverrideTitle 对 user 恒 true）。
- generateByAi(id)：先取当前会话，若 titleOrigin==='user' 则直接返回原会话（user 态不被 ai 覆盖，连 TitleGenerator 都不必调）；否则 getPromptView 投影出 recentMessages 纯文本 → 调 TitleGeneratorPort.generateTitle(投影) → setTitle(生成标题, origin='ai')。canOverrideTitle 判定放行才写。
- 降级：generateByAi 中 TitleGenerator 抛错/超时 → catch → RuntimeLog.append(warn) → 返回原会话（保持原标题，不崩、不外抛）。
- 【C1 绝不自己拼 AI 标题提示词】：只把 getPromptView 的 recentMessages 纯文本片段传给 TitleGeneratorPort，绝不在 C1 构造提示词字符串/模型参数/模板，绝不 import C2 实现或任何 @anthropic-ai。
核心包铁律：禁 import @nestjs/*/better-sqlite3/@anthropic-ai/*/uuid；禁 phase。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import 正常。readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。假替身：FakeSessionRepository、可注入成功/抛错/超时的 FakeTitleGenerator、FrozenClock、记录调用的 FakeRuntimeLog、假 GetSessionHistory。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
先读 set-session-title-usecase.ts、title-generator-port.ts、get-session-history-usecase.ts、session-repository.ts、runtime-log.ts 确认签名再实现。完成后报告改/建的文件。
`

phase('SetByUser')
const r1 = await agent(`${RULES}

任务 c1-4-1：实现 SetSessionTitleService.setByUser。
- 创建 packages/core/src/conversation/usecases/set-session-title.ts：class SetSessionTitleService implements SetSessionTitleUseCase，构造注入上述 5 依赖。
- setByUser(id, title)：取会话（不存在按接口语义）→ SessionRepository.setTitle(id, title, 'user')。用户手改恒生效。可用 canOverrideTitle(current, 'user') 说明恒 true，但 user 覆盖无需拦。
- 创建 set-session-title.test.ts：假 SessionRepository 预置会话，断言 setByUser 后 title 与 origin='user'，且从 'ai'/'default' 态都能改成 user。
本故事只做 setByUser，generateByAi/降级属后续故事（方法可先占位以能编译，或分故事补）。`,
  { label: 'c1-4-1:set-by-user', phase: 'SetByUser' })

phase('GenerateAi')
const r2 = await agent(`${RULES}

任务 c1-4-2：实现 generateByAi + canOverrideTitle 覆盖规则。
- 编辑 set-session-title.ts 补 generateByAi(id)：
  1. 取会话；若 titleOrigin==='user' → 直接返回原会话（user 态不被 ai 覆盖，不调 TitleGenerator）。
  2. 否则：经 GetSessionHistoryUseCase 的 getPromptView（或等价）投影出 recentMessages 纯文本 → 调 TitleGeneratorPort.generateTitle(投影输入) 得标题 → 若 canOverrideTitle(current, 'ai') 放行则 SessionRepository.setTitle(生成标题, 'ai') → 返回更新后会话。
- 在 set-session-title.test.ts 补：default/ai 态会话 generateByAi 后 title 更新、origin='ai'；user 态会话 generateByAi 保持原标题、origin 仍 user、且断言 TitleGenerator 未被调用（用记录调用的假替身）。`,
  { label: 'c1-4-2:generate-ai', phase: 'GenerateAi' })

phase('Degrade')
const r3 = await agent(`${RULES}

任务 c1-4-3：generateByAi 降级——生成失败保持原标题、不崩、经 RuntimeLog 记录。
- 编辑 set-session-title.ts 的 generateByAi：把「投影→调 TitleGenerator→setTitle」包在 try/catch。TitleGeneratorPort.generateTitle 抛错/reject（模拟超时/网络失败）→ catch → RuntimeLog.append({level:'warn', source:'c1.title', message:...}) → 返回原会话（原标题原 origin 不变），绝不外抛、绝不把标题写成空/错误串。
- 在 set-session-title.test.ts 补：注入抛错的 FakeTitleGenerator，断言 generateByAi 不抛、返回原会话（title/origin 不变）、RuntimeLog 收到一条 warn（用记录 append 的假 RuntimeLog）。反假数据：降级不写脏标题。`,
  { label: 'c1-4-3:degrade', phase: 'Degrade' })

phase('NoPrompt')
const r4 = await agent(`${RULES}

任务 c1-4-4：反例断言——C1 不构造 AI 提示词、只调端口。这是边界纪律的守门测试。
- 不改生产逻辑（若前序已正确只补测试）。确认 SetSessionTitleService 传给 TitleGeneratorPort.generateTitle 的入参就是 getPromptView 投影出的 recentMessages 纯文本片段（ReadonlyArray<{role,text}> 或端口约定的投影类型），而非任何拼好的提示词字符串/模型参数/模板。
- 在 set-session-title.test.ts 补反例断言：注入一个「记录入参」的 FakeTitleGenerator，捕获 generateByAi 调用时传入的 input，断言：
  1. input 是投影结构（含 recentMessages 纯文本），不含提示词模板字符串/system prompt/模型名等 C2 概念。
  2. SetSessionTitleService 源码不 import 任何 C2 实现、不 import @anthropic-ai（由 c1-1-7 守卫在门禁层保证 0 命中，此处补一条断言说明该纪律）。
- 报告你如何用测试证明 C1 不拼 prompt。`,
  { label: 'c1-4-4:no-prompt', phase: 'NoPrompt' })

phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C1-E4 用例已实现于 usecases/set-session-title.ts（SetSessionTitleService）+ 测试。
合并+验证：
1. 读 set-session-title.ts 确认导出名。
2. 编辑 packages/core/src/index.ts：C1 段追加导出 SetSessionTitleService（class 值用 export，模块说明符 .js）。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、编排/降级逻辑、假替身断言、implements 完整性、rename 若需委托 setByUser）。反复到全绿。守卫需保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行。`,
  { label: 'c1-4:merge+verify', phase: 'Merge+Verify' })

phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C1-E4 标题来源状态机。项目根：${PROJECT_ROOT}
读 packages/core/src/conversation/usecases/set-session-title.ts(+test)、ports/driving/set-session-title-usecase.ts、ports/driven/title-generator-port.ts、domain/session/title-origin.ts、index.ts 相关导出。权威源 docs/contexts/c1-conversation/architecture.md §3.2/§5.3/§6/§7。

重点查（每条判断真缺陷/可接受）：
1. 【覆盖规则】generateByAi 对 user 态是否直接返回原会话、不调 TitleGenerator？canOverrideTitle 是否正确复用（default/ai 可被 ai 覆盖，user 不可）？
2. 【降级】TitleGenerator 抛错/reject 时是否真的不外抛、保持原标题、记 RuntimeLog.warn？是否会写脏标题（空串/错误消息当标题）？
3. 【C1 不拼 prompt】传给 TitleGeneratorPort 的是否只是投影的 recentMessages 纯文本，而非拼好的提示词？源码是否零 C2 实现 import、零 @anthropic-ai？c1-4-4 的反例断言是否真能证伪（而非空断言）？
4. 【setByUser】用户手改是否恒生效、origin=user？
5. 依赖是否全构造注入、无 Date.now/randomUUID 直调？implements 是否完整（含 rename 处理）？
6. 找不到会话的语义是否一致、有无未处理 undefined？
7. 核心零框架、禁 phase、readonly、import type+.js。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c1-4:review', phase: 'Review' })

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, r4ok: r4 != null, mergeReport, review }
