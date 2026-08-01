---
id: SPEC-epic-c2-6
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-6 · ClaudeSdkRuntimeAdapter + ClaudeSdkEventMapper + RuntimeRouter（本期唯一 Runtime）

## Why

到 c2-5 为止，C2 的**核心编排**已全部就位（StartStream/AbortStream 用例、StreamSession 聚合根、EventMapper 契约），但它们消费的 `AgentRuntimePort` 还没有任何**真实实现**——`run()`/`interrupt()`/`forceKillTurn()` 全是接口。本 epic 落地本期唯一的具体 Runtime 适配器，把纯核心接到真实 AI 调用：

- **ClaudeSdkRuntimeAdapter**（apps/api，隔离 SDK）：封装 `@anthropic-ai/claude-agent-sdk` 的 `query()`/`Query` 句柄，实现 `AgentRuntimePort`。`run` 时以 `streamId`（lockId 角色）注册 Query 句柄；`interrupt` 组合「abort application-owned signal + `Query.interrupt()`」；`forceKillTurn` 强制关句柄。**late-unregister no-op**：旧 streamId 的 teardown 绝不 evict 新 turn 的句柄（AC-6）。调 `query()` 时把 `apps/api/.env` 的 litellm 配置注入 `options.env`（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/各 `*_MODEL=Jereh-Kimi-K2.6` 等）。
- **ClaudeSdkEventMapper**（apps/api）：把 SDK message 归一成核心的 `AgentStreamEvent`（text/thinking/tool_use/tool_result/result/permission_request 等），实现核心侧 `EventMapper` 契约。未知/无法识别的 SDK message 走 c2-3 已定的降级（返回 null 跳过，不抛、不伪造）。**Kimi-K2.6 特性**：litellm 网关路由的 Kimi 模型会返回思维链——OpenAI 风格 `reasoning_content` / Anthropic 风格 thinking block，EventMapper 要把它归一到 `thinking` 事件、正式回答归一到 `text` 事件。
- **RuntimeRouter**（apps/api）：实现 `AgentRuntimePort`，按 `RuntimeKind` 路由到对应适配器；本期只有 `CLAUDE_SDK` → ClaudeSdkRuntimeAdapter，`NATIVE`/`CODEX` 未实现（deferred）——路由到未实现 Runtime 时 fail-fast 归 `ClassifiedError`（不静默、不卡死）。`availability()` 非 spawn 探测。

**边界铁律**：本 epic 全部代码在 `apps/api`（框架/基础设施层），可以 import `@anthropic-ai/*`。核心包 `packages/core` 仍**零框架**——`scripts/check-core-imports.mjs` 守卫只扫 `packages/core`，对本 epic 新增的 apps/api 文件 0 命中要求依旧（因为它们不在 packages/core 下，天然不被扫）；但要确保**没有把 SDK import 泄漏进 packages/core**。适配器只 `import type` 核心的端口/领域类型 + 值 import 必要的纯函数/枚举，绝不反向让核心依赖框架。

本期范围（对齐 sprint-status）：只实现 **c2-6-1**（ClaudeSdkRuntimeAdapter + ClaudeSdkEventMapper）与 **c2-6-6**（RuntimeRouter）；`c2-6-2~5/6-7`（Native/Codex 适配器与跨 Runtime 故障隔离）**deferred**——接口/路由保留，将来加新 Runtime 不改核心。

## Capabilities

- **CAP-1 · ClaudeSdkEventMapper：SDK message → AgentStreamEvent 归一（含 Kimi thinking）**
  - **intent:** 实现核心 `EventMapper` 契约的 Claude 侧具体归一：把 `@anthropic-ai/claude-agent-sdk` 的流式 message（`assistant`/`stream_event`/`result` 等）逐条映射为核心 14 类 `AgentStreamEvent` 之一——文本增量→`text`（注意核心 `text` 语义是累积全文，见 c2-2 apply）、思维链→`thinking`（delta 增量）、工具调用→`tool_use`、工具结果→`tool_result`、终止+usage→`result`（tokenUsage 只投影 Runtime 上报值，无则省略，AC-9）、权限请求→`permission_request`。未识别 message → 返回 null 降级（复用 c2-3 契约，不抛、不伪造）。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/claude-sdk-event-mapper.ts` 实现核心 `EventMapper`。表驱动单测（录制的 SDK message 样本，无真实网络）断言：各类 message 归一成结构正确的 `AgentStreamEvent`；Kimi 的 `reasoning_content`/thinking block → `thinking` 事件、正文 → `text` 事件；`result` 的 usage 有上报才带、无则省略（AC-9）；未知 message → null（AC-8）。（对应 PRD FR-4.2/FR-5.2、AC-7/8/9，epics-stories S6.1 后半）

- **CAP-2 · ClaudeSdkRuntimeAdapter：封装 Query 句柄 + run/interrupt/forceKillTurn + late-unregister no-op**
  - **intent:** 实现 `AgentRuntimePort`。`run(request)`：调 `query()`（把 promptView/content 转成 SDK 输入、把 .env 注入 `options.env`、把 request.abortSignal 接到 SDK），以 `streamId` 注册返回的 `Query` 句柄进内部 registry；产出经 ClaudeSdkEventMapper 归一的 `AgentStreamEvent` 异步流。`interrupt(turnRef)`：先 abort application-owned signal 再 `Query.interrupt()`，返回 Runtime 权威状态字符串（供 reconcilePhase）；关闭并注销该 streamId 的句柄。`forceKillTurn(turnRef)`：强制关句柄兜底。**late-unregister no-op**：注销时校验 streamId 归属——旧 turn 的 teardown 传入过期 streamId 时，绝不 evict 新 turn 已注册的句柄（AC-6）。
  - **success:** 新增 `apps/api/src/agent-runtime/adapters/claude-sdk-runtime-adapter.ts` 实现 `AgentRuntimePort`。单测（用假/mock 的 `query()` + 假 Query 句柄，不打真网络）断言：run 注册句柄并产出归一事件流；interrupt 调 abort+Query.interrupt 并返回权威状态、注销句柄；forceKillTurn 关句柄；late-unregister（旧 streamId 注销）为 no-op、不影响新 turn 句柄（AC-6）；.env 配置被注入 `options.env`。（对应 PRD FR-5.2、AC-6，epics-stories S6.1 前半）

- **CAP-3 · RuntimeRouter：按 RuntimeKind 路由 + availability 非 spawn 探测**
  - **intent:** 实现 `AgentRuntimePort`，内部持有各 RuntimeKind → 适配器的映射；`run`/`interrupt`/`forceKillTurn` 按 request/turnRef 的 runtimeKind 委派到对应适配器。本期只注册 `CLAUDE_SDK` → ClaudeSdkRuntimeAdapter；路由到未注册的 `NATIVE`/`CODEX` 时 fail-fast——归 `ClassifiedError`（经 SK.ErrorClassifier）并以归一 `error` 事件/抛错暴露，绝不静默返回空、绝不卡死核心。`availability()` 聚合已注册适配器的可用性（非 spawn 探测；Claude 适配器探配置/端点可达性，不发起真实回合）。
  - **success:** 新增 `apps/api/src/agent-runtime/runtime-router.ts` 实现 `AgentRuntimePort`。单测断言：CLAUDE_SDK 请求委派到 ClaudeSdkRuntimeAdapter；NATIVE/CODEX 请求 fail-fast 归 ClassifiedError（不静默）；availability 返回已注册 Runtime 的可用性投影、未注册的标 unavailable/unknown（反假数据，不显假 ready）。（对应 PRD FR-5.1、epics-stories S6.6）

## Constraints

- **核心零框架不受污染（NFR-1 / AC-14）**：本 epic 全部产物在 `apps/api`，可 import `@anthropic-ai/claude-agent-sdk`。但**绝不**把任何 SDK/框架 import 加进 `packages/core`；适配器只 `import type` 核心端口（`AgentRuntimePort`/`RuntimeRunRequest`/`TurnRef`/`AgentStreamEvent`/`EventMapper`/`RuntimeKind` 等）+ 值 import 必要纯函数/枚举。`scripts/check-core-imports.mjs` 对 packages/core 仍须 0 命中。
- **SDK 依赖 pin 版本**：`@anthropic-ai/claude-agent-sdk` 加进 `apps/api/package.json` 的 dependencies，用确切版本（非 `^`/`~` 范围），避免供应链漂移。
- **litellm 配置只在运行时经 .env 注入（架构 §7.1）**：适配器调 `query()` 时把 `apps/api/.env` 的 `ANTHROPIC_BASE_URL=https://litellm.jereh.cn`/`ANTHROPIC_AUTH_TOKEN`/各 `*_MODEL=Jereh-Kimi-K2.6`/`CLAUDE_CODE_*` 注入 `options.env`。`.env` 已 gitignored，`ANTHROPIC_AUTH_TOKEN` **绝不入库/回显/写进日志**。读 .env 的机制在 apps/api（如 process.env / @nestjs/config），核心包禁读 process.env。
- **归一只经 EventMapper、核心不见 SDK 细节**：ClaudeSdkRuntimeAdapter 产出的对外事件流必须是**已归一**的 `AgentStreamEvent`；SDK message 类型、Query 句柄、abort 机制等细节全锁在 apps/api 适配器内，核心 StreamSession/用例代码不出现。
- **late-unregister no-op（AC-6）**：句柄注册以 streamId 为键；注销/teardown 必须校验归属——旧 turn 的过期 streamId 绝不 evict 新 turn 的句柄。这是 #578 相关的残留防护，必须有单测覆盖。
- **反假数据（AC-9）**：`result` 事件 tokenUsage 只投影 SDK 真实上报值，无上报省略、绝不填 0；availability 探测失败落 unavailable+reason，绝不显假 ready。
- **fail-fast 不卡死（NFR-4）**：RuntimeRouter 路由到未实现 Runtime、SDK 调用抛错，都要 fail-fast 归 `ClassifiedError`，经归一 error 事件或抛出暴露，绝不静默吞、绝不让核心回合停在 active（配合 c2-5 的 AbortStream 兜底）。
- **`verbatimModuleSyntax`**：类型-only import 用 `import type` + `.js` 扩展名（NodeNext）；apps/api 侧同样遵守。
- **DI 接线属 c2-7**：本 epic 只产出适配器/mapper/router 类 + 其单测；把它们接进 `AgentRuntimeModule`（NestJS DI、绑 token、forwardRef 解 C1↔C2 环、Controller）属 epic-c2-7。本 epic 不建 AgentRuntimeModule、不接 Controller。
- **测试策略**：CAP-1/2/3 全部用**录制样本 + mock query()** 做纯单元/表驱动测试（`npm run test` 层，无真实网络）；连真 litellm 代理的集成验证单独进行（人在场，不进 `npm run test` 默认门禁，避免 CI 依赖外部网络）。

## Non-goals

- 不实现 NativeRuntimeAdapter/NativeSseEventMapper（c2-6-2 deferred）、CodexRuntimeAdapter/CodexEventMapper/进程隔离/fatal-config fail-fast（c2-6-3~5 deferred）、跨 Runtime 故障隔离专项（c2-6-7 deferred）——接口与 RuntimeRouter 路由位保留，将来加新 Runtime 不改核心。
- 不建 `AgentRuntimeModule` NestJS DI 接线、不接 Controller、不做 forwardRef 解 C1↔C2 环、不实现 TitleGenerator/权限中转——属 epic-c2-7。
- 不改 `packages/core` 的任何核心类型/用例/聚合根（只复用 `import type` + 纯函数值 import）；如核心端口签名不足需扩展，走 correct-course。
- 不把连真代理的 E2E 加进默认 `npm run test`（避免门禁依赖外部网络）；真代理验证单独人在场跑。
- 不实现 SSE 广播/事件日志/REST 三件套/断线补发/CLI（属 EPIC-ACCEPT）。

## Success signal

`npm run test` 全绿（typecheck + `check-core-imports` 守卫对 packages/core 0 命中 + vitest 全通过），新增的 apps/api 适配器/mapper/router 单测通过：ClaudeSdkEventMapper 表驱动归一各类 SDK message（含 Kimi thinking→thinking、正文→text、usage 无上报省略、未知→null）；ClaudeSdkRuntimeAdapter run 注册句柄+产出归一流、interrupt 组合 abort+Query.interrupt 返回权威状态、forceKillTurn 关句柄、late-unregister no-op（AC-6）、.env 注入 options.env；RuntimeRouter CLAUDE_SDK 委派正确、未实现 Runtime fail-fast 归 ClassifiedError、availability 反假数据。`@anthropic-ai/*` import 只出现在 apps/api、packages/core 守卫 0 命中。**连真 litellm 代理的集成验证**（人在场，单独跑）：真实回合 text/thinking 事件正确归一、abort 中断关句柄、canAccept 恢复。

## Assumptions

- 假设 litellm 网关（`https://litellm.jereh.cn`）的 **Anthropic 原生 `/v1/messages` 端点可用**（已用 `x-api-key`+`anthropic-version` curl 验证 HTTP 200、返回标准 Anthropic message 格式），`@anthropic-ai/claude-agent-sdk` 经 `ANTHROPIC_BASE_URL` 指向它可正常工作；模型别名 `Jereh-Kimi-K2.6` 路由到 Kimi-K2.6。
- 假设 `apps/api/.env` 已含全部 litellm 配置且 `ANTHROPIC_AUTH_TOKEN` 有效（已 curl 验证连通）；`.env.example` 为入库模板。
- 假设 epic-c2-1~5 已交付并稳定：`AgentRuntimePort`（run/interrupt/forceKillTurn/availability + RuntimeRunRequest/TurnRef/AbortSignalLike）、`EventMapper` 契约、14 类 `AgentStreamEvent` 与构造/判别工具、`RuntimeKind`/`RuntimeAvailability`、`ClassifiedError`/`ErrorClassifier` 均为最终版本，本 epic 经 `import type`/值 import 复用不改写。
- 假设 `@anthropic-ai/claude-agent-sdk` 可经 npm 安装（apps/api 依赖）；其 `query()` API 支持 `options.env` 注入运行时环境变量（对齐架构 §7.1）。
- 假设把适配器接进 NestJS DI（AgentRuntimeModule/forwardRef/Controller）留待 c2-7；本 epic 产物为可独立单测的适配器/mapper/router 类。
- 假设 `packages/core` 脚手架、`npm run test`、`tsc --build`、`check-core-imports` 守卫已就位。
