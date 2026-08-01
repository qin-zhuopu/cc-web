---
id: SPEC-epic-c2-6-native-codex
companions:
  - _bmad-output/implementation-artifacts/epic-c2-6/SPEC.md
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。
> 本 epic 是已交付 `epic-c2-6`（ClaudeSdkRuntimeAdapter + RuntimeRouter，本期 CLAUDE_SDK 唯一 Runtime）的**延续**：补齐 sprint-status 中 5 个 deferred 故事（Native/Codex 两类适配器 + 跨 Runtime 故障隔离）。不重写已交付产物，只在其契约上「往里塞第二、第三个 Runtime」。

# Epic C2-6-native-codex · NativeRuntimeAdapter + CodexRuntimeAdapter + 跨 Runtime 故障隔离

## Why

到 `epic-c2-6`（c2-6-1 / c2-6-6）为止，`AgentRuntimePort` 已有**第一个真实实现**（ClaudeSdkRuntimeAdapter），`RuntimeRouter` 也已能按 `RuntimeKind` 委派并对**未注册**的 Runtime fail-fast。但 `RuntimeKind` 枚举里早已就位的 `NATIVE` / `CODEX` 两个值**仍无适配器**——一旦 Provider 协议解析出 `runtimeKind = native` 或 `codex`，RuntimeRouter 当前会落 `failFastStream` 产出一条 error 事件并提示「Native/Codex deferred」。

本 epic 把这两类适配器补齐，使 C2 真正具备**多 Runtime 路由能力**（CLAUDE_SDK / NATIVE / CODEX 三选一，发起时锁定），并固化**跨 Runtime 故障隔离**——任一 Runtime 的进程/网络/spawn 病都 fail-fast 归 `ClassifiedError`，绝不污染另外两个 Runtime、绝不卡死核心回合生命周期（NFR-4 / AC-10）。

落到 5 个故事：

- **c2-6-2 · NativeRuntimeAdapter + NativeSseEventMapper**（apps/api，FR-5.3 / S6.2）：封装 Native HTTP provider 的 SSE 流（`fetch` + `AbortController`），`NativeSseEventMapper` 把 SSE 帧（`text`/`thinking`/`tool_use`/`tool_result`/`done` 等约定 JSON）归一成核心 `AgentStreamEvent`。`interrupt` = `abortController.abort()` + 读响应权威状态（若有）。
- **c2-6-3 · CodexRuntimeAdapter 进程隔离**（apps/api，FR-5.4 / S6.3）：封装 `CodexAppServerManager`——binary 发现（多候选选最新）/ Windows `.cmd` shim 经 `cmd.exe` / spawn / 僵死 `SIGKILL` / orphan 规避 / thread-turn 中断 / dispose。进程级复杂度全锁在此适配器内，核心零 `child_process`（AC-10）。
- **c2-6-4 · Codex fatal config fail-fast**（apps/api，FR-5.4 / S6.4 / NFR-4）：codex 子进程 fatal config stderr（`Failed to deserialize overridden config` / `unknown variant`+config 上下文）→ 立即 `fireClose` + `SIGKILL`，**不等 30s linger**；`onClose` 拒绝所有 pending RPC。这是把现有 codex 30s 卡死问题在适配器层结构化切断（P0.2）。
- **c2-6-5 · CodexEventMapper**（apps/api，FR-4.2 / S6.5）：把 codex JSON-RPC 通知（item lifecycle / `fs.changed` / auto-review / usage 等）归一成 `AgentStreamEvent`（含 `file_changed`、`result` 的 tokenUsage 投影）。
- **c2-6-7 · 跨 Runtime 故障隔离**（apps/api，NFR-4 / S6.7）：固化 RuntimeRouter 在「三 Runtime 同时注册」下的健壮性——某 Runtime 病（spawn 失败 / fatal config / 僵死）只影响其自己的路由，不影响另外两个 Runtime 的在途回合；可用性聚合仍反假数据（病态 Runtime 落 unavailable + reason，不拖垮聚合）。

**边界铁律**：本 epic 全部代码在 `apps/api`（框架/基础设施层），可 `import` HTTP fetch、`node:child_process`、`node:stream` 等。核心包 `packages/core` 仍**零框架**——`scripts/check-core-imports.mjs` 守卫只扫 `packages/core`，对本 epic 新增的 apps/api 文件 0 命中要求依旧；但**绝不**把 `node:child_process` / codex SDK / fetch 细节 import 进核心。适配器只 `import type` 核心的端口/领域类型 + 值 import 必要纯函数/枚举，绝不反向让核心依赖框架。

**RuntimeKind 无需扩展**：`packages/core/src/agent-runtime/domain/runtime/runtime-kind.ts` 与 `.../ports/runtime-kind.ts`（两份字面量一致的枚举）早已含 `CLAUDE_SDK = 'claude-sdk'` / `NATIVE = 'native'` / `CODEX = 'codex'`。本 epic 不动核心枚举——只把 NATIVE/CODEX 的适配器**实现出来**并**注册进**已交付的 RuntimeRouter。

**与 epic-c2-7 的关系**：c2-7-4 的 `AgentRuntimeModule` 已用 `useFactory` 把 `{ [RuntimeKind.CLAUDE_SDK]: claudeSdkAdapter }` 注入 RuntimeRouter。本 epic 在该 Module 的 useFactory 里**追加** Native/Codex 两个适配器实例到 adapter map（DI 改动归本 epic 故事，对齐 sprint-status `c2-6-2~5/6-7` 范围；c2-7 已交付不动）。若 Module 改动跨边界，走 c2-7 的 spec_checkpoint 纪律——但本 epic 默认只在 useFactory 里塞实例，不改 Module 结构。

## Capabilities

- **CAP-N1 · NativeSseEventMapper：Native SSE 帧 → AgentStreamEvent 归一**
  - **intent:** 实现核心 `EventMapper` 契约的 Native 侧具体归一：把 Native HTTP provider 的 SSE 帧（约定为 `data: {json}\n\n`，json 含判别字段如 `type`/`event`——`text` / `thinking` / `tool_use` / `tool_result` / `status` / `done`/`result` / `error` / `permission_request` 等）逐条映射为核心 14 类 `AgentStreamEvent` 之一或之几。文本增量按核心 `text` 语义产出（注意核心 `text` 是「累积全文」见 c2-2 apply，但 Native SSE 若逐字增量，mapper 自身需累积成全文——与 ClaudeSdkEventMapper 处理完整 assistant 消息同理的张力，照 c2-6-1a 决策：mapper 可持有累积态或按帧语义产出，决策点见 SPEC）。`result`/`done` 帧的 usage 只投影 Native 真实上报值，无则省略（AC-9）；未识别帧 → 返回 null 降级（复用 c2-3 契约，不抛、不伪造）。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/native-sse-event-mapper.ts` 实现核心 `EventMapper`。表驱动单测（录制的 SSE 帧样本字符串，无真实网络）断言：各类型帧归一成结构正确的 `AgentStreamEvent`；`result`/`done` 的 usage 有上报才带、无则省略（AC-9）；未知帧 / 非 JSON / 空 data → null（AC-8）；跨帧同语义事件结构与 ClaudeSdk 侧等价（AC-7 跨 Runtime 一致性）。（对应 PRD FR-4.2、AC-7/8/9，epics-stories S6.2 后半）

- **CAP-N2 · NativeRuntimeAdapter：封装 HTTP SSE 流 + AbortController 中断 + late-unregister no-op**
  - **intent:** 实现 `AgentRuntimePort`。`run(request)`：用 `fetch(resolvedProvider.endpoint, { signal, method:'POST', body: JSON(...) })` 发起流式请求（把 promptView/content/options 转成 provider 协议 body、把 resolvedProvider 的 auth 注入 header、把 request.abortSignal 接到 fetch signal），以 `streamId` 注册 `{ response, abort, reader }` 进内部 registry；从 `response.body` 读 SSE 流，逐帧过 `NativeSseEventMapper.mapEvent` → 非 null 才 yield 归一 `AgentStreamEvent`。`interrupt(turnRef)`：`abortController.abort()` + 读响应权威状态（若 provider 暴露）返回字符串（无则返回 `null`，交核心 force-abort 兜底）；注销句柄。`forceKillTurn(turnRef)`：强制 abort + 关 reader 兜底。**late-unregister no-op**：注销校验 streamId 归属——旧 turn teardown 传过期 streamId 不 evict 新 turn 句柄（AC-6，对齐 ClaudeSdk 侧纪律）。`availability()`：非 spawn 探测（探配置完整 / 端点可达，不发起真实回合）。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/native-runtime-adapter.ts` 实现 `AgentRuntimePort`。单测（用 mock fetch / 假 ReadableStream 注入可控 SSE 帧序列，不打真网络）断言：run 注册句柄 + 产出归一事件流；interrupt 调 abort + 返回权威状态（或 null）+ 注销句柄；forceKillTurn 关 reader；late-unregister（旧 streamId）no-op、不影响新 turn 句柄（AC-6）；resolvedProvider 的 auth/endpoint 被正确注入（断言 fetch 收到的 url/header/body）。（对应 PRD FR-5.3、AC-6/7，epics-stories S6.2 前半）

- **CAP-N3 · CodexRuntimeAdapter 进程隔离：binary 发现 / spawn / 僵死 SIGKILL / dispose / thread-turn 中断**
  - **intent:** 实现 `AgentRuntimePort`，封装 `CodexAppServerManager`（对齐 architecture §7.3，apps/api 内部模块）。`run(request)`：经 `CodexAppServerManager.acquire()` 拿到一个 codex app-server 子进程句柄（binary 发现：PATH 遍历 + macOS bundle，多候选探 `--version` 选最新，防旧 Homebrew codex 影子新 Codex.app；Windows `.cmd`/`.bat` shim 经 `cmd.exe /d /s /c`；`windowsHide`；proxy-safe env），开 thread → turn，以 `streamId` 注册 turn 句柄；驱动 JSON-RPC，把 codex 通知逐条过 `CodexEventMapper.mapEvent` 归一 yield。`interrupt(turnRef)`：关闭对应 thread/turn（防残留，FR-3.5）。`forceKillTurn(turnRef)`：强制关 turn 兜底。**僵死/退出**：`proc.once('exit')` → 归 `ErrorCode.PROCESS`（`process_died`）；`onClose` 拒绝所有 pending RPC（防 30s RPC timeout 卡死）。**dispose**：app exit 时优雅关闭避免 orphan。所有进程级复杂度锁在此，对外只吐归一事件 + 权威状态。**late-unregister no-op** 同 CAP-N2。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/codex/` 子目录（含 `codex-app-server-manager.ts` + `codex-runtime-adapter.ts` + binary 发现 / spawn 工具），实现 `AgentRuntimePort`。单测（用 mock child_process / 假 spawn 返回可控 JSON-RPC 通知流，不启真进程）断言：run 经 manager 拿句柄 + 开 thread/turn + 注册 + 产出归一事件流；interrupt 关 thread/turn 返回权威状态；forceKillTurn 关 turn；binary 发现多候选选最新（按 `--version` 排序，防影子）；Windows shim 经 `cmd.exe`（断言 spawn 参数含 `/d /s /c`）；proc exit → 归 PROCESS 错误、onClose 拒 pending RPC；late-unregister no-op（AC-6）。（对应 PRD FR-5.4、AC-6/10，epics-stories S6.3）

- **CAP-N4 · Codex fatal config fail-fast：stderr 签名命中 → 立即 fireClose + SIGKILL（不等 30s linger）**
  - **intent:** 在 `CodexAppServerManager` 内挂 stderr 监听，对 fatal config 签名（`Failed to deserialize overridden config` / `unknown variant` 配 config 上下文 / 其它已知的 codex 启动致命错误）**立即**触发 `fireClose`：发 `SIGKILL` 杀子进程、置 manager 为 failed、拒绝后续 acquire、把所有 pending RPC 拒绝归 `ClassifiedError`（`PROCESS`/`CONFIG` 类，按 SK.ErrorClassifier）。**绝不**等默认的 30s linger——这是把现有 codex 启动卡死问题在适配器层结构化切断（P0.2 / NFR-4）。非 fatal stderr（普通日志/警告）只透传 RuntimeLog，不杀进程。
  - **success:** 在 `CodexAppServerManager` 落 stderr 监听 + fatal 签名表 + `fireClose` 路径。单测（注入可控 stderr 流）断言：fatal config stderr 触发 `fireClose` → 进程被 SIGKILL、`acquire()` 后续返回 unavailable、pending RPC 归 ClassifiedError，**且耗时 << 30s**（断言从 stderr 到 fireClose 同步/微任务级，不进 linger）；非 fatal stderr 不触发 fireClose（只 RuntimeLog）；签名边界（命中 vs 不命中的近似字符串）。（对应 PRD FR-5.4 / NFR-4、AC-10，epics-stories S6.4）

- **CAP-N5 · CodexEventMapper：codex JSON-RPC 通知 → AgentStreamEvent 归一（含 file_changed）**
  - **intent:** 实现核心 `EventMapper` 契约的 Codex 侧具体归一：把 codex app-server 的 JSON-RPC 通知（item lifecycle：`item.created/updated/completed` 的 message_block / reasoning / function_call / function_call_output；`fs.changed` 文件变更；auto-review；usage 等）归一成核心 14 类 `AgentStreamEvent`——文本块 → `text`、推理 → `thinking`、函数调用 → `tool_use`、函数输出 → `tool_result`、`fs.changed` → `file_changed`、终止+usage → `result`（tokenUsage 只投影上报值，无则省略，AC-9）、权限请求 → `permission_request`。未识别通知 → 返回 null 降级（复用 c2-3 契约，不抛、不伪造）。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/codex/codex-event-mapper.ts` 实现核心 `EventMapper`。表驱动单测（录制的 JSON-RPC 通知样本，无真进程）断言：各通知类型归一成结构正确的 `AgentStreamEvent`；`fs.changed` → `file_changed`（paths 正确）；usage 有上报才带（AC-9）；未知通知 → null（AC-8）；跨 Runtime 同语义事件结构与 ClaudeSdk/Native 等价（AC-7 跨 Runtime 一致性，尤其 tool_result 带 media 的归一）。（对应 PRD FR-4.2、AC-7/8/9，epics-stories S6.5）

- **CAP-N6 · 跨 Runtime 故障隔离：RuntimeRouter 三 Runtime 同注册下的健壮性固化**
  - **intent:** RuntimeRouter（c2-6-6 已交付，本期 CAP-3 的 NATIVE/CODEX fail-fast 是「未注册」语义）在三 Runtime **全部注册**后需固化故障隔离：某 Runtime 的适配器实例病（availability 探出 unavailable / acquire 抛错 / run 流中途抛错）**只**影响路由到它的回合，**绝不**影响路由到另外两个 Runtime 的在途回合。具体：(a) RuntimeRouter 的 `streamRuntimeKind` Map 与各适配器内部 registry 互不串扰——一个 adapter 的 Map/进程崩溃不会触碰另一个 adapter 的句柄；(b) availability 聚合时，某 Runtime 落 unavailable 只在自身项体现，不拖垮聚合（聚合仍返回其它 Runtime 的 ready）；(c) failFastStream 路径在三 Runtime 同注册下不应被触发（只在真·未注册/适配器实例缺失时触发，反假数据）。
  - **success:** 扩展 `apps/api/src/agent-runtime/runtime-router.test.ts`（c2-6-6 已有测试基线）追加三 Runtime 同注册场景：注入三个假适配器（含一个故意抛错的「病态」适配器），断言：病态适配器的 run 抛错只影响路由到它的请求（产 error 事件 / 抛 ClassifiedError），另外两个 Runtime 的在途回合事件流**不受影响**（spy 断言其 run/interrupt 未被波及）；availability 聚合返回病态 Runtime unavailable + 健康 Runtime ready（反假数据，不把 unavailable 拖成整体 unknown）；可选：Codex fatal config 场景下，ClaudeSdk/Native 仍可正常路由新回合。（对应 PRD NFR-4、AC-10，epics-stories S6.7）

## Constraints

- **核心零框架不受污染（NFR-1 / AC-14）**：本 epic 全部产物在 `apps/api`，可 `import` `node:child_process` / `node:stream` / `undici` fetch / codex SDK（若有）。但**绝不**把任何 `child_process`/fetch/codex import 加进 `packages/core`；适配器只 `import type` 核心端口（`AgentRuntimePort`/`RuntimeRunRequest`/`TurnRef`/`AgentStreamEvent`/`EventMapper`/`RuntimeKind`/`RuntimeAvailability`/`PermissionDecision` 等）+ 值 import 必要纯函数/枚举（`dropUnknownEvent`/`RuntimeKind`/`projectResultTokenUsage` 等）。`scripts/check-core-imports.mjs` 对 packages/core 仍须 0 命中。
- **RuntimeKind 无需扩展**：`packages/core/src/agent-runtime/{domain/runtime,ports}/runtime-kind.ts` 已含三值。本 epic **不动核心枚举**。若发现某处 RuntimeKind 定义缺失 `NATIVE`/`CODEX`，属上游 correct-course，不在本 epic 范围。
- **复用不重写**：复用 c2-6-1 ClaudeSdkRuntimeAdapter/ClaudeSdkEventMapper 的结构范式（句柄注册 + late-unregister no-op + abort 注入 + EventMapper mapEvent）；复用 c2-3 的 14 类 `AgentStreamEvent` + `EventMapper` 契约 + `dropUnknownEvent` 降级；复用 c2-1 的 `AgentRuntimePort`/`TurnRef`/`RuntimeRunRequest`/`AbortSignalLike`；复用 c2-5 的中断语义（interrupt 返回权威状态供 reconcilePhase）；复用 c2-6-6 RuntimeRouter 的路由骨架。**绝不重定义 14 类联合、绝不重写 EventMapper 契约、绝不重写 RuntimeRouter。**
- **进程复杂度锁在 Codex 适配器内（AC-10）**：`child_process` spawn / binary 发现 / stderr 监听 / `SIGKILL` / orphan 规避 全部锁在 `apps/api/src/agent-runtime/adapters/codex/` 内；对外只经 `AgentRuntimePort` 暴露归一事件 + 权威状态。核心 StreamSession/用例代码不出现 `child_process`/codex 私有结构。
- **HTTP 复杂度锁在 Native 适配器内**：fetch / SSE 解析 / ReadableStream / AbortController 全锁在 NativeRuntimeAdapter 内；对外只经 `AgentRuntimePort` 暴露归一事件 + 权威状态。
- **fatal config fail-fast 不卡死（NFR-4 / AC-10）**：Codex fatal config stderr 触发 `fireClose` + `SIGKILL` 必须同步/微任务级，**绝不**等 30s linger；`onClose` 拒绝所有 pending RPC（防 30s RPC timeout 卡死核心）。
- **反假数据（AC-9）**：`result` 事件 tokenUsage 只投影 Runtime 真实上报值（Native/Codex 上报的 usage），无上报省略、绝不填 0；availability 探测失败落 unavailable + reason，绝不显假 ready；Codex binary 探不到落 unavailable，绝不假定 ready。
- **fail-fast 不卡死（NFR-4）**：适配器 run/interrupt 抛错、进程 spawn 失败、fatal config、僵死 都要 fail-fast 归 `ClassifiedError`（经 SK.ErrorClassifier），以归一 `error` 事件或抛出暴露，绝不静默吞、绝不让核心回合停在 active（配合 c2-5 force-abort 兜底）。
- **跨 Runtime 故障隔离（NFR-4 / AC-10）**：任一 Runtime 病只影响其自己路由的回合，不污染另外两个 Runtime；RuntimeRouter 的可用性聚合不被单一病态 Runtime 拖垮。
- **`verbatimModuleSyntax`**：类型-only import 用 `import type` + `.js` 扩展名（NodeNext）；apps/api 侧同样遵守。
- **DI 接线归本 epic**：c2-7-4 的 `AgentRuntimeModule` useFactory 已注入 `{ [CLAUDE_SDK]: claudeSdkAdapter }`。本 epic 在该 useFactory 里**追加** Native/Codex 适配器实例到 adapter map（属本 epic 故事范围，对齐 sprint-status `c2-6-2~5/6-7`）；不动 Module 结构、不动 forwardRef 解环、不动 Controller。
- **测试策略**：CAP-N1~N6 全部用**录制样本 + mock fetch / mock child_process** 做纯单元/表驱动测试（`npm run test` 层，无真实网络/进程）；连真 Native provider / 真 codex binary 的集成验证单独进行（人在场，不进 `npm run test` 默认门禁，避免 CI 依赖外部网络/进程）。
- **依赖 pin 版本**：若引入 codex SDK / SSE 解析库到 `apps/api/package.json`，用确切版本（非 `^`/`~` 范围），避免供应链漂移。优先用 Node 内建 `fetch`（Node 18+）与手写 SSE 行解析，避免新增依赖。

## Non-goals

- 不改 `packages/core` 的任何核心类型/用例/聚合根（只复用 `import type` + 纯函数值 import）；`RuntimeKind` 已含三值，无需扩展。如核心端口签名不足需扩展，走 correct-course。
- 不重写 ClaudeSdkRuntimeAdapter（c2-6-1）/ RuntimeRouter（c2-6-6）/ EventMapper 契约（c2-3）/ AgentRuntimePort（c2-1）；只在它们之上「加第二、第三个 Runtime」。
- 不建新的 NestJS Module、不改 `forwardRef` 解环、不接新的 Controller（属 c2-7 已交付范围）。本 epic 仅在 `AgentRuntimeModule` 的 useFactory 里追加适配器实例到 adapter map。
- 不把连真 Native provider / 真 codex binary 的 E2E 加进默认 `npm run test`（避免门禁依赖外部网络/进程）；真代理/binary 验证单独人在场跑。
- 不实现 codex 的 MCP 集成 / 子 agent 编排 / codex 会话恢复（resume）等 codex 高级特性——本 epic 只接通「发起 → 归一事件 → 中断 → 终态」最小可用链路，对齐 FR-5.4 的进程隔离边界。
- 不实现 Native provider 的 OAuth/刷新令牌流（auth 注入只读 `resolvedProvider` 已解析的凭证）；不做 Native provider 协议适配器插件化（硬编码当前约定 SSE JSON 帧格式）。
- 不重新定义 codex fatal config 签名表的「权威来源」（签名表内联在适配器，按已知错误字符串维护；未来若 codex 升级改签名，走 correct-course 更新）。

## Success signal

`npm run test` 全绿（typecheck + `check-core-imports` 守卫对 packages/core 0 命中 + vitest 全通过），新增的 apps/api 适配器/mapper 单测通过：

- NativeSseEventMapper 表驱动归一各类型 SSE 帧（含 usage 无上报省略、未知帧 → null、跨 Runtime 同语义结构一致）。
- NativeRuntimeAdapter run 用 fetch 发起 SSE 流 + 注册句柄 + 产出归一事件流；interrupt 调 abort + 返回权威状态 + 注销句柄；forceKillTurn 关 reader；late-unregister no-op（AC-6）；auth/endpoint 正确注入。
- CodexRuntimeAdapter 经 CodexAppServerManager spawn 子进程 + binary 发现多候选选最新 + Windows shim 经 cmd.exe + 开 thread/turn + 产出归一事件流；interrupt 关 thread/turn；proc exit 归 PROCESS 错误、onClose 拒 pending RPC；late-unregister no-op（AC-6）。
- Codex fatal config stderr 触发 fireClose + SIGKILL 同步级（**不等 30s**），pending RPC 归 ClassifiedError，后续 acquire unavailable（AC-10）。
- CodexEventMapper 表驱动归一各 JSON-RPC 通知（含 `fs.changed` → `file_changed`、usage 无上报省略、跨 Runtime 同语义结构一致）。
- 跨 Runtime 故障隔离：三 Runtime 同注册下，病态适配器只影响其自己路由，不污染另外两个 Runtime；availability 聚合不被单一病态 Runtime 拖垮（反假数据）。

`node:child_process` / codex SDK / fetch import 只出现在 apps/api、packages/core 守卫 0 命中。**连真 Native provider / 真 codex binary 的集成验证**（人在场，单独跑）：真实回合事件正确归一、abort 中断关句柄、fatal config 即时失败。

## Assumptions

- 假设 Native HTTP provider 的 SSE 流格式稳定（约定 `data: {json}\n\n`，json 含判别字段 `type`/`event`）；若 provider 协议变动，NativeSseEventMapper 表驱动可低成本扩展。
- 假设 codex app-server binary 在本机 PATH 或 macOS bundle 可发现（对齐 CLAUDE.md codex 相关排查方向）；多候选版本选择按 `--version` 排序可区分新旧。
- 假设 codex fatal config 的已知 stderr 签名（`Failed to deserialize overridden config` / `unknown variant`+config 上下文）覆盖当前 codex 版本的致命错误；未来 codex 升级新增签名走 correct-course。
- 假设 Node 运行时（apps/api）具备内建 `fetch`（Node 18+）与 `AbortController`，无需新增 HTTP 依赖。
- 假设 c2-6-1（ClaudeSdkRuntimeAdapter / ClaudeSdkEventMapper）/ c2-6-6（RuntimeRouter）/ c2-3（EventMapper + 14 类事件 + dropUnknownEvent）/ c2-1（AgentRuntimePort/TurnRef/RuntimeRunRequest/AbortSignalLike）/ c2-5（interrupt 权威状态语义）/ c2-7-4（AgentRuntimeModule useFactory 注入 adapter map）均已交付并稳定，本 epic 经 `import type`/值 import 复用不改写。
- 假设把 Native/Codex 适配器实例追加进 RuntimeRouter 的 adapter map 是 `AgentRuntimeModule` useFactory 内的最小改动（不触发 spec_checkpoint，因不改 Module 结构/forwardRef/Controller）；若实际接线跨边界，按 c2-7 spec_checkpoint 纪律处理。
- 假设 `packages/core` 脚手架、`npm run test`、`tsc --build`、`check-core-imports` 守卫已就位且对 apps/api 新增文件不产生误命中。
