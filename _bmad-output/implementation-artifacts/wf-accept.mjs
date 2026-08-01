export const meta = {
  name: 'accept-e2e-verification-chain',
  description: 'EPIC-ACCEPT 验收链路（替代前端端到端）：串行 C7 stub→SSE广播中枢→文件事件日志(seq)→POST stream新建→GET stream挂载→POST messages触发广播→Last-Event-ID断线补发→CLI监听，合并门禁再对抗评审；accept-9端到端smoke需真实litellm跑到能跑程度、待验项记deferred-work.md',
  phases: [
    { title: 'ProviderStub', detail: 'accept-1 C7 ProviderRepository 最小 Claude stub' },
    { title: 'SseHub', detail: 'accept-2 按会话 SSE 广播中枢（内存 fan-out）' },
    { title: 'FileEventLog', detail: 'accept-3 文件事件日志 append-only + 单调递增 seq' },
    { title: 'PostStream', detail: 'accept-4 POST /api/sessions/stream 新建（首事件回推 id）' },
    { title: 'GetStream', detail: 'accept-5 GET /api/sessions/:id/stream 挂载已有会话' },
    { title: 'PostMessages', detail: 'accept-6 POST /api/sessions/:id/messages 触发一轮 + 广播' },
    { title: 'ResumeReplay', detail: 'accept-7 Last-Event-ID 断线补发（回放 seq 之后）' },
    { title: 'CliListen', detail: 'accept-8 CLI 监听客户端 listen --new / --session' },
    { title: 'Merge+Verify', detail: '跑 npm run test 自修到绿（核心零改动 + 守卫 0 命中）' },
    { title: 'Review', detail: '对抗评审 核心零改动/一式三份/seq/补发衔接/无鉴权记录' },
    { title: 'E2ESmoke', detail: 'accept-9 端到端 smoke：起服务真连 litellm 跑到能跑程度，待验项记 deferred-work.md' },
  ],
}

const PROJECT_ROOT = '/home/dev/repo/github.com/qin-zhuopu/cc-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在实现 EPIC-ACCEPT：验收链路（替代前端的端到端打通——SSE 三件套接口 + 一式三份 + 断线补发 + CLI）。
权威源必读：_bmad-output/implementation-artifacts/epic-accept/SPEC.md（CAP-1~9 契约 + 安全事实）、epic-accept/stories.yaml（各故事 invoke_dev_with）、_bmad-output/implementation-artifacts/sprint-plan.md（§二接口形态、§三关键实现决策、S9）、docs/contexts/c2-agent-runtime/architecture.md、docs/contexts/c1-conversation/architecture.md。

【本 epic 最重要的铁律 · 核心包零改动】
- 全部产出落 apps/api（NestJS 控制器 / SSE / 文件日志 / 广播中枢 / CLI）。绝不改 packages/core 任何用例/聚合根/端口签名。SSE、text/event-stream、Last-Event-ID、文件读写、seq 编号、广播 fan-out 全是适配器职责，核心不感知。若真觉得需要改核心，停下报告（走 correct-course），不擅自改。
- apps/api 是框架层：允许 import @nestjs/*、允许 node:fs / setTimeout 等。verbatimModuleSyntax：新增 TS 文件类型-only import 用 import type + .js 扩展名（NodeNext）；引用核心用例/端口只 import type。

【一式三份 · 落点分离】每个流式事件三个落点：① SSE 实时推（带 seq=SSE id 字段）；② 文件事件日志 append-only 一行一事件含 seq（实时缓冲 + 补发数据源）；③ SQLite 最终落库（一轮结束经 C1 存消息用例存最终 assistant 消息，由核心 c2-7 接线负责，控制器不重复落库、不边流边塞 SQLite）。文件日志是流水账，SQLite 只存干净最终结果。

【seq 语义】seq 每会话内单调递增（从 1 起严格 +1），即 SSE id: 字段，是断线重连游标。本期单机单进程，不处理多进程并发写竞争。

【复用既有用例与接线，不重写业务】（先读确认真实签名/token 再消费）：
- C1 会话用例：packages/core/src/conversation/ports/driving/manage-session-usecase.ts（新建/列/改名/touch）；apps/api token 见 conversation.module.ts。
- C1 消息用例：append-message-usecase.ts（append + updateStreamStatus 最终落库）、get-session-history-usecase.ts。
- C1 REST + SQLite 适配器参照：apps/api/src/conversation/controllers/session.controller.ts、message.controller.ts、adapters/sqlite-*-repository.ts、conversation.module.ts。
- C2 用例：packages/core/src/agent-runtime/ports/driving/start-stream-usecase.ts（StartStreamResult.events: AsyncIterable<AgentStreamEvent>）、abort-stream-usecase.ts。
- C2 事件模型：packages/core/src/agent-runtime/domain/event/agent-stream-event.ts（14 类事件，一式三份序列化对象）。
- c2-6 适配器：apps/api/src/agent-runtime/adapters/claude-sdk-runtime-adapter.ts、claude-sdk-event-mapper.ts、runtime-router.ts。
- c2-7 接线：apps/api/src/agent-runtime/agent-runtime.module.ts（AgentRuntimeModule，含 forwardRef 解 C1↔C2 环、START_STREAM_USECASE/ABORT_STREAM_USECASE/AGENT_RUNTIME_PORT/TITLE_GENERATOR token、三控制器）、app.module.ts。provider 只读端口契约 packages/core/src/agent-runtime/ports/driven/provider-read-port.ts。
控制器只做 HTTP/SSE 编排 + 一式三份落点，不含领域逻辑、不直写 SQLite、不直调 SDK。

【安全铁律】① 端点本期无鉴权，服务应绑 loopback(127.0.0.1)、不对外暴露——在控制器/main 引导处注释显式记录此有意取舍。② 密钥 ANTHROPIC_AUTH_TOKEN 只在 apps/api/.env（gitignored），accept 端点/CLI/事件日志/响应体绝不回显、绝不写入密钥。

术语中文，禁用「上下文」指代 bounded context（用全称 Conversation/AgentRuntime 或「领域边界」）。
测试：CAP-1~3 纯单测（vitest *.spec.ts 同目录 / tmpdir）；CAP-4~7 用 NestJS e2e / supertest + stub/假 runtime；CAP-8 对本地 stub server 冒烟。不要跑 npm run test（合并阶段统一跑）。不改 packages/core。
完成后报告改/建的文件清单。
`

// ---- 波次1：C7 ProviderRepository stub ----
phase('ProviderStub')
const r1 = await agent(`${RULES}

任务 accept-1：C7.ProviderRepository 最小 Claude stub。对齐 SPEC CAP-1、sprint-plan 四「stub 顶替」。
先读 packages/core/src/agent-runtime/ports/driven/provider-read-port.ts 确认 ProviderReadPort 的精确只读接口（方法名如 getById/resolve、返回的 ResolvedProviderView 形状）。
新建 apps/api/src/agent-runtime/adapters/stub-provider-repository.ts：实现该只读接口，返回写死的单个 Claude provider 配置（RuntimeKind.CLAUDE_SDK，endpoint/model 对齐 litellm 网关模型 Jereh-Kimi-K2.6）。
- 只读、绝不写 Provider。
- auth 值来自运行时 env（process.env，apps/api 框架层可读），stub 里【绝不硬编码密钥字面量】——若需 token 从 env 读，缺失则留空/占位，绝不写 sk- 开头的字面量。
- 经 NestJS DI provide 给 AgentRuntimeModule 的 Provider token（读 agent-runtime.module.ts 确认 c2-7 用的 provider token 名）。若 c2-7 已装了临时 stub，则替换/对齐为本正式 stub。
新建 stub-provider-repository.spec.ts：断言返回的 provider 形状/协议正确（CLAUDE_SDK、model 对）、源码无密钥字面量（可断言 auth 来自 env、不含 sk- 字面量）。
import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-1:provider-stub', phase: 'ProviderStub' })

// ---- 波次2：SSE 广播中枢 ----
phase('SseHub')
const r2 = await agent(`${RULES}

任务 accept-2：按会话的 SSE 广播中枢（内存 fan-out）。对齐 SPEC CAP-2、sprint-plan 二。
新建 apps/api/src/agent-runtime/adapters/session-sse-hub.ts：内存广播中枢，维护 sessionId → Set<订阅者>。
- subscribe(sessionId, listener): unsubscribe（返回退订函数）。
- publish(sessionId, event)：fan-out 到该会话所有活跃订阅者；best-effort——某订阅者抛错不阻断其他订阅者派发。
- 连接关闭时经 unsubscribe 从集合摘除；无订阅者时清理该 sessionId 条目不泄漏。
- 纯内存组件，进程重启即空，绝不进 packages/core、绝不与持久层混用。
新建 session-sse-hub.spec.ts：同一 sessionId 多订阅者都收同一事件；unsubscribe 后不再收；不同 sessionId 互不串台；订阅者抛错不阻断其他订阅者（best-effort）；无订阅者后集合清空无泄漏。
import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-2:sse-hub', phase: 'SseHub' })

// ---- 波次3：文件事件日志 ----
phase('FileEventLog')
const r3 = await agent(`${RULES}

任务 accept-3：文件事件日志适配器 append-only + 单调递增 seq。对齐 SPEC CAP-3、sprint-plan 二（一式三份第二份）。
新建 apps/api/src/agent-runtime/adapters/file-event-log.ts：每会话一个 append-only 文件日志，一行一事件（JSON），每行含单调递增 seq（同会话内从 1 起严格 +1，即 SSE id 来源）。
- append(sessionId, event): { seq }——分配下一个 seq、序列化一行追加写（不覆盖既有行）。
- readAfter(sessionId, afterSeq): AsyncIterable<{ seq, event }>——读 seq > afterSeq 的行，有序返回，供补发。
- 文件路径每会话隔离（读 SPEC/架构确认放哪个工作目录，或用可配置基目录）。
- seq 单调性单进程内由内存计数或读末行恢复保证；本期单机单进程，不处理多进程并发写。
- 【安全】日志落盘会话流式内容属敏感数据，但绝不写入密钥；本机明文本期可接受（安全事实已记录）。
新建 file-event-log.spec.ts（用 os.tmpdir() 临时目录）：连续 append 的 seq 严格 +1；append-only 不覆盖既有行；readAfter(N) 只返回 seq>N 且有序；空/不存在日志 readAfter 返回空；坏行（脏 JSON）跳过不炸。
import type + .js；apps/api 可用 node:fs；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-3:file-event-log', phase: 'FileEventLog' })

// ---- 波次4：POST /api/sessions/stream 新建 ----
phase('PostStream')
const r4 = await agent(`${RULES}

任务 accept-4：POST /api/sessions/stream 新建会话（带完整 options + 首句，首个 SSE 事件回推新 session id）。对齐 SPEC CAP-4、sprint-plan 二。
新建 apps/api/src/agent-runtime/controllers/session-stream.controller.ts（或并入既有 chat controller，读现有结构选一致方式）：
- POST /api/sessions/stream 返回 text/event-stream。body 带完整 query options（工作目录/模型/mode/thinking/context1m/skills 等）+ 第一句话。
- 流程：经 C1.ManageSessionUseCase.create 建会话 → 首个 SSE 事件回推新 session id（约定 { type: 'session', sessionId }，让 CLI 拿到 id）→ 经 C2.StartStreamUseCase.start 跑第一轮 → 消费 StartStreamResult.events 异步事件流，每事件【一式三份】：file-event-log.append 拿 seq → SSE 帧 id: seq + data: 推给本连接 → publish 到 accept-2 中枢广播。
- 回合终态由核心用例经 C1.AppendMessageUseCase 落最终 assistant 消息（SQLite 那份，核心已做），控制器不重复落库。
- 请求体 DTO 映射到 CreateSessionInput + StartStreamInput（先读 manage-session-usecase.ts / start-stream-usecase.ts 确认入参形状）。
- 【安全】无鉴权端点，注释记录、绑 loopback。
新建 session-stream.controller.spec.ts（NestJS e2e / supertest + stub/假 runtime）：首事件含新 sessionId；后续事件带递增 seq；options 正确透传给 StartStream。真第一轮需真实 litellm（accept-9），本故事用 stub runtime。
控制器注册进 AgentRuntimeModule.controllers（读 agent-runtime.module.ts 补注册）。依赖经 Module 注入。import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-4:post-stream', phase: 'PostStream' })

// ---- 波次5：GET /api/sessions/:id/stream 挂载 ----
phase('GetStream')
const r5 = await agent(`${RULES}

任务 accept-5：GET /api/sessions/:id/stream 挂载已有会话。对齐 SPEC CAP-5、sprint-plan 二。
在 session-stream.controller.ts（accept-4 建）补 GET /api/sessions/:id/stream：
- 返回 text/event-stream；订阅 accept-2 中枢的该 sessionId，把后续该会话所有回合事件实时推给本连接（带 seq 作 SSE id）。
- 挂载本身【不触发新回合】（回合由 POST /messages 触发），只接入广播。
- 连接断开时调 unsubscribe（无泄漏）。
- Last-Event-ID 补发的完整行为属 accept-7，本故事只落基础挂载 + 实时订阅（若便于衔接可预留 header 读取位，但补发逻辑 accept-7 补）。
补 e2e 断言：先挂载再对同会话 publish → 该连接收到；断开后中枢订阅者集合清空。
import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-5:get-stream', phase: 'GetStream' })

// ---- 波次6：POST /api/sessions/:id/messages 触发 + 广播 ----
phase('PostMessages')
const r6 = await agent(`${RULES}

任务 accept-6：POST /api/sessions/:id/messages 发消息触发一轮 + 广播给所有挂载连接。对齐 SPEC CAP-6、sprint-plan 二。
在合适控制器（session-stream.controller.ts 或 message 相关）落 POST /api/sessions/:id/messages：
- curl 发，【立即返回】受理确认（如 { accepted: true, streamId }，202/200），不阻塞在事件流上、不等回合结束。
- 触发新一轮：经 C2.StartStreamUseCase.start(sessionId, content, ...) 起一轮，后台消费事件流 → 每事件【一式三份】：file-event-log.append 拿 seq → publish 到 accept-2 中枢 fan-out 给所有挂在该会话 GET stream 的订阅者。
- 事件也写进文件日志（补发数据源）。终态落库由核心经 C1.AppendMessageUseCase 负责，控制器不重复落库。
补 e2e 断言（stub runtime）：POST 立即返回受理确认；两个挂在该会话的 GET stream 连接都收到该轮事件、seq 一致递增；事件写进了文件日志。真回合需真实 litellm（accept-9）。
import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-6:post-messages', phase: 'PostMessages' })

// ---- 波次7：Last-Event-ID 断线补发 ----
phase('ResumeReplay')
const r7 = await agent(`${RULES}

任务 accept-7：Last-Event-ID 断线补发（从文件日志回放 seq 之后事件）。对齐 SPEC CAP-7、sprint-plan 二。
在 GET /api/sessions/:id/stream（accept-5）上补 Last-Event-ID 补发：
- 读请求头 Last-Event-ID: N（无则从头/仅实时，按约定，注释写明选择）。
- 先经 file-event-log.readAfter(sessionId, N) 从文件日志逐条补发 seq>N 的历史事件（带原 seq 作 SSE id）→ 补发完毕再接上实时流（订阅 accept-2 中枢）。
- 【衔接关键】补发与实时之间不丢事件、不重复：补发到当前末尾 seq 再切实时；处理补发期间新到事件的衔接，避免缝隙或重复（例如先记录切换点 seq，或补发期间缓冲实时事件再去重）。
补 e2e 断言（文件日志 + 假中枢，纯 e2e 不需真 AI）：先产生若干带 seq 事件写入日志 → 带 Last-Event-ID: k 连接 → 只收到 seq>k 的事件且有序、不含 seq<=k、衔接实时不丢不重。
import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-7:resume-replay', phase: 'ResumeReplay' })

// ---- 波次8：CLI 监听客户端 ----
phase('CliListen')
const r8 = await agent(`${RULES}

任务 accept-8：CLI 监听客户端 listen --new / listen --session <id>。对齐 SPEC CAP-8、sprint-plan 一（验收方式）。
新建 apps/api/src/cli/listen.ts（或 apps/api/bin/listen.*，读 apps/api 结构选一致方式）：独立可执行 SSE 客户端脚本，只监听 + 打印，不含业务逻辑。
- listen --new：走 POST /api/sessions/stream（带默认/传入 options + 首句），从首事件拿到新 session id 并打印，随后滚动打印流式事件。
- listen --session <id>：走 GET /api/sessions/:id/stream 挂载已有会话滚动打印。
- 解析 SSE id:/data:，按事件类型友好打印（text/thinking/tool_*/status/result 等）。
- 记录最后收到的 seq；断线重连时带 Last-Event-ID（对齐 accept-7 补发）。
- 【安全】CLI 绝不打印/落任何密钥。
可对本地 stub server 做冒烟测试（起最小 stub SSE server 或用 supertest 风格）；对真 AI 的端到端属 accept-9。
import type + .js；术语中文。不改 packages/core、不跑 npm run test。`,
  { label: 'accept-8:cli-listen', phase: 'CliListen' })

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

EPIC-ACCEPT 各故事（accept-1~8）已实现于 apps/api（provider stub / SSE 中枢 / 文件日志 / 三件套控制器 + 补发 / CLI）。
合并 + 验证：
1. 确认本 epic【未改 packages/core 任何文件】（这是硬铁律）——若有误改，回退核心改动，把需求改到 apps/api 侧解决；实在需要核心改动则在报告里明确标出待人裁决，不擅自留改动。
2. 确认三个 SSE 控制器都注册进 AgentRuntimeModule.controllers、provider stub 经 DI 装配到正确 token（读 agent-runtime.module.ts）。
3. 项目根跑 npm run test（typecheck + check-core-imports + vitest）。失败就修，重点排查：
   - verbatimModuleSyntax（import type + .js 遗漏）；
   - check-core-imports 守卫命中（本 epic 不该动核心，守卫应仍 0 命中——若命中说明误改了核心或核心被 apps/api 反向污染）；
   - NestJS DI 解析失败 / 控制器未注册 / provider token 不匹配；
   - supertest/e2e 测试的 stub runtime 注入方式；
   - 文件日志测试的 tmpdir 清理。
   反复修到全绿。守卫保持 0 命中。
4. 报告 npm run test 摘要（typecheck / check-core-imports 命中数 / Test Files 与 Tests 通过数 / 退出码）+ 特别确认：packages/core 零改动（可 git diff --stat 确认只动 apps/api 与 _bmad-output）、一式三份落点齐全、seq 严格递增、补发不丢不重的测试通过。
用命令 npm run test > /tmp/accept-verify.log 2>&1; grep -E "Test Files|Tests |check-core-imports|error TS" /tmp/accept-verify.log 避免输出被吞。
另用 /mingw64/bin/git diff --stat（若不可用退回 git diff --stat）确认改动范围只在 apps/api 和 _bmad-output。`,
  { label: 'accept:merge+verify', phase: 'Merge+Verify' })

// ---- Review ----
phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 EPIC-ACCEPT 验收链路。项目根：${PROJECT_ROOT}
读：apps/api/src/agent-runtime/adapters/{stub-provider-repository,session-sse-hub,file-event-log}.ts(+spec)、controllers/session-stream.controller.ts(+spec)（及可能的 message/chat 相关改动）、apps/api/src/cli/listen.ts、agent-runtime.module.ts（控制器/provider 注册）。
权威源：_bmad-output/implementation-artifacts/epic-accept/SPEC.md（CAP-1~9 + 安全事实）、sprint-plan.md §二/§三、docs/contexts/*/architecture.md。

重点查（每条判断真缺陷 / 可接受）：
1. 【核心零改动 · 最重要】本 epic 是否绝对没改 packages/core 任何用例/聚合根/端口签名？git diff --stat 是否只动 apps/api 与 _bmad-output？check-core-imports 是否仍 0 命中？
2. 【一式三份落点分离】每个流式事件是否三个落点齐全：SSE 实时推（seq=SSE id）+ 文件日志 append（含 seq）+ SQLite 最终落库（经 C1 用例，控制器不重复落库、不边流边塞 SQLite）？职责是否分离（日志=流水账，SQLite=干净最终）？
3. 【seq 语义】seq 是否每会话内从 1 严格 +1？是否作 SSE id 字段？断线重连游标语义是否正确？
4. 【补发不丢不重 · accept-7 命门】Last-Event-ID: N 重连是否只补发 seq>N、有序、不含 seq<=N？补发与实时的衔接是否不丢不重（补发期间新到事件如何处理，有没有缝隙或重复）？测试是否真断言这个衔接（非空断言）？
5. 【广播 fan-out】SSE 中枢是否同会话多订阅都收、unsubscribe 无泄漏、不同会话不串台、订阅者抛错 best-effort 不阻断其他？POST /messages 是否广播给所有挂载连接？
6. 【POST /messages 立即返回】是否不阻塞在事件流上、立即返回受理确认，后台消费事件？
7. 【复用不重写】新建会话经 C1.ManageSessionUseCase、起回合经 C2.StartStreamUseCase、落库经 C1.AppendMessageUseCase？控制器是否只做 HTTP/SSE 编排 + 落点，无领域逻辑、不直写 SQLite、不直调 SDK？
8. 【安全】端点无鉴权是否有注释记录 + 绑 loopback 取舍？密钥是否绝不出现在源码/日志/响应体/CLI 输出（provider stub 无 sk- 字面量、auth 从 env）？文件日志是否不写密钥？
9. 【provider stub】是否只读、返回单 Claude 配置、model 对齐 Jereh-Kimi-K2.6、无密钥字面量？
10. 【不越界】是否未做前端 UI / 鉴权 / Native·Codex 适配器 / 真 C7 / WebSocket；是否未重实现 resume/中断/落库（复用 c2-6/c2-7）？术语中文、禁用「上下文」指代 bounded context。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'accept:review', phase: 'Review' })

// ---- E2E Smoke（accept-9，需真实 litellm；跑到能跑程度，待验项记 deferred-work.md）----
phase('E2ESmoke')
const smoke = await agent(`${RULES}

任务 accept-9：端到端 smoke（需真实 litellm 环境）。对齐 SPEC CAP-9、sprint-plan 五 S9 产出。
本故事验证真实 SDK-网络-进程全链路，无法纯 npm run test 自测。litellm 网关已确认可达（ANTHROPIC_BASE_URL=https://litellm.jereh.cn、模型 Jereh-Kimi-K2.6、apps/api/.env 已配 ANTHROPIC_AUTH_TOKEN）。
按以下顺序【尽力跑到能跑的程度】，不中途停，把无法自动完成/需人工观察的写进 _bmad-output/implementation-artifacts/deferred-work.md（追加，不覆盖既有内容）：
1. 先产出一份可复现的端到端 smoke 脚本或文档化 checklist：apps/api/scripts/e2e-smoke.md（或 .mjs/.sh），描述完整步骤：终端 A listen --new 拿 id 实时滚事件 → 终端 B curl POST /api/sessions/:id/messages 发第二句 → A 实时收该轮 → 断开 A 带 Last-Event-ID 重挂补发不丢 → 关掉重开 listen --session <id> 接着聊（resume 由 c2-6 保证）。
2. 尝试真正起服务验证：读 apps/api 的启动方式（package.json scripts、main.ts），尝试后台起 NestJS 服务（绑 127.0.0.1），curl POST /api/sessions/stream 发一句真实提问，观察是否真的经 litellm 流式返回事件、seq 是否递增、文件日志是否落盘。
   - 起服务/curl 用后台方式，设合理超时；观察到首个真实 AI 事件即算链路通。
   - 若起服务因编译/DI/环境问题失败，记录具体错误到 deferred-work.md，不反复死磕（最多试 2-3 种合理修法）。
3. 无论真实验证到哪一步，都要：① 保留 smoke 脚本/checklist 供人工复跑；② 在 deferred-work.md 追加「accept-9 端到端待验清单」：已自动验证通过的项、需人工双终端观察的项（如断线重连的人工操作、关掉重开续接）、遇到的阻塞与建议。
4. 【安全】起服务绑 loopback、不对外暴露；curl/日志绝不回显密钥。
报告：smoke 脚本路径、你真实验证到哪一步（起服务成功否、是否收到真实 litellm 事件、seq/日志是否正常）、deferred-work.md 追加了哪些待人工验证项。
不改 packages/core。`,
  { label: 'accept-9:e2e-smoke', phase: 'E2ESmoke' })

return {
  r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, r4ok: r4 != null,
  r5ok: r5 != null, r6ok: r6 != null, r7ok: r7 != null, r8ok: r8 != null,
  mergeReport, review, smoke,
}
