---
id: SPEC-epic-accept
companions:
  - _bmad-output/implementation-artifacts/sprint-plan.md
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c1-conversation/architecture.md
sources:
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c1-conversation/prd.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic ACCEPT · 验收链路（替代前端的端到端打通：SSE 三件套接口 + 一式三份 + 断线补发 + CLI）

## Why

前面 8 个冲刺把公共内核（SK）、会话/消息（C1）、运行时/中断用例（C2 核心）、Claude SDK 适配器与 NestJS 接线（c2-6/c2-7）全部落地——核心已经能「真的跟 AI 流式对话、能停、能 resume 续接」，但**没有一个可操作的入口把这些能力从终端摸得到**。本期没有前端 UI，验收方式就是：**一个只监听的 CLI + curl 发消息，端到端跑通**（sprint-plan §一）。

本 epic 落地 sprint-plan §二确认的「以 SSE 为中心」的三件套接口，以及每个流式事件的**一式三份**落点（sprint-plan §二）：

1. **SSE 实时推** —— 带单调递增 `seq`（即 SSE `id:` 字段），供断线重连做游标。
2. **文件事件日志** —— 每会话一个 append-only 日志，一行一事件（含 `seq`）。这是「流水账」，也是补发数据源。
3. **SQLite 最终落库** —— 一轮结束后把最终 assistant 消息经 C1 存消息用例存进会话历史。

**断线补发**：客户端带 `Last-Event-ID: N` 重连 → NestJS 从文件事件日志读 `seq>N` 的行逐条补发 → 接上实时流（sprint-plan §二）。

本 epic 的全部产出都落在**最外层驱动/出站适配器**（apps/api 下的 NestJS 控制器、SSE 广播、文件日志、CLI），**核心包 `packages/core` 零框架、零文件、零 SQL 完全不受影响**——SSE / 文件日志 / seq 编号 / 补发 / CLI 全部是适配器职责，符合六边形铁律（sprint-plan §三第 4 点）。本 epic **不改核心用例、不改聚合根、不改任何核心端口签名**；如需核心侧调整走 correct-course。

## 安全事实（范围边界内必须周知）

- **这些是 HTTP 网络端点，且本期完全无鉴权 / 无访问控制。** `POST /api/sessions/stream`、`GET /api/sessions/:id/stream`、`POST /api/sessions/:id/turn` 都不校验任何身份、令牌或来源。任何能访问该端口的进程都能新建会话、挂载任意会话的实时流、向任意会话发消息触发 AI 回合并消耗 litellm 额度。
- **本期定位：本机使用、无 UI 的验收后端**（sprint-plan §一「无 UI 的本机对话后端」、§四「完全不做前端 UI」）。因此本 epic **有意不引入鉴权**，服务应仅**绑定 loopback（`127.0.0.1`）**、**不对外网暴露端口**。这是明确记录在案的安全取舍，供承接者知晓——一旦将来要跨机/公网使用，鉴权与访问控制是上线前的**硬前置**（不在本期范围）。
- **文件事件日志会落盘会话全部流式内容**（含用户输入与 AI 回复正文），属潜在敏感数据；本期存明文于本机工作目录，不加密、不轮转清理，仅供本机验收——同样不对外分发。
- **密钥纪律**：litellm 令牌 `ANTHROPIC_AUTH_TOKEN` 只在 `apps/api/.env`（已 gitignored），accept 端点与 CLI 绝不回显、绝不写入事件日志或响应体。

## Capabilities

- **CAP-1 · C7.ProviderRepository 最小 Claude stub（accept-1）**
  - **intent:** 本期 C7 不做（sprint-plan §四），但 c2-7 接线的 `StartStreamService` / `GenerateTitleService` 依赖注入 `C7.ProviderRepository` 只读端口解析 `providerId → 协议/endpoint/auth/model`。在 apps/api 落一个**最小只读 stub**，返回**写死的单个 Claude provider 配置**（`RuntimeKind.CLAUDE_SDK`，endpoint/model 对齐 litellm 网关 `Jereh-Kimi-K2.6`），满足核心 `import type` 的 `ProviderReadPort` 契约（见 `packages/core/src/agent-runtime/ports/driven/provider-read-port.ts` 的本地类型契约）。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/stub-provider-repository.ts`，实现 `provider-read-port.ts` 转出的只读接口（如 `getById` / `resolve` 返回单个写死 Claude `ResolvedProviderView`），经 NestJS DI provide 给 `AgentRuntimeModule` 的 `ProviderRepository` token。**只读、绝不写 Provider**；auth 值来自运行时 env（`.env`），stub 里不硬编码密钥。可纯单测（断言返回的 provider 形状/协议正确、无密钥字面量）。

- **CAP-2 · 按会话的 SSE 广播中枢（accept-2）**
  - **intent:** 一个 `POST /messages` 触发的回合，其归一事件要**广播给所有挂在该会话 stream 上的连接**（sprint-plan §二）。落一个**按会话（per-session）的内存广播中枢**：维护 `sessionId → Set<订阅者>`，回合事件流经中枢 fan-out 到每个活跃 SSE 连接；连接关闭时从集合摘除，无订阅者时不泄漏。中枢是**出站/驱动适配器层的内存组件**，绝不进核心包。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/session-sse-hub.ts`（或近似命名）：`subscribe(sessionId, listener): unsubscribe`、`publish(sessionId, event)`。单测断言：同一 sessionId 多订阅者都收到同一事件；unsubscribe 后不再收到；不同 sessionId 互不串台；订阅者抛错不阻断其他订阅者派发（best-effort fan-out）。纯内存、可纯单测。

- **CAP-3 · 文件事件日志适配器：append-only + 单调递增 seq（accept-3）**
  - **intent:** 一式三份的第二份。每会话一个 append-only 文件日志，一行一事件（JSON），每行含**单调递增 `seq`**（同一会话内从 1 起严格递增，即 SSE `id:` 字段来源）。这是流水账，也是断线补发的数据源。落一个出站适配器封装文件读写与 seq 分配。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/file-event-log.ts`：`append(sessionId, event): { seq }`（分配下一个 seq、序列化一行追加写）、`readAfter(sessionId, afterSeq): AsyncIterable<{ seq, event }>`（读 `seq > afterSeq` 的行，供补发）。单测（用临时目录/tmpdir）断言：连续 append 的 seq 严格 +1、append-only 不覆盖既有行、`readAfter(N)` 只返回 seq>N 且有序、空/不存在日志 readAfter 返回空、坏行（脏 JSON）跳过不炸。文件路径每会话隔离。**注**：seq 单调性在单进程内由内存计数或读末行恢复保证；本期单机单进程，不处理多进程并发写。

- **CAP-4 · POST /api/sessions/stream 新建会话（带完整 options + 首句，首个 SSE 事件回推新 session id）（accept-4）**
  - **intent:** `POST /api/sessions/stream`：body 带**完整 query options**（工作目录/模型/mode/thinking/context1m/skills 等）+ 第一句话（sprint-plan §二）。控制器：经 `C1.ManageSessionUseCase.create` 建会话 → **首个 SSE 事件回推新 session id**（让 CLI 拿到 id）→ 经 `C2.StartStreamUseCase.start` 跑第一轮 → 消费 `StartStreamResult.events` 异步事件流，每个事件**一式三份**（`file-event-log.append` 拿 seq → SSE `id: seq` + `data:` 推给本连接 → 并 publish 到 CAP-2 中枢广播）。回合终态由核心用例经 `C1.AppendMessageUseCase` 落最终 assistant 消息（SQLite 那一份，核心已做，控制器不重复落库）。
  - **success:** 新增 `apps/api/src/agent-runtime/controllers/session-stream.controller.ts`（或并入既有 chat controller）：`POST /api/sessions/stream` 返回 `text/event-stream`，首事件为 `{ type: 'session', sessionId }`（或约定名），随后流式转发归一事件，每事件带 `seq`。请求体 DTO 映射到 `CreateSessionInput` + `StartStreamInput`。可用 NestJS e2e / supertest 断言首事件含新 sessionId、后续事件带递增 seq、options 正确透传给 StartStream（用假/stub runtime 时）。**端到端跑真第一轮需真实 litellm（见 accept-9）。**

- **CAP-5 · GET /api/sessions/:id/stream 挂载已有会话（accept-5）**
  - **intent:** `GET /api/sessions/:id/stream`：给 id 就挂上，一直收 SSE（sprint-plan §二）。控制器订阅 CAP-2 中枢的该 sessionId，把后续该会话的所有回合事件实时推给本连接；连接断开时 unsubscribe。挂载本身**不触发新回合**（回合由 `POST /messages` 触发），只是接入广播。
  - **success:** `GET /api/sessions/:id/stream` 返回 `text/event-stream`；订阅 CAP-2 中枢 → 收到该会话广播事件即推（带 seq 作 SSE id）；连接关闭调 unsubscribe（无泄漏）。可 e2e 断言：先挂载再对同会话 publish → 该连接收到；断开后中枢订阅者集合清空。（含 `Last-Event-ID` 补发的完整行为见 CAP-7。）

- **CAP-6 · POST /api/sessions/:id/turn 发消息触发一轮 + 广播给所有挂载连接（accept-6）**
  - **intent:** `POST /api/sessions/:id/turn`：curl 发，**立即返回**（不等回合结束），触发新一轮；事件**广播给所有挂在该会话 stream 上的连接**（sprint-plan §二）。控制器经 `C2.StartStreamUseCase.start(sessionId, content, ...)` 起一轮，把事件流消费后每事件**一式三份**（file-event-log append 拿 seq → publish 到 CAP-2 中枢 fan-out 给所有 GET stream 订阅者）。HTTP 响应体只回一个受理确认（如 `{ accepted: true, streamId }`），不阻塞在事件流上。
    > 【路由设计】accept-6 用独立路径 `/turn` 而非 `/messages`：C1 既有 `MessageController` 已占 `POST /api/sessions/:id/messages`（落消息表，纯追加），二者语义不同（turn=起 AI 回合+广播，messages=追加消息记录），撞路径会致 C1 路由遮蔽 accept-6，故分离。
  - **success:** 新增 `POST /api/sessions/:id/turn` handler：立即 202/200 返回受理确认；后台消费事件流 → 每事件 append 日志 + publish 中枢。e2e 断言（stub runtime）：POST 立即返回；两个挂在该会话的 GET stream 连接都收到该轮事件、seq 一致递增；事件也写进了文件日志。**真回合需真实 litellm（accept-9）。**

- **CAP-7 · Last-Event-ID 断线补发（从文件日志回放 seq 之后事件）（accept-7）**
  - **intent:** 客户端带 `Last-Event-ID: N` 重连 `GET /api/sessions/:id/stream` → 控制器先经 `file-event-log.readAfter(sessionId, N)` 从文件日志**逐条补发 seq>N 的历史事件**（带原 seq 作 SSE id）→ **补发完毕再接上实时流**（订阅 CAP-2 中枢）。补发与实时之间不丢事件、不重复（补发到当前末尾 seq，再切实时；需处理补发期间新到事件的衔接，避免缝隙或重复）。
  - **success:** `GET stream` 读 `Last-Event-ID` header（无则从头/仅实时，按约定）→ readAfter 回放 → 切实时订阅。e2e 断言：先产生若干带 seq 的事件写入日志 → 带 `Last-Event-ID: k` 连接 → 只收到 seq>k 的事件且有序、不含 seq<=k、衔接实时不丢不重。可用文件日志 + 假中枢纯 e2e 验证（不需真 AI）。

- **CAP-8 · CLI 监听客户端：listen --new / listen --session <id>（accept-8）**
  - **intent:** 一个只监听的 CLI（sprint-plan §一验收方式）：`listen --new` → 走 `POST /api/sessions/stream`（带默认/传入 options + 首句），从首事件拿到新 session id 并打印，随后滚动打印流式事件；`listen --session <id>` → 走 `GET /api/sessions/:id/stream` 挂载已有会话滚动打印。CLI 支持断线重连时带 `Last-Event-ID`（记住最后收到的 seq）。CLI 是独立可执行脚本（apps/api 下 bin/脚本），只做 SSE 客户端 + 打印，不含业务逻辑。
  - **success:** 新增 `apps/api/src/cli/listen.ts`（或 `apps/api/bin/listen.*`）：解析 `--new` / `--session <id>` / 可选 options；建立 SSE 连接、解析 `id:`/`data:`、按事件类型友好打印（text/thinking/tool_*/status/result 等）；记录最后 seq，断线重连带 `Last-Event-ID`。可对本地 stub server 做冒烟；**对真 AI 的端到端属 accept-9**。CLI 不打印/不落任何密钥。

- **CAP-9 · 端到端 smoke：新建→流式→curl 发消息→断线重挂补发（accept-9，需真实环境）**
  - **intent:** 把全链路串起来验证（sprint-plan §五 S9 产出）：终端 A 跑 CLI `listen --new` 拿 id 并实时滚出第一轮流式事件 → 终端 B `curl POST /api/sessions/:id/turn` 发第二句 → 终端 A 实时滚出该轮全部事件 → 断开 A、带 `Last-Event-ID` 重挂 → 补发断线期间事件不丢 → （可选）关掉重开、`listen --session <id>` 接着聊（resume 续接由 c2-6 适配器保证）。
  - **success:** 一份可复现的端到端 smoke 步骤/脚本（如 `apps/api/scripts/e2e-smoke.*` 或文档化 checklist），跑通「新建→流式→发消息→断线补发→续接」。**此故事需真实 litellm 代理**（`apps/api/.env` 已配 `ANTHROPIC_BASE_URL=https://litellm.jereh.cn`、模型 `Jereh-Kimi-K2.6`），**无法纯 `npm run test` 自测**——它验证的是真实 SDK-网络-进程链路，属「需真实环境验证」类。前 8 个能力（CAP-1~CAP-8）用 stub/假 runtime 可纯单测/e2e，本能力是唯一必须真实环境的收尾验收。

## Constraints

- **核心包零改动、零框架、零文件、零 SQL（六边形铁律，sprint-plan §三第 4 点）**：本 epic 全部产出落 `apps/api`（NestJS 控制器 / SSE / 文件日志 / 广播中枢 / CLI）。**绝不**改 `packages/core` 任何用例/聚合根/端口签名；SSE、`text/event-stream`、`Last-Event-ID`、文件读写、seq 编号、广播 fan-out 全是适配器职责，核心不感知。
- **一式三份，落点分离（sprint-plan §二/§三第 2 点）**：每个流式事件三个落点——① SSE 实时推（带 seq=SSE id）；② 文件事件日志 append-only 一行一事件含 seq（实时缓冲 + 补发数据源）；③ SQLite 最终落库（**一轮结束**经 C1 存消息用例存**最终 assistant 消息**，由核心用例 c2-7 接线负责，控制器**不重复落库**、不边流边塞 SQLite）。文件日志与 SQLite 职责分离：日志是流水账，SQLite 只存干净最终结果。
- **seq 语义**：`seq` 每会话内单调递增（从 1 起严格 +1），即 SSE `id:` 字段，是断线重连游标。本期单机单进程，不处理多进程/多副本并发写日志的 seq 竞争。
- **广播中枢与文件日志是内存/本机组件，非持久层、非核心**：中枢是内存 `sessionId → Set` 索引（进程重启即空）；文件日志落本机磁盘。二者都不进 `packages/core`，不与 C1 持久 StreamStatus / C2 内存 phase 混用。
- **鉴权缺失是有意取舍（见「安全事实」）**：本期端点无鉴权，服务应绑 loopback、不对外暴露；此为记录在案的本机验收取舍，跨机/公网使用前必须补鉴权（不在本期）。
- **复用既有用例与接线，不重写业务**：新建/列会话经 `C1.ManageSessionUseCase`；起回合经 `C2.StartStreamUseCase`；中断经 `C2.AbortStreamUseCase`；落最终消息/StreamStatus 经 `C1.AppendMessageUseCase`；provider 解析经 CAP-1 stub 注入的只读端口。控制器只做 HTTP/SSE 编排 + 一式三份落点，**不含领域逻辑、不直写 SQLite、不直调 SDK**。
- **密钥纪律**：`ANTHROPIC_AUTH_TOKEN` 只在 `apps/api/.env`（gitignored），绝不入库、绝不回显、绝不写进事件日志/响应体/CLI 输出。
- **`verbatimModuleSyntax`**：apps/api 内新增 TS 文件，类型-only import 用 `import type` + `.js` 扩展名（NodeNext）；核心包引用只 `import type` 用例/端口接口。
- **术语纪律**：全程中文；**禁用「上下文」一词指代 bounded context**，指代模块用全称（Conversation / AgentRuntime）或「领域边界」。
- **测试**：CAP-1~CAP-3 纯单测（vitest，`*.test.ts` 同目录 / tmpdir）；CAP-4~CAP-7 可用 NestJS e2e / supertest + stub runtime 验证接口契约与补发；CAP-8 对 stub server 冒烟；CAP-9 需真实 litellm，人工/脚本端到端验证，不入 `npm run test` 自测门。

## Non-goals

- 不做前端 UI（sprint-plan §四）。
- 不引入鉴权 / 会话令牌 / 访问控制（本期有意不做，见「安全事实」；跨机使用前的硬前置，属后续）。
- 不实现其他 AI agent 运行时适配器（未具名，预留扩展点；延后见 sprint-plan §四）；本期 provider stub 只返回单个 Claude 配置。
- 不实现真正的 C7 ProviderRepository（本期用最小 stub 顶替，sprint-plan §四）。
- 不改 `packages/core` 任何核心逻辑/端口签名（如需走 correct-course）。
- 不做文件事件日志的加密 / 轮转 / 清理 / 多进程并发写协调（本期单机单进程、明文本机）。
- 不做 SSE 之外的传输（不做 WebSocket / 长轮询）。
- 不重新实现 resume 续接（属 c2-6 `ClaudeSdkRuntimeAdapter`）、不重新实现中断/phase（属 c2-2/c2-5/c2-6）、不重新落库消息（属 c2-7 接线经 C1 用例）。

## 依赖的已完成组件（复用，列具体路径）

- **C1 会话用例**（新建/列/改名/touch）：`packages/core/src/conversation/ports/driving/manage-session-usecase.ts` + 实现 `packages/core/src/conversation/usecases/manage-session.ts`。
- **C1 消息用例**（append + updateStreamStatus，最终落库）：`packages/core/src/conversation/ports/driving/append-message-usecase.ts` + `.../usecases/append-message.ts`；历史投影 `.../ports/driving/get-session-history-usecase.ts`。
- **C1 REST 控制器 + SQLite 适配器**（参照/复用会话 REST 与落库）：`apps/api/src/conversation/controllers/session.controller.ts`、`message.controller.ts`、`apps/api/src/conversation/adapters/sqlite-session-repository.ts`、`sqlite-message-repository.ts`、`apps/api/src/conversation/conversation.module.ts`。
- **C2 StartStream / AbortStream 用例**：`packages/core/src/agent-runtime/ports/driving/start-stream-usecase.ts`（`StartStreamResult.events: AsyncIterable<AgentStreamEvent>`）、`abort-stream-usecase.ts`；实现 `.../usecases/start-stream.ts`、`abort-stream.ts`、`stream-session-registry.ts`。
- **C2 事件模型**（一式三份序列化对象）：`packages/core/src/agent-runtime/domain/event/agent-stream-event.ts`（14 类 AgentStreamEvent）。
- **c2-6 ClaudeSdkRuntimeAdapter + EventMapper + RuntimeRouter**（真接 SDK、resume、组合中断）：`apps/api/src/agent-runtime/adapters/claude-sdk-runtime-adapter.ts`、`claude-sdk-event-mapper.ts`、`apps/api/src/agent-runtime/runtime-router.ts`。
- **c2-7 接线**（AgentRuntimeModule / forwardRef 解 C1↔C2 环 / 终态→C1 StreamStatus 映射）：见 `apps/api/src/app.module.ts` 与 agent-runtime 接线；provider 只读端口本地类型契约 `packages/core/src/agent-runtime/ports/driven/provider-read-port.ts`（CAP-1 stub 实现它）。
- **C1↔C2 环已解**：`apps/api/src/conversation/conversation.module.ts` 与 agent-runtime 模块经 forwardRef；本 epic 只在其上加控制器/适配器，不改环结构。

## Success signal

- CAP-1~CAP-3（provider stub / SSE 广播中枢 / 文件事件日志）在 apps/api 内 `npm run test`（vitest）单测全绿：stub 返回单 Claude provider 无密钥字面量；中枢多订阅 fan-out / unsubscribe / 隔离正确；文件日志 seq 严格 +1、append-only、readAfter 只返 seq>N 有序、脏行跳过。
- CAP-4~CAP-7（三件套接口 + 补发）e2e（supertest + stub/假 runtime）通过：`POST /stream` 首事件回推新 session id、后续带递增 seq；`GET /:id/stream` 挂载收广播；`POST /:id/turn` 立即返回且广播给所有挂载连接、事件入日志；`Last-Event-ID: N` 重连只补发 seq>N、有序、衔接实时不丢不重。
- CAP-8（CLI）对本地 stub server 冒烟通过：`--new` 拿到并打印 session id、滚动打印事件；`--session <id>` 挂载打印；断线重连带 `Last-Event-ID`。CLI 输出无密钥。
- **CAP-9（端到端 smoke，需真实环境）**：接真实 litellm（`ANTHROPIC_BASE_URL=https://litellm.jereh.cn`、`Jereh-Kimi-K2.6`），人工/脚本跑通「终端 A `listen --new` 拿 id 实时滚事件 → 终端 B curl 发消息 → A 实时收该轮 → 断线带 `Last-Event-ID` 重挂补发不丢 → 关掉重开接着聊」。**此项不入 `npm run test` 自测门**，是本期最终验收的真实环境证据。
- 静态：`packages/core` 无本 epic 引入的任何改动（本 epic 只增删 apps/api 文件）；核心禁用 import 扫描仍 0 命中。

## Assumptions

- 假设 SK / C1 / C2 核心（含 c2-6 ClaudeSdkRuntimeAdapter、c2-7 NestJS 接线）已交付并稳定，本 epic 只在 apps/api 最外层加控制器/适配器/CLI，经既有用例端口消费，不改核心。
- 假设 `apps/api/.env` 已配好 litellm 网关与 `ANTHROPIC_AUTH_TOKEN`（gitignored），CAP-9 真实环境验证可用；单测/e2e（CAP-1~CAP-8）不依赖真实网络。
- 假设 `C7.ProviderRepository` 本地类型契约（`provider-read-port.ts`）为 CAP-1 stub 的实现目标；待真 C7 落地时 stub 可替换，控制器引用点不变。
- 假设本期单机单进程运行；文件日志 seq 单调性、广播中枢内存索引在此前提下成立，不处理多进程/多副本并发。
- 假设 NestJS e2e / supertest 与 vitest 运行器在 apps/api 已就位，可对控制器做接口级测试（用 stub runtime 注入替换真 SDK）。
