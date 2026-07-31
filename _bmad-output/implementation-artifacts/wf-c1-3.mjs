export const meta = {
  name: 'c1-3-session-lifecycle',
  description: 'C1-E3 会话生命周期用例：串行 create/getById→list+过滤→archive/delete级联→touch，合并门禁再对抗评审',
  phases: [
    { title: 'CreateGet', detail: 'c1-3-1 ManageSessionService.create/getById' },
    { title: 'List', detail: 'c1-3-2 list 按 updatedAt 倒序 + source 过滤' },
    { title: 'ArchiveDelete', detail: 'c1-3-3 archive/unarchive/delete 级联' },
    { title: 'Touch', detail: 'c1-3-4 touch 仅更新 updatedAt' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审用例编排/注入/过滤/级联' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/conversation/usecases/ 下实现 C1 会话生命周期用例服务。C1 核心零框架依赖、纯逻辑。
现状（C1-E1/E2 已完成）：
- domain/session/chat-session.ts（ChatSession 10 字段 + SessionStatus/SessionMode/SessionSource 枚举）、title-origin.ts（TitleOrigin + canOverrideTitle）。
- domain/message/（Message + MessageContent 编解码）。
- domain/message-keys.ts（C1_MESSAGE_KEYS，含会话默认标题 key = 'c1.session.defaultTitle'）。
- ports/driving/manage-session-usecase.ts（ManageSessionUseCase 接口 + CreateSessionInput/ListSessionsQuery 等输入类型）。
- ports/driven/session-repository.ts（SessionRepository）、message-repository.ts（MessageRepository）。
- SK 端口：packages/core/src/ports/clock.ts（Clock.now():number）、id-generator.ts（IdGenerator.next():string）。

本 epic 实现 ManageSessionService implements ManageSessionUseCase，放 packages/core/src/conversation/usecases/manage-session.ts。
依赖注入：构造函数注入 SessionRepository、MessageRepository、Clock、IdGenerator（对齐 architecture §7）。核心不 new 具体实现、不直调 Date.now()/new Date()/randomUUID（注释也别连写 "Date.now("）。
编排规则（architecture §6）：create 用 id←IdGenerator.next()、now←Clock.now()（createdAt=updatedAt=now）、title 缺省用 C1_MESSAGE_KEYS 的默认标题 key + titleOrigin=default → SessionRepository.save；list 按 updatedAt 倒序、默认过滤 source='task'（除非 query 显式要）；delete 级联删该会话所有消息；touch 只更新 updatedAt=Clock.now()。
核心包铁律：禁 import @nestjs/*/better-sqlite3/@anthropic-ai/*/uuid；禁 phase（无 StreamSession/.phase/active/settling/terminal）。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名；值 import 正常。字段/输入 readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。测试用假替身：内存 FakeSessionRepository(Map)、FakeMessageRepository(Map<SessionId, Message[]>)、FrozenClock（now 恒定值）、SequentialIdGenerator（依次 'id-1','id-2'...）。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
先读 ports/driving/manage-session-usecase.ts、ports/driven/session-repository.ts、message-repository.ts 确认接口签名再实现。完成后报告改/建的文件。
`

phase('CreateGet')
const r1 = await agent(`${RULES}

任务 c1-3-1：实现 ManageSessionService 的 create 与 getById。
- 创建 packages/core/src/conversation/usecases/manage-session.ts：class ManageSessionService implements ManageSessionUseCase（以 ports 实际接口为准）。构造注入 SessionRepository/MessageRepository/Clock/IdGenerator。
- create(input: CreateSessionInput): 用 IdGenerator.next() 生成 SessionId、Clock.now() 作 createdAt=updatedAt、title 缺省时用 C1_MESSAGE_KEYS 默认标题 key（titleOrigin='default'），其余字段取自 input（mode/source/workingDirectory/projectName 等）→ SessionRepository.save → 返回 ChatSession。
- getById(id): 委托 SessionRepository。找不到的语义按接口（返回 null 或抛，以接口签名为准）。
- 创建 manage-session.test.ts：用 FakeSessionRepository + FrozenClock + SequentialIdGenerator 断言：create 用注入的 id/now、缺 title 走默认 key+origin=default、给了 title 用给的、save 被调用、getById 能取回；AC-10 反假数据（无值字段 undefined）。
本故事只做 create/getById，list/archive/delete/touch 属后续故事（但类可先留方法占位或分故事补，以能编译为准）。`,
  { label: 'c1-3-1:create-get', phase: 'CreateGet' })

phase('List')
const r2 = await agent(`${RULES}

任务 c1-3-2：实现 ManageSessionService.list（按 updatedAt 倒序 + source 过滤）。
- 编辑 usecases/manage-session.ts 补 list(query?: ListSessionsQuery): 从 SessionRepository 取全部（或委托 repo 的 list），按 updatedAt 倒序排序；默认过滤掉 source='task' 的会话（除非 query 显式要求包含 task 源，以 architecture §6/FR-1.6 与 ListSessionsQuery 字段为准）。
- 在 manage-session.test.ts 补：构造多个不同 updatedAt/source 的会话，断言 list 结果按 updatedAt 倒序、默认不含 source='task'、query 显式要 task 时才含。用假 repo 预置数据。`,
  { label: 'c1-3-2:list', phase: 'List' })

phase('ArchiveDelete')
const r3 = await agent(`${RULES}

任务 c1-3-3：实现 archive/unarchive/delete（级联删消息）。
- 编辑 usecases/manage-session.ts 补：archive(id)（status→archived，updatedAt=Clock.now()）、unarchive(id)（status→active）、delete(id)（删会话 + 级联删该会话所有消息，经 MessageRepository）。以 ManageSessionUseCase 接口实际方法签名为准。
- 级联：delete 时先删该 sessionId 的所有消息（MessageRepository），再删会话（SessionRepository），保证不留孤儿消息（NFR-7 一致性）。
- 在 manage-session.test.ts 补：archive/unarchive 改 status 且 touch updatedAt；delete 后会话与其消息都不存在（FakeMessageRepository 预置该会话多条消息，删后为空）；删不存在的会话的语义按接口。`,
  { label: 'c1-3-3:archive-delete', phase: 'ArchiveDelete' })

phase('Touch')
const r4 = await agent(`${RULES}

任务 c1-3-4：实现 touch（仅更新 updatedAt）。
- 编辑 usecases/manage-session.ts 补 touch(id): 仅把该会话 updatedAt 更新为 Clock.now()，其余字段不变 → SessionRepository（save 或 repo.touch，以接口为准）。用于「追加消息后把会话顶到列表前」。
- 在 manage-session.test.ts 补：touch 前后仅 updatedAt 变化（用可推进的 Clock 替身，如 MutableClock 或两个 FrozenClock 值），其余字段恒等；touch 不存在会话的语义按接口。
- 确认整个 ManageSessionService 的所有 ManageSessionUseCase 接口方法都已实现（无遗漏方法导致 implements 编译错误）。`,
  { label: 'c1-3-4:touch', phase: 'Touch' })

phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C1-E3 用例已实现于 usecases/manage-session.ts（ManageSessionService）+ 测试。
合并+验证：
1. 读 usecases/manage-session.ts 确认导出名（ManageSessionService 及任何导出的工厂/类型）。
2. 编辑 packages/core/src/index.ts：C1 段追加导出 ManageSessionService（class 是值，用 export；若有导出的类型用 export type）。模块说明符带 .js。不删改无关行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、注入/编排逻辑、假替身断言、implements 未实现全部方法）。反复到全绿。守卫需保持 0 命中、不误伤 apps/api。
4. 报告 npm run test 摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行。`,
  { label: 'c1-3:merge+verify', phase: 'Merge+Verify' })

phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C1-E3 会话生命周期用例。项目根：${PROJECT_ROOT}
读 packages/core/src/conversation/usecases/manage-session.ts(+test)、ports/driving/manage-session-usecase.ts、ports/driven/session-repository.ts、message-repository.ts、index.ts 相关导出。权威源 docs/contexts/c1-conversation/architecture.md §6/§7、prd.md FR-1。

重点查（每条判断真缺陷/可接受）：
1. 【依赖注入】ManageSessionService 是否构造注入 Clock/IdGenerator/SessionRepository/MessageRepository？是否偷偷直调了 Date.now()/new Date()/randomUUID（守卫应拦，但确认逻辑上也没绕过）？
2. 【create 编排】id 是否来自 IdGenerator.next()、时间来自 Clock.now()、createdAt=updatedAt=now、缺 title 走默认 key + origin=default？
3. 【list】是否按 updatedAt 倒序、默认过滤 source='task'？过滤逻辑是否可被 query 覆盖？边界：空列表、全 task？
4. 【级联删除】delete 是否真的级联删了消息（不留孤儿）？删序是否安全？
5. 【touch】是否只改 updatedAt 其余不变？
6. 是否完整 implements ManageSessionUseCase 所有方法（无缺失）？找不到会话的错误语义是否与接口一致、是否有未处理的 undefined？
7. 测试是否真用假替身验证了编排（而非空断言）？是否覆盖了 create/list/archive/delete/touch 全部路径与边界？
8. 核心零框架、禁 phase、readonly、import type+.js。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c1-3:review', phase: 'Review' })

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, r4ok: r4 != null, mergeReport, review }
