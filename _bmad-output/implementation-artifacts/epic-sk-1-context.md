# Epic sk-1 Context: 结构化错误分类

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

把 16 类结构化错误与分类能力落成核心包（Shared Kernel）的稳定契约，作为全项目错误的单一事实来源。绞杀者迁移中错误语义散落在各 Runtime / Provider，导致 UI 错误提示不一致、无法可靠区分「可重试」与「终态失败」。SK 是迁移第一站、无上游依赖，把结构化错误落成零框架核心包后，AgentRuntime（C2）与 Provider（C7）能统一消费，消除错误语义漂移。

## Stories

- Story sk-1-1: 定义 16 类错误码与领域类型
- Story sk-1-2: 实现 ErrorClassifier 分类逻辑
- Story sk-1-3: 定义 SK i18n 消息键常量

## Requirements & Constraints

- `ErrorCode` 枚举必须精确包含 16 类：NETWORK / TIMEOUT / RATE_LIMIT / AUTH / PERMISSION / INVALID_REQUEST / NOT_FOUND / CONFLICT / SERVER / UNAVAILABLE / QUOTA_EXCEEDED / RESOURCE_LIMIT / FILESYSTEM / PROCESS / ABORTED / UNKNOWN。清单为最终版本，不得增删或改名；新增需求走 correct-course。
- `ClassifiedError` 是不可变值对象，含 `code` / `messageKey` / `retryable` / `cause?` / `detail?` 字段。
- `classify(error: unknown): ClassifiedError` 是纯函数：同输入同输出、无副作用、无 I/O；无法识别归 `UNKNOWN` 且永不抛出。`retryable` 对 NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE 为 true。
- `SK_MESSAGE_KEYS` 常量表为每个 `ErrorCode` 提供唯一 `sk.error.*` 键，键为常量、只读；SK 不含任何 locale 文案表（文案由 apps/api 适配器提供）。
- 核心包铁律：`packages/core` 的 shared-kernel 源码禁止 import `@nestjs/*`、`better-sqlite3`、`@anthropic-ai/*`、`uuid`，禁止直调 `Date.now` / `randomUUID`。该禁用 import 静态扫描需纳入 `npm run test` 门禁。

## Technical Decisions

- 目录结构：错误相关类型置于 `packages/core` 的 `domain/error/` 下——`error-code.ts`（枚举）、`classified-error.ts`（值对象）、`message-keys.ts`（键常量）。端口置于 `ports/`，桶文件 `index.ts` 仅导出端口与领域类型。
- 分层：SK 定义接口/类型契约，具体适配器实现（SystemClock、UuidGenerator 等）位于 `apps/api`，不在核心包内。ErrorClassifier 可随核心包提供纯函数默认实现（无 I/O、无框架）。
- 测试策略：纯单元测试（`npm run test` 层，无 dev server、无框架容器），表驱动断言 16 类命中；禁用 import 静态检查作为架构守卫。

## Cross-Story Dependencies

- sk-1-1 无依赖，是 sk-1-2 与 sk-1-3 的前置（两者都依赖错误码与类型定义）。
- 本 epic 假设 `packages/core` 脚手架与 `npm run test` 运行器由 S1 冲刺的 monorepo 地基任务先行就位；若 dispatch sk-1-1 时尚不存在，dev-auto 应先完成地基。
- 下游 C2（AgentRuntime）、C7（Provider）消费 `ErrorClassifier`；本 epic 只交付类型与常量契约。
