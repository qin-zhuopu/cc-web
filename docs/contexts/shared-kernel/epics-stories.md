---
title: 史诗与故事 — SK 共享内核
context: SK · Shared Kernel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：SK · 共享内核 (Shared Kernel)

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。

## 概览

SK 是绞杀者迁移的第一站，无上游依赖。本文件把 SK 的交付拆成 4 个史诗、共 12 个用户故事，可直接排期。故事验收标准全部回引 PRD 的 AC 编号，确保可追溯。

**交付顺序建议：** E1（错误+领域类型）→ E2（时钟/ID/平台基础端口）→ E3（脱敏+日志）→ E4（i18n 端口 + 接线 + 试点验证）。E1/E2 是其余上下文最先需要的地基，优先交付。

---

## Epic 1 · 结构化错误分类

**目标：** 把 16 类结构化错误与分类能力落成核心包的稳定契约，让 C2/C7 能统一消费。
**价值：** 消除错误语义漂移，UI 错误提示跨 Runtime/Provider 一致。

### Story 1.1 — 定义 16 类错误码与领域类型
- **作为** 核心包开发者，**我要** 一套稳定的 `ErrorCode` 枚举与 `ClassifiedError` 值对象，**以便** 全项目对错误有单一事实来源。
- **验收：**
  - `ErrorCode` 含 architecture.md 第 3.1 节列出的全部 16 类。
  - `ClassifiedError` 含 `code`/`messageKey`/`retryable`/`cause?`/`detail?` 字段（AC-1）。
  - 类型定义位于 `domain/error/`，无框架 import（AC-10）。
- **依赖：** 无。

### Story 1.2 — 实现 ErrorClassifier 分类逻辑
- **作为** 上层用例，**我要** `classify(error: unknown): ClassifiedError`，**以便** 把任意异常映射为结构化错误。
- **验收：**
  - 16 个代表性异常样本逐一命中预期类（AC-1）。
  - 无法识别归 `UNKNOWN`，永不抛出（FR-1.2）。
  - 相同输入连续分类结果一致（AC-2）。
  - `retryable` 对 NETWORK/TIMEOUT/RATE_LIMIT/UNAVAILABLE 为 true。
- **依赖：** Story 1.1。

### Story 1.3 — 定义 SK i18n 消息键常量
- **作为** i18n 适配器，**我要** `SK_MESSAGE_KEYS` 常量表，**以便** 为 16 类错误提供文案入口。
- **验收：**
  - 每个 `ErrorCode` 对应唯一 `sk.error.*` 键（architecture.md 3.3）。
  - 键为常量、只读。
- **依赖：** Story 1.1。

---

## Epic 2 · 确定性基础端口（Clock / IdGenerator / Platform）

**目标：** 端口化时间、ID、平台探测，支撑上层用例的确定性测试。
**价值：** 上层可注入替身做纯逻辑测试，禁止散落的 `Date.now()`/uuid 直调。

### Story 2.1 — Clock 端口
- **作为** 上层用例，**我要** `Clock.now(): number`，**以便** 获取时间且测试可冻结。
- **验收：**
  - 端口定义于 `ports/clock.ts`。
  - 提供生产语义说明（`SystemClock`）与测试语义（冻结时钟两次取值相同，AC-8）。
- **依赖：** 无。

### Story 2.2 — IdGenerator 端口
- **作为** 上层用例，**我要** `IdGenerator.next(): string`，**以便** 生成唯一 ID 且测试可确定。
- **验收：**
  - 端口定义于 `ports/id-generator.ts`。
  - 测试注入确定性序列后生成结果与预期一致（AC-9）。
- **依赖：** 无。

### Story 2.3 — Platform 端口
- **作为** 上层用例，**我要** `Platform.info(): PlatformInfo`，**以便** 只读获取 OS/架构/运行环境。
- **验收：**
  - `PlatformInfo` 含 `os`/`arch`/`runtime`，只读（FR-2.2）。
  - 返回值与实际运行环境一致，进程内稳定（AC-11）。
- **依赖：** 无。

---

## Epic 3 · 脱敏与运行时日志

**目标：** 集中脱敏规则，运行时日志有界环形缓冲且默认脱敏。
**价值：** 消除敏感信息泄漏面，任何日志点经统一过滤。

### Story 3.1 — Redactor 端口与内建规则契约
- **作为** 任意日志/上报点，**我要** `redactString` / `redact<T>`，**以便** 脱敏字符串与结构。
- **验收：**
  - 覆盖 API Key/token/绝对路径用户名段/邮箱/密钥前缀（AC-3）。
  - 返回新副本，原对象不变（AC-4）。
  - 占位符 `***REDACTED***`，保留可读结构（FR-3.3）。
  - 反例 smoke：脱敏后原始敏感值不出现在输出（AC-3）。
- **依赖：** 无。

### Story 3.2 — RuntimeLog 环形缓冲端口
- **作为** 诊断场景，**我要** 有界 `RuntimeLog`，**以便** 保留最近 N 条运行时日志并可导出。
- **验收：**
  - 写 N+K 条仅保留最新 N 条（AC-6）。
  - `LogEntry` 含 timestamp（来自 Clock）/level/source/message/meta。
  - 写入 O(1)（NFR-6）。
- **依赖：** Story 2.1（Clock）、Story 3.1（Redactor）。

### Story 3.3 — RuntimeLog 写入自动脱敏
- **作为** 安全负责人，**我要** `append` 写入的 message/meta 自动经 Redactor，**以便** 导出快照不含敏感值。
- **验收：**
  - 写入含敏感值消息，`snapshot()` 中敏感值已脱敏（AC-7，反例断言）。
  - 无绕过 Redactor 的写入路径（NFR-4）。
- **依赖：** Story 3.1、Story 3.2。

---

## Epic 4 · i18n 端口、DI 接线与试点验证

**目标：** 完成 TranslationPort 端口，装配 `SharedKernelModule`，并由试点上下文 C7 实测消费。
**价值：** 打通 SK 到上层的注入链路，验证分层铁律与语义一致性。

### Story 4.1 — TranslationPort 端口
- **作为** 上层用例，**我要** `translate(key, locale, params?)` / `has(key, locale)`，**以便** 按键出文案。
- **验收：**
  - 缺失键返回键名本身，不抛、不返回空串（AC-5）。
  - 支持插值参数（FR-4.1）。
  - SK 仅贡献 `SK_MESSAGE_KEYS`，文案表由适配器提供（FR-4.2）。
- **依赖：** Story 1.3。

### Story 4.2 — SharedKernelModule 依赖注入接线
- **作为** 其余上下文的 Module，**我要** 一个可 `imports` 的 `SharedKernelModule`，**以便** 注入全部 7 个端口。
- **验收：**
  - 7 个端口 token 全部绑定到适配器实现并导出（architecture.md 第 5 节）。
  - 核心包内无框架 import；框架绑定只在 `apps/api` 适配器层（AC-10）。
- **依赖：** E1–E4 各端口定义 + 对应适配器。

### Story 4.3 — 禁用 import 静态检查守卫
- **作为** 架构守门人，**我要** 一条 lint/静态规则扫描 `shared-kernel/`，**以便** 防止框架/第三方实现 import 混入核心。
- **验收：**
  - 扫描 `@nestjs/*`/`better-sqlite3`/`anthropic`/`uuid` 等，命中即失败（AC-10、NFR-1）。
  - 规则纳入 `npm run test` 层门禁。
- **依赖：** Story 4.2。

### Story 4.4 — 试点 C7 消费 ErrorClassifier 验证
- **作为** 重构负责人，**我要** 试点上下文 C7 实际注入并消费 `ErrorClassifier`，**以便** 验证跨来源分类一致性。
- **验收：**
  - 同一 Provider 探针异常在 C7 与 SK 直测得到一致 `ClassifiedError`（AC-12，反例：不同来源同异常）。
  - 验证结果写入 SK 交付的 Smoke Ledger。
- **依赖：** Story 1.2、Story 4.2。

---

## 追溯矩阵（Story → PRD AC）

| Story | 覆盖 AC |
|---|---|
| 1.1 | AC-1, AC-10 |
| 1.2 | AC-1, AC-2 |
| 1.3 | FR-4.2 |
| 2.1 | AC-8 |
| 2.2 | AC-9 |
| 2.3 | AC-11 |
| 3.1 | AC-3, AC-4 |
| 3.2 | AC-6 |
| 3.3 | AC-7 |
| 4.1 | AC-5 |
| 4.2 | AC-10 |
| 4.3 | AC-10 |
| 4.4 | AC-12 |

## 排期建议

- **Sprint 1：** E1（1.1→1.2→1.3）+ E2（2.1/2.2/2.3 可并行）——地基，其余上下文最先依赖。
- **Sprint 2：** E3（3.1→3.2→3.3）+ E4（4.1）。
- **Sprint 3：** E4（4.2→4.3→4.4）——接线与试点验证，产出 Smoke Ledger 收尾。
