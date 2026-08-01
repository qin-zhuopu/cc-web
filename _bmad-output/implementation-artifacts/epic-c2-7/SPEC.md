---
id: SPEC-epic-c2-7
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
  - _bmad-output/implementation-artifacts/sprint-plan.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-7 · TitleGenerator + 权限中转 + NestJS 接线（GenerateTitleService 非流式 / permission 事件双向中转 / AgentRuntimeModule + forwardRef 解 C1↔C2 环 / 终态→C1 StreamStatus 映射）

## Why

C2（AgentRuntime）的核心纯逻辑已在前六个 epic 落齐：领域相位状态机（c2-1/c2-2）、事件模型（c2-3）、发起回合 `StartStreamService`（c2-4）、中断回合 `AbortStreamService`（c2-5，#578 结构化切断）、`ClaudeSdkRuntimeAdapter` + `RuntimeRouter`（c2-6）。但这些用例与适配器此刻还是**散件**——没有一处 NestJS 接线盒把它们按各自的构造签名装配起来对外提供端口，`TitleGenerator` 端口只有接口（`title-generator.ts`）而无实现（C1 侧仍绑着 `StubTitleGenerator`），权限请求/决议这条 Runtime↔上层的双向通道也还没接通。

本 epic 是 **C2 的基础设施收尾层**（对齐 sprint-plan S8 段、epics-stories E7、architecture §7.1/§8、PRD FR-6/FR-7/DI），落地三块：

1. **GenerateTitleService（FR-6）** —— `TitleGenerator` 端口的**非流式一次性**实现：用轻量 `AgentRuntimePort` 调用生成标题字符串，**不创建用户可见 `StreamSession`、不进 registry、不影响 `canAccept`**（AC-13）；失败可抛，由 C1 用例降级。这是 C1↔C2 环的 C2 一侧（C1 消费 `C2.TitleGenerator`）。
2. **权限事件与决议中转（FR-7）** —— Runtime 的权限请求经 `EventMapper` 归一成 `permission_request` 事件对外发（已在事件模型内，c2-3），上层（经 C5 经纪）的决议经**驱动端口 + 控制器**回传，转发给对应 `AgentRuntimePort` 适配器。C2 **不做经纪判定**（自动批准/超时拒绝策略归 C5），只做忠实的事件产出与决议转发。
3. **NestJS 接线（DI / Controller）** —— `AgentRuntimeModule` 把 `StartStreamService`/`AbortStreamService`/`GenerateTitleService`/`RuntimeRouter`/`InMemoryStreamSessionRegistry`/`ForceAbortScheduler` 生产实现按各自构造签名装配，`imports` `SharedKernelModule` + `ProviderManagementModule`（本期用 C7 stub）+ **`forwardRef(() => ConversationModule)`** 打破 C1↔C2 环，`exports` `StartStreamUseCase`/`AbortStreamUseCase`/`AgentRuntimePort`（供 C3）/`TitleGenerator`（供 C1，forwardRef 另一侧）；驱动适配器 `ChatController`/`PermissionController`/`RuntimeController` 把 HTTP/SSE 请求接到驱动端口；终态→C1 持久 `StreamStatus` 映射在接线层闭合（`completed`/`interrupted`/`error`，不传 phase、不直写库）。

**本 epic 的价值锚点**：这是 sprint-plan 的**第二个可用里程碑**——「真接 Claude SDK，能流式跑一轮、能停、能 resume 续接」的接线闭合点。C1↔C2 环若不经 `forwardRef` 在两侧 Module 解开，整个 apps/api 无法启动；`TitleGenerator` 若不在此替换 `StubTitleGenerator`，AI 起标题就是假的。

**关键铁律边界（本 epic 是基础设施层）**：c2-7 的产物**大部分落在 `apps/api`（框架层）**——`AgentRuntimeModule`、三个 Controller、`ForceAbortScheduler` 的 `setTimeout` 生产实现、C7 `ProviderRepository` stub 装配，这些**可以** `import @nestjs/*`、可用 `setTimeout`。只有 `GenerateTitleService` 作为**核心用例编排**落在 `packages/core`，受核心零框架铁律约束（禁 `@nestjs/*`/`@anthropic-ai/*`/`better-sqlite3`/`node:child_process`/`node:timers`，禁直调 `setTimeout`/`Date.now`/`randomUUID`）。两层的边界纪律在 Constraints 里逐条固定。

## Capabilities

- **CAP-1 · GenerateTitleService 非流式标题生成（FR-6 / AC-13）**
  - **intent:** 在 `packages/core` 实现 `GenerateTitleService implements TitleGenerator`（`ports/driving/title-generator.ts` 的 `generateTitle(input: TitleGenerationInput): Promise<string>`），用**非流式一次性**方式经注入的 `AgentRuntimePort` 生成标题字符串。与主回合流式路径**完全隔离**：**不** `idGenerator.next()` 造用户可见 streamId、**不** `new StreamSession`、**不进** `StreamSessionRegistry`、**不影响** `canAccept()`（AC-13）。核心内部若需一次性消费 `AgentRuntimePort.run` 的归一事件流，只提取 `text` 产物拼成标题，消费完即弃（不登记 registry、不落 C1）；失败向上抛（由 C1 `SetSessionTitleService` 降级，见 C1 FR-2.4）。构造注入依赖对齐 architecture §8（`TitleGenerator → GenerateTitleService(AgentRuntimePort(轻量非流式), ProviderRepository)`），如需 `SK` 端口（ErrorClassifier/RuntimeLog）经构造注入。
  - **success:** 新增 `packages/core/src/agent-runtime/usecases/generate-title.ts`：`class GenerateTitleService implements TitleGenerator`，构造注入端口接口（`AgentRuntimePort` + `ProviderReadPort` + 必要 SK 端口），`generateTitle` 返回标题串。单测（假 `AgentRuntimePort` 产 text 事件、假 `ProviderReadPort`）断言：正常产出返回拼好的标题；**调用全程不 new StreamSession、不调 registry.register、不影响任何 `canAccept()`**（AC-13，可注入 spy registry 断言 register 零调用）；Runtime 失败/抛错 → `generateTitle` 抛出（供 C1 降级），不静默返回空串造假标题。核心零框架、`import type` + `.js`（对应 PRD FR-6/FR-6.3、AC-13，architecture §6.5、epics-stories S7.1）。

- **CAP-2 · 权限决议中转端口 + PermissionController（FR-7.2/7.3）**
  - **intent:** 权限**请求**已由 `EventMapper` 归一成 `permission_request` 事件对外发（c2-3 事件模型内含，本 epic 不重造事件类型）。本能力接通**决议回传**这一侧：定义/落地一个把上层决议（allow/allow_session/deny + 可选 updatedInput/denyMessage + permissionRequestId）转发给对应 `AgentRuntimePort` 适配器的路径，并在 `apps/api` 落 `PermissionController`（`POST /api/chat/permission`）把 HTTP 请求接到该转发路径。C2 **不做经纪判定**（自动批准策略、超时自动拒绝归 C5），只忠实中转：收到决议 → 定位对应回合 → 调 Runtime 侧决议方法。若 `AgentRuntimePort` 尚无决议方法签名（c2-1 端口只有 run/interrupt/forceKillTurn/availability），本 epic 需按最小契约扩展端口（新增如 `resolvePermission(turnRef, decision)` 签名）——扩展走 SPEC 记录，`RuntimeRouter` 与 `ClaudeSdkRuntimeAdapter` 侧相应补最小实现或 no-op 占位（真实 SDK 决议投递属适配器语义，本 epic 至少接通中转契约不吞决议）。
  - **success:** `PermissionController` 落 `POST /api/chat/permission`：解析决议 body → 经驱动端口/用例转发 → 对应适配器；C2 侧**无任何经纪逻辑**（无自动批准/超时策略）。单测/接线断言：给定决议 → 转发路径被调、permissionRequestId/decision 忠实透传；C2 不篡改、不裁决（对应 PRD FR-7.2/7.3，epics-stories S7.3）。权限**请求**产出侧（`permission_request` 事件）复用 c2-3，不重造（对应 FR-7.1，epics-stories S7.2）。

- **CAP-3 · AgentRuntimeModule DI 接线 + forwardRef 解 C1↔C2 环（DI / architecture §8 / AC 环闭合）**
  - **intent:** 在 `apps/api/src/agent-runtime/` 落 `AgentRuntimeModule`（NestJS），按 architecture §8 装配：`imports: [SharedKernelModule, ProviderManagementModule(本期 C7 stub), forwardRef(() => ConversationModule)]`；`providers` 用 `useFactory` 按各 service 构造签名手工注入（核心无 `@Injectable`，DI 全在此接线，对齐既有 `ConversationModule` 范式）——`StartStreamService`（8 参构造：registry/runtime/providers/history/messages/idGenerator/clock/errorClassifier）、`AbortStreamService`（5 参：runtime/registry/scheduler/errorClassifier/clock）、`GenerateTitleService`（CAP-1 构造）、`RuntimeRouter`（adapters map + errorClassifier）、`InMemoryStreamSessionRegistry`、`ForceAbortScheduler` 生产实现（CAP-5）；`exports`: `StartStreamUseCase`/`AbortStreamUseCase`/`AgentRuntimePort`（供 C3）/`TitleGenerator`（供 C1，forwardRef 另一侧）。**C1↔C2 环**：C1 依赖 `C2.TitleGenerator`、C2 依赖 `C1.AppendMessageUseCase`/`GetSessionHistoryUseCase`——本 epic 在 C2 侧 `imports: [forwardRef(() => ConversationModule)]`、并把 C1 侧 `ConversationModule` 的 `TITLE_GENERATOR` provider 从 `StubTitleGenerator` 改绑到经 `forwardRef(() => AgentRuntimeModule)` 注入的 `GenerateTitleService`（两侧 forwardRef 才能解环）。核心包之间仍只单向 `import type`，无实现级环（AC 环闭合）。
  - **success:** `AgentRuntimeModule` 编译通过、apps/api 可启动（`forwardRef` 两侧接好，无 Nest 循环依赖报错）；`ConversationModule` 的 `TITLE_GENERATOR` 由 `GenerateTitleService`（经 forwardRef）提供、`StubTitleGenerator` 退场（或保留仅作 fallback）。Module 单测（对齐既有 `conversation.module.spec.ts` 范式）断言：`AgentRuntimeModule` 能解析出 `StartStreamUseCase`/`AbortStreamUseCase`/`TitleGenerator`/`AgentRuntimePort`；C1↔C2 双向依赖经 forwardRef 解、无循环报错（对应 architecture §8、PRD 依赖假设、epics-stories S7.4）。

- **CAP-4 · 驱动适配器 Chat/Permission/Runtime 控制器（驱动适配器接线）**
  - **intent:** 在 `apps/api/src/agent-runtime/controllers/` 落三个 NestJS 控制器接驱动端口：`ChatController`（`POST /api/chat` 发起回合 → SSE 流消费 `StartStreamResult.events`；`POST /api/chat/interrupt` → `AbortStreamUseCase.abort`）、`PermissionController`（`POST /api/chat/permission` → CAP-2 决议中转）、`RuntimeController`（`GET /api/runtime/availability` → `AgentRuntimePort.availability()`）。控制器**只做协议边界翻译**（HTTP body ↔ 用例入参、事件流 ↔ SSE 帧），不含业务判定。用户可见状态字段带 source breadcrumb（phase/canAccept/ABORTED/tokenUsage 语义来源，对齐 PRD §0 反假数据表），SSE 帧结构透传归一事件不伪造。
  - **success:** 三控制器落地并在 `AgentRuntimeModule.controllers` 注册；`ChatController` 把 `StartStreamResult.events` 逐事件写为 SSE、把 interrupt 请求接 `AbortStreamUseCase.abort`；`RuntimeController` 返回 `availability()` 投影（未注册 Runtime 显 unavailable/unknown，不显假 ready，AC 反假数据）；`PermissionController` 接 CAP-2 中转。控制器薄层无业务逻辑（对应 epics-stories S7.5、architecture §8 controllers、sprint-plan S8）。**安全提示**：本期 `/api/chat` 等为本机无鉴权端点（对齐 sprint-plan「无 UI 本机后端」定位），SPEC 显式记录此端点无鉴权，生产化前需补访问控制。

- **CAP-5 · ForceAbortScheduler 的 setTimeout 生产实现（架构 §4.2 / c2-5 的接线另一半）**
  - **intent:** c2-5 只定义了 `ForceAbortScheduler` 端口契约（`schedule(callback, delayMs): () => void` cancel）与 `FORCE_ABORT_MS` 常量，生产实现明确划归 c2-7（核心零框架禁 `setTimeout`）。本能力在 `apps/api` 落 `SetTimeoutForceAbortScheduler implements ForceAbortScheduler`：`schedule` 用 `setTimeout` 安排、返回的 cancel 用 `clearTimeout` 取消；在 `AgentRuntimeModule` 注册并注入 `AbortStreamService`。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/set-timeout-force-abort-scheduler.ts`（或同层）：`schedule` 经 `setTimeout(callback, delayMs)`、cancel 经 `clearTimeout`；已到期/已触发后 cancel 为 no-op（不抛）。单测（假计时器 / vi.useFakeTimers）断言：schedule 后推进时钟触发 callback；cancel 后推进不触发。经 `AgentRuntimeModule` 注入 `AbortStreamService`（CAP-3）。框架层允许 `setTimeout`（不受核心铁律约束）（对应 architecture §4.2、c2-5 SPEC Non-goals「setTimeout 生产实现属 c2-7」、epics-stories S7.4）。

- **CAP-6 · 终态 → C1 持久 StreamStatus 映射闭合（FR-2.5 / NFR-8 / AC-12 / AC-15）**
  - **intent:** 终态子态 → C1 持久 `StreamStatus` 的映射逻辑（`completed`→`'completed'`、`aborted`→`'interrupted'`、`errored`→`'error'`，architecture §6.4）**核心侧已在 `start-stream.ts` 的 `terminalSubstateToStreamStatus` 实现**（c2-4-6），本 epic **不重写映射**。本能力在接线层**闭合**这条链路：确认 `AgentRuntimeModule` 注入给 `StartStreamService` 的 `AppendMessageUseCase` 是**真** C1 用例（经 forwardRef 注入的 `AppendMessageService`，非 stub），使回合终态经 `updateStreamStatus` 真正映射写回 C1 持久层——**只经 `C1.AppendMessageUseCase` 端口写、不传 phase 本身、不直写库**（AC-12），phase 不入任何持久化路径（AC-15，phase 是内存态）。
  - **success:** 接线断言：`StartStreamService` 的 `messages` 依赖经 `AgentRuntimeModule`（forwardRef）绑定到 C1 真实 `APPEND_MESSAGE_USECASE`；终态映射走既有 `terminalSubstateToStreamStatus`（completed/interrupted/error），无「C2 完成但 C1 存 streaming」漂移（AC-12）。静态/接线层确认：C2 不直写库、不把 phase 传给 C1、phase 不出现在持久化路径（AC-15）。**注**：映射纯函数本身在 c2-4 已测，本 epic 只验接线闭合与端口绑定正确（对应 PRD FR-2.5/NFR-8、AC-12/AC-15，epics-stories S7.6、architecture §6.4）。

## Constraints

- **分层铁律 · 核心零框架 vs 框架层（NFR-1 / AC-14）**：
  - **`packages/core/src/agent-runtime/`**（本 epic 只有 `GenerateTitleService`）：禁 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`、`node:timers`、`codex`；**禁直调 `setTimeout`/`setInterval`/`Date.now()`/`new Date()`/`randomUUID()`**（`scripts/check-core-imports.mjs` 守卫会拦，注释里也别连写）。取时经注入 `SK.Clock`、id 经注入 `IdGenerator`（但 CAP-1 明确**不**为标题造用户可见 streamId）。
  - **`apps/api/`**（`AgentRuntimeModule`/三 Controller/`SetTimeoutForceAbortScheduler`/C7 stub 装配）：**允许** `import @nestjs/*`、允许 `setTimeout`/`clearTimeout`、允许接 SDK 适配器——框架层不受核心铁律约束。这是本 epic 大部分产物的落点。
- **TitleGenerator 隔离铁律（AC-13）**：`GenerateTitleService.generateTitle` **绝不**创建用户可见 `StreamSession`、**绝不** `registry.register`、**绝不**影响任何 `canAccept()`。它是非流式一次性调用，与主回合流式路径隔离。评审重点审「有没有偷偷 new StreamSession / 进 registry」。
- **C2 不做权限经纪判定（FR-7.3）**：`PermissionController` 与决议中转路径**只忠实转发**（allow/allow_session/deny + updatedInput/denyMessage + permissionRequestId），**绝不**含自动批准策略、超时自动拒绝、任何裁决逻辑——那全部归 C5。C2 只负责「Runtime 权限请求事件产出」+「上层决议转发给适配器」的双向中转。
- **C1↔C2 环只经 forwardRef 在 Module 层解（DI 铁律）**：C1 依赖 `C2.TitleGenerator`、C2 依赖 `C1.AppendMessageUseCase`/`GetSessionHistoryUseCase`——**必须**在**两侧** Module 用 `forwardRef` 打破（C2 侧 `imports: [forwardRef(() => ConversationModule)]`、C1 侧把 `TITLE_GENERATOR` 改绑经 `forwardRef(() => AgentRuntimeModule)`）。核心包之间**只单向 `import type`**，绝无实现级环。禁用 `as any` 绕类型、禁把 C1 实体/StreamStatus import 进 C2 核心做实时判断。
- **复用既有用例/适配器/端口/纯函数，不重定义**：`StartStreamService`（c2-4，8 参构造）、`AbortStreamService`（c2-5，5 参构造：`runtime/registry/scheduler/errorClassifier/clock`）、`RuntimeRouter`（c2-6，`adapters map + errorClassifier`）、`ClaudeSdkRuntimeAdapter`（c2-6）、`StreamSessionRegistry`（c2-4）、`ForceAbortScheduler`/`FORCE_ABORT_MS`（c2-5 端口）、`terminalSubstateToStreamStatus`（c2-4，`start-stream.ts` 内）、`AgentRuntimePort`/`TurnRef`（c2-1）、`TitleGenerator`/`TitleGenerationInput`（c2-1 端口）全部**引用/装配，绝不重写**。接线时构造参数顺序**务必严格对齐** core 里各 service 的 `constructor`（对齐 `ConversationModule` 里「构造参数顺序严格对齐 core」的注释纪律）。
- **phase 不落库、registry 非持久层（NFR-2 / AC-15）**：接线层确认 `StreamSessionRegistry` 是内存态（`InMemoryStreamSessionRegistry`），phase 绝不入持久化路径；终态写回 C1 只经 `AppendMessageUseCase.updateStreamStatus` 传映射后的 `StreamStatus` 字面量，**绝不传 phase 本身**。
- **`AgentRuntimePort` 若需扩展决议方法（CAP-2）**：c2-1 端口当前只有 `run`/`interrupt`/`forceKillTurn`/`availability`。若 CAP-2 需要新增决议投递签名（如 `resolvePermission`），属对既有端口的**最小扩展**——扩展需在本 SPEC 记录，`RuntimeRouter`（apps/api）与 `ClaudeSdkRuntimeAdapter` 相应补最小实现/占位（真实 SDK 决议投递可留待适配器完善，但中转契约不得吞决议）。绝不在 C2 侧加经纪逻辑。
- **`verbatimModuleSyntax` 已启用**：`GenerateTitleService`（核心）类型-only import 用 `import type` + `.js` 扩展名（NodeNext），值 import（聚合根/纯函数/枚举）走普通 import + `.js`；字段 `readonly`。`apps/api` 侧遵循既有 Module 的 import 风格（`@codepilot/core` 桶导入 + `import type`）。
- **可测**：`GenerateTitleService` 用假 `AgentRuntimePort` + 假 `ProviderReadPort` + spy registry 做纯单元测试（AC-13 断言 register 零调用）；`SetTimeoutForceAbortScheduler` 用假计时器测；Module 用 `Test.createTestingModule` 断言可解析 + forwardRef 解环（对齐 `conversation.module.spec.ts` / `shared-kernel.module.spec.ts` 范式）。测试用 vitest，`*.spec.ts`（apps/api）/`*.test.ts`（core）同目录。
- **术语中文**；用户可见文案走 `c2.*` messageKey（`C2_MESSAGE_KEYS`），错误文案 key 来自 `SK.ErrorClassifier.messageKey`，关键路径经 `SK.RuntimeLog`（source=`c2.stream`/`c2.title` 等）。

## Non-goals

- **不实现 Native / Codex 运行时适配器**（`NativeRuntimeAdapter`/`CodexRuntimeAdapter` 及其 EventMapper/进程隔离）——本期 deferred（sprint-plan 四、S8 明确只 ClaudeSDK）；`RuntimeRouter` 只注册 CLAUDE_SDK（c2-6 已如此），本 epic 不补 Native/Codex 路由实现。
- **不实现真实 C7 `ProviderRepository`**——本期用 `apps/api` 的最小只读 stub（返回写死单个 Claude provider，sprint-plan 四「本期用 stub 顶替」）；`AgentRuntimeModule` 装配该 stub，真实 C7 属后续。
- **不做权限经纪判定**（自动批准策略、超时自动拒绝、IM 路由）——归 C5；本 epic 只中转事件与决议。
- **不重写终态→StreamStatus 映射纯函数**（`terminalSubstateToStreamStatus` 已在 c2-4 落地并测）、**不重写** `StartStreamService`/`AbortStreamService`/`RuntimeRouter`/任何已交付用例与适配器——本 epic 只装配与接线，业务逻辑复用。
- **不实现 SSE 广播中枢 / 文件事件日志 / seq 补发 / CLI**——那属 S9 验收链路（accept-2~9）。`ChatController` 本 epic 落最小 SSE 直推（消费 `StartStreamResult.events` 写帧），不含按会话广播 fan-out、不含 `Last-Event-ID` 补发。
- **不实现 `ClaudeSdkRuntimeAdapter` 内的 resume 续接 / query options.env 注入细节**——那是 c2-6 适配器语义（`.env` 单一真相源、litellm 网关注入属适配层，本 epic 不碰密钥、不改 `.env`）。
- **不新增/改写既有领域类型与迁移规则**（`StreamSession`/`reconcilePhase`/`canTransitionPhase`/`TerminalReason`/事件模型）；如需扩展 `AgentRuntimePort` 决议方法走 CAP-2 记录的最小扩展，其余走 correct-course。

## Success signal

- `packages/core` 内 `npm run test` 全绿、`tsc --build`（`verbatimModuleSyntax`）通过；禁用 import 静态守卫对新增 `GenerateTitleService` 0 命中（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`node:timers`/`codex`/`Date.now`/`randomUUID`/`setTimeout`）。
- `apps/api` 编译通过、可启动：`AgentRuntimeModule` 与 `ConversationModule` 两侧 `forwardRef` 接好，**无 NestJS 循环依赖报错**（C1↔C2 环解开，DI 可解析）。
- **TitleGenerator 隔离（AC-13）**：`GenerateTitleService.generateTitle` 正常返回标题、失败可抛供 C1 降级；spy 断言全程 **不 new StreamSession、不 registry.register、不影响 canAccept**。
- **forwardRef 解环（DI）**：`AgentRuntimeModule` 能解析出 `StartStreamUseCase`/`AbortStreamUseCase`/`TitleGenerator`/`AgentRuntimePort`；C1 侧 `TITLE_GENERATOR` 由 `GenerateTitleService`（经 forwardRef）提供，`StubTitleGenerator` 退场。
- **权限中转（FR-7）**：`PermissionController` 接 `POST /api/chat/permission`，决议忠实转发对应适配器，C2 侧无经纪逻辑。
- **控制器接线（S7.5）**：`ChatController`（POST /api/chat SSE + interrupt）/`RuntimeController`（availability）薄层接驱动端口；无鉴权端点已在 SPEC 记录待生产化补。
- **ForceAbortScheduler 生产实现（CAP-5）**：`setTimeout`/`clearTimeout` 实现单测通过（推进触发 / cancel 不触发），注入 `AbortStreamService`。
- **终态映射闭合（AC-12/AC-15）**：`StartStreamService.messages` 绑真 C1 `AppendMessageService`，映射走既有纯函数，无 streaming 漂移；phase 不入持久化路径、不传 phase 给 C1。

## Assumptions

- 假设 epic-c2-1 已交付并稳定：`AgentRuntimePort`（`run`/`interrupt`/`forceKillTurn`/`availability` + `TurnRef{streamId,native?}`）、`AbortStreamUseCase`/`StartStreamUseCase`/`TitleGenerator` 驱动端口、`TitleGenerationInput`、`RuntimeKind`/`RuntimeAvailability`、事件模型均为最终版本，本 epic 复用不改写（CAP-2 的端口最小扩展除外，需 SPEC 记录）。
- 假设 epic-c2-4 已交付：`StartStreamService`（8 参构造）、`StreamSessionRegistry`（`register`/`get`/`getActiveBySession`/`delete`）、`terminalSubstateToStreamStatus` 映射（在 `start-stream.ts` 内）、`resolveRuntimeKind` 为最终版本，本 epic 经值 import 装配、不改写。
- 假设 epic-c2-5 已交付：`AbortStreamService`（5 参构造 `runtime/registry/scheduler/errorClassifier/clock`）、`ForceAbortScheduler` 端口 + `FORCE_ABORT_MS` 常量为最终版本，本 epic 装配并落其 `setTimeout` 生产实现（CAP-5）。
- 假设 epic-c2-6 已交付：`RuntimeRouter`（`adapters map + errorClassifier` 构造，实现 `AgentRuntimePort`，本期只注册 CLAUDE_SDK）、`ClaudeSdkRuntimeAdapter` + `ClaudeSdkEventMapper` 为最终版本，本 epic 经 `AgentRuntimeModule` 装配、不改写。
- 假设 C1 已交付并接线：`ConversationModule` 提供 `APPEND_MESSAGE_USECASE`/`GET_SESSION_HISTORY_USECASE` token，`TITLE_GENERATOR` 当前绑 `StubTitleGenerator`（本 epic 改绑 `GenerateTitleService`，需在 C1 侧加 `forwardRef(() => AgentRuntimeModule)`）；C1 侧本地 `TitleGeneratorPort` 契约与 `C2.TitleGenerator` 形状对齐。
- 假设 SK 已交付并接线：`SharedKernelModule` 提供 `CLOCK`/`ID_GENERATOR`/`RUNTIME_LOG`/`ERROR_CLASSIFIER`/`TRANSLATION_PORT` token，本 epic `imports` 之并注入各 service。
- 假设本期 C7 用 `apps/api` 只读 stub（返回写死 Claude provider）；`ProviderManagementModule`（或等价 stub provider）提供 `ProviderRepository`/`ProviderReadPort`，本 epic 装配之。
- 假设 `apps/api` NestJS 脚手架、`app.module.ts` 根模块、SSE 能力（NestJS `@Sse` 或手写 response 流）、vitest 运行器与 `tsc --build` 增量构建已就位（对齐既有 `conversation.module.spec.ts` 可跑）。
