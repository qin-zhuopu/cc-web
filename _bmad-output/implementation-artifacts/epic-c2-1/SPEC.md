---
id: SPEC-epic-c2-1
companions:
  - docs/contexts/c2-agent-runtime/architecture.md
  - docs/contexts/c2-agent-runtime/prd.md
  - docs/contexts/c2-agent-runtime/epics-stories.md
sources:
  - docs/contexts/c2-agent-runtime/product-brief.md
---

> **规范契约。** 本 SPEC 与 `companions:` 中的文件构成本 epic「造什么、测什么、验什么」的完整契约。frontmatter 里的 source 文档仅供追溯，只在需要叙述性背景时查阅。

# Epic C2-1 · AgentRuntime 领域与端口骨架（类型 / 枚举 / 纯函数判定 / 端口接口）

## Why

CodePilot 现有 stop/abort 卡死的根因是**运行时相位判断散落且靠人工纪律**：每条中断分支都要「记得翻状态」，interrupt 一挂起就没人把回合翻终态，phase 停在 active、composer gate 永久锁死（GitHub #578）。C2（AgentRuntime）的招牌价值是把「中断不卡死」从运行时纪律升级成**结构化不变量**——`active → settling → terminal`、force-abort 无条件先行、`canAccept() ≡ phase !== active`。

本 epic 是这套保证的**类型契约地基**：它只落地 C2 核心包的领域类型、枚举、纯函数判定与端口接口骨架（`StreamPhase` / `canTransitionPhase` / `reconcilePhase` / `TerminalReason` / `TurnArtifacts` / `buildFinalContent` / 14 类 `AgentStreamEvent` / `RuntimeKind` / 驱动端口 / 出站端口 / 禁用 import 守卫 / `c2.*` 消息键），**不实现 `StreamSession` 聚合根行为**（属 epic-c2-2）。地基先把「哪些迁移合法」「终态归因怎么分」「产物怎么投影」「事件长什么样」「谁依赖谁」用类型固化下来，聚合根与 #578 反例回归才能在下一个 epic 站在类型不变量上安全构建。SK（`ErrorClassifier`/`Clock`/`IdGenerator` 等）与 C1 用例端口已就位或经 `import type` 引用，C2 是六边形架构中 SK 之后、承上（C3/C5 消费）启下（C1/C7 依赖）的核心运行时边界，其类型骨架必须先于一切用例逻辑正确交付。

## Capabilities

- **CAP-1 · StreamPhase 相位状态机类型 + StreamSessionId**
  - **intent:** 用类型固化实时相位机 `active → settling → terminal`（终态带 `{ completed, aborted, errored }` 子态），并提供 `isActive`/`isTerminal` 判定与 `StreamSessionId` 值对象，作为「现在还在生成吗」的唯一实时判据类型。
  - **success:** `domain/stream/stream-phase.ts` 定义 `StreamPhaseKind`（ACTIVE/SETTLING/TERMINAL）、`TerminalSubstate`（COMPLETED/ABORTED/ERRORED）、判别联合 `StreamPhase` 与 `isActive`/`isTerminal` 判定函数签名，`StreamSessionId` 值对象与 architecture.md §3.1/§3.2 一致（对应 PRD FR-1.1/1.2、epics-stories S1.1）。

- **CAP-2 · canTransitionPhase 合法迁移谓词 + reconcilePhase**
  - **intent:** 提供纯函数 `canTransitionPhase(from, to)` 判定合法迁移（`active→settling`/`active→terminal`/`settling→terminal` 合法；任意 `terminal→*`、`settling→active`/`terminal→active` 回退非法），及 `reconcilePhase(runtimeStatus, current)` 把 Runtime 权威状态收敛为目标相位。
  - **success:** `domain/stream/phase-transition.ts` 定义两个纯函数签名，`canTransitionPhase` 覆盖合法/非法全矩阵、`reconcilePhase` 对 `running`/未知返回 null（不纠正，force-abort 网兜底）、对 `idle`/`interrupted`/`error` 返回 terminal 子态，与 architecture.md §3.1 一致（对应 PRD FR-1.3/3.3、AC-1、epics-stories S1.2）。

- **CAP-3 · TerminalReason 终态归因 + SK.ErrorClassifier 映射约定**
  - **intent:** 定义 `TerminalReasonCode`（6 类归因码）与 `TerminalReason` 值对象，明确各归因码到 `SK.ErrorClassifier` 分类的映射约定，使 UI 能区分「我停的」vs「超时」vs「出错」。
  - **success:** `domain/stream/terminal-reason.ts` 定义 `TerminalReasonCode`（COMPLETED/USER_ABORTED/IDLE_TIMEOUT/TOOL_TIMEOUT/RUNTIME_ERROR/PROCESS_DIED）与含 `classified: ClassifiedError` 的 `TerminalReason`，映射约定说明 `user_aborted→ABORTED`、`idle_timeout→TIMEOUT`、`tool_timeout→PROCESS/TIMEOUT`、`process_died→PROCESS` 归类不同，与 architecture.md §3.3 一致（对应 PRD FR-3.6、AC-5、epics-stories S1.3）。

- **CAP-4 · TurnArtifacts 累积产物值对象 + buildFinalContent**
  - **intent:** 定义 `TurnArtifacts` 值对象（text/thinking/toolUses/toolResults）与纯函数 `buildFinalContent`，把累积产物投影成落 C1 的内容块（五路投影：纯文本/thinking/tool/孤儿 tool_result/全空→null）。
  - **success:** `domain/stream/turn-artifacts.ts` 定义只读 `TurnArtifacts` 与 `buildFinalContent(artifacts): string | null` 签名，语义说明纯文本→text、含 thinking/tool→blocks[]、孤儿 tool_result 保留、全空→null（空回合不落库），与 architecture.md §3.4 一致（对应 PRD FR-2.6/FR-4、epics-stories S1.4）。

- **CAP-5 · AgentStreamEvent 统一事件联合 + 值对象**
  - **intent:** 定义 14 类 `AgentStreamEvent` 判别联合与 `ToolUseInfo`/`ToolResultInfo`/`TokenUsage`/`ContextUsage` 值对象，作为跨 Runtime 归一的统一事件模型；usage 只存 Runtime 上报投影，不估算不填 0。
  - **success:** `domain/event/agent-stream-event.ts`、`domain/event/tool-info.ts`、`domain/event/usage.ts` 定义联合与值对象签名，`result` 事件 `tokenUsage` 可空（无上报留空）、`phase_changed` 标注为 C2 核心产出（非 Runtime 归一），与 architecture.md §3.5 一致（对应 PRD FR-4.1/4.4、AC-9、epics-stories S1.5）。

- **CAP-6 · RuntimeKind / RuntimeAvailability + 驱动端口与出站端口骨架**
  - **intent:** 定义 `RuntimeKind`/`RuntimeAvailability`，驱动端口（`StartStreamUseCase`/`AbortStreamUseCase`/`TitleGenerator`）与出站端口（`AgentRuntimePort`）的接口签名，并以 `import type` 引用 C1 用例端口与 C7 `ProviderRepository`，`index.ts` 只导出端口与领域类型。
  - **success:** `domain/runtime/*`、`ports/driving/*`、`ports/driven/*` 定义 architecture.md §3.6/§4/§5 的接口签名（含 `StartStreamInput`/`StartStreamResult`/`RuntimeRunRequest`/`TurnRef` 等），`conversation-ports.ts`/`provider-read-port.ts` 仅 `import type` 转出 C1/C7 端口类型，`index.ts` 只导出端口与领域类型；本 epic 只给接口签名不给用例实现（对应 PRD FR-2/3/5/6、epics-stories S1.6）。

- **CAP-7 · 禁用 import 静态守卫**
  - **intent:** 建立静态扫描守卫，保证 `agent-runtime/` 核心包对框架/SDK/DB/子进程/非确定性 API 的 import 0 命中，把「核心零框架」从约定变成可执行门禁。
  - **success:** 守卫覆盖 `packages/core/agent-runtime/` 全目录，对 `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`/`child_process`、`Date.now`、`randomUUID` 0 命中并可在 `npm run test` 层执行，与 architecture.md §9、prd.md NFR-1 一致（对应 PRD AC-14、epics-stories S1.7）。

- **CAP-8 · C2 message-keys（c2.*）**
  - **intent:** 定义 C2 自身 i18n 键（`c2.*`，覆盖状态/错误/中断提示），用户可见文案经 key + `SK.TranslationPort` 渲染，错误 key 复用 `SK.ErrorClassifier.messageKey`。
  - **success:** `domain/message-keys.ts` 定义 `c2.*` 键集合，说明用户可见文案经 key + `SK.TranslationPort`、错误文案 key 来自 `SK.ErrorClassifier.messageKey`，与 architecture.md §6（末段）、prd.md NFR-7 一致（对应 epics-stories S1.8）。

## Constraints

- **核心零框架 import（NFR-1 / AC-14）**：`packages/core/agent-runtime/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:child_process`、`codex` SDK，禁止直调 `Date.now()`/`new Date()`/`randomUUID()`。SDK/进程/HTTP 细节全锁在 `apps/api` 适配器层（本 epic 不产出适配器）。
- **`verbatimModuleSyntax` 已启用**：类型-only import 必须用 `import type`，模块说明符带 `.js` 扩展名（NodeNext 解析），否则 `tsc --build` 报错。本 epic 每个跨文件类型引用（`StreamPhase`/`TerminalReason`/`ClassifiedError`/`ToolUseInfo`/C1/C7 端口类型等）都须遵守。
- **phase 不落库、不与 C1 持久 StreamStatus 混用（NFR-2 / AC-15，架构铁律）**：`StreamPhase` 是实时内存态，回答「现在这一刻还在生成吗」，绝不落库；C2 核心不 import、不建模 C1 的持久 `StreamStatus`（streaming/completed/interrupted/error）做实时判断。这是 stop/abort 卡死根因的类型级切断，本 epic 在类型定义处就必须切干净。
- **核心只单向 `import type` SK / C1 / C7**：C2 依赖 `SK.ErrorClassifier`/`Clock`/`IdGenerator`/`RuntimeLog`/`TranslationPort`、`C1.AppendMessageUseCase`/`GetSessionHistoryUseCase`、`C7.ProviderRepository`，核心包一律经 `import type` 只引用接口类型，不引入实现级依赖。C1↔C2 循环依赖在 NestJS 接线层用 `forwardRef` 解，本 epic 是纯类型/端口，核心内无实现级环。
- **本 epic 只定义类型/枚举/纯函数判定/端口骨架**：`canTransitionPhase`/`reconcilePhase`/`buildFinalContent` 是无副作用纯函数；驱动/出站端口只给接口签名。**不实现 `StreamSession` 聚合根行为**（`markSettling`/`complete`/`abort`/`fail`/`apply`/`canAccept` 的实现属 epic-c2-2）；接口/类型签名以 architecture.md 为准，不得增删或改名，新增需求走 correct-course。

## Non-goals

- 不实现 `StreamSession` 聚合根与其迁移方法（`markSettling`/`complete`/`abort`/`fail`/`apply`/`canAccept`），也不做 #578 abort 卡死反例回归（interrupt 永不 resolve 仍翻 `terminal(aborted)`）——属 epic-c2-2。
- 不实现 `StartStreamService`/`AbortStreamService`/`GenerateTitleService`/`StreamSessionRegistry` 等用例编排与 force-abort 先行逻辑（属 epic-c2-2 及后续）。
- 不定义/实现 EventMapper 契约与未知事件降级规则（属 epic-c2-3）。
- 不接入 Claude Agent SDK / Native SSE / Codex app-server 三适配器（属 epic-c2-6）。
- 不接入 NestJS DI（`AgentRuntimeModule`、`forwardRef`、Controller）与终态→C1 StreamStatus 映射的实现（属后续 epic）。

## Success signal

在 `packages/core` 内运行 `npm run test` 全绿，且 `tsc --build` 在 `verbatimModuleSyntax` 下通过；禁用 import 静态守卫对 `packages/core/agent-runtime/` 全目录 0 命中（`@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`child_process`/`Date.now`/`randomUUID`）。八个故事各自的类型/纯函数单测通过：`canTransitionPhase` 合法/非法迁移全矩阵、`reconcilePhase` running→null 与 terminal 收敛、`buildFinalContent` 五路投影 + 全空→null、`TerminalReasonCode` 六类归因到 `ClassifiedError.code` 的映射区分、14 类 `AgentStreamEvent` 结构完整、端口 `index.ts` 只导出端口与领域类型、`c2.*` 消息键集合就位。

## Assumptions

- 假设 `packages/core` 脚手架、`packages/core/agent-runtime/` 目录、`npm run test` 运行器与 `tsc --build` 增量构建已由 monorepo 地基任务就位；若在 c2-1-1 dispatch 时目录或运行器尚不可用，dev-auto 应 block 并提示先完成地基。
- 假设 SK 已交付 `ErrorClassifier`（16 类含 `ABORTED`）、`Clock`/`IdGenerator`/`RuntimeLog`/`TranslationPort` 端口与 `messageKey` 语义稳定，C2 经 `import type` 引用其接口类型。
- 假设 C1 已定义 `AppendMessageUseCase`/`GetSessionHistoryUseCase` 端口类型、C7 已定义只读 `ProviderRepository` 端口类型可供 C2 `import type`；若尚未就位，c2-1-6 的 `conversation-ports.ts`/`provider-read-port.ts` 别名应 block 并提示先完成对应端口定义。
- 假设 architecture.md §3/§4/§5 的类型与端口签名（`StreamPhase`/`TerminalReason`/`TurnArtifacts`/`AgentStreamEvent`/`RuntimeKind`/驱动与出站端口）为最终版本，无待决问题；聚合根行为语义留待 epic-c2-2 落地。
