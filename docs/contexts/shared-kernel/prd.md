---
title: 产品需求文档 (PRD) — SK 共享内核
context: SK · Shared Kernel
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：SK · 共享内核 (Shared Kernel)

> 产品简报见 [product-brief.md](./product-brief.md)，技术实现见 [architecture.md](./architecture.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 背景与目标

CodePilot Web 六边形重构中，SK 是最底层、被所有上下文依赖的共享内核。本 PRD 定义 SK 对外提供的 7 个端口应满足的功能需求（FR）、非功能需求（NFR）与验收标准（AC）。

**边界约束（硬）：** SK 不含任何业务领域逻辑，不知道会话、消息、Provider、Runtime 为何物。凡涉及这些概念的需求都不属于 SK——本文档只覆盖横切能力。

**核心目标：**
1. 把 16 类结构化错误、脱敏、平台检测、i18n 端口、运行时日志、Clock、IdGenerator 收敛为零框架、零业务依赖的核心包。
2. 以稳定端口接口对外暴露，供上层通过依赖倒置消费。
3. 保证同一横切语义跨所有上下文一致（错误分类、脱敏规则、翻译键）。

## 2. 功能需求 (Functional Requirements)

### FR-1 结构化错误分类 (ErrorClassifier)
- **FR-1.1** 系统必须定义 16 类结构化错误类型，每类有稳定错误码（`ErrorCode` 枚举）。
- **FR-1.2** ErrorClassifier 必须能把任意底层异常（`unknown`）映射为 16 类之一；无法识别时归入兜底类（如 `UNKNOWN`），不得抛出。
- **FR-1.3** 每个分类结果必须携带：错误码、可翻译消息键（`messageKey`）、是否可重试（`retryable`）、原始错误引用（`cause`）。
- **FR-1.4** 分类为纯函数语义：相同输入必然得到相同分类结果（无隐藏状态、无时间依赖）。
- **FR-1.5** 分类结果必须携带足以让上层做条件分支的稳定元信息，禁止上层再自行解析原始异常字符串。

### FR-2 平台检测 (Platform)
- **FR-2.1** Platform 端口必须提供只读的运行平台信息：操作系统类型（如 `darwin`/`win32`/`linux`）、CPU 架构、运行环境标识。
- **FR-2.2** Platform 只读、不可变；上层不得通过它修改任何环境状态。
- **FR-2.3** 平台信息在一次进程生命周期内稳定（不随调用变化）。

### FR-3 脱敏 Redactor
- **FR-3.1** Redactor 必须能对字符串与结构化对象做敏感信息脱敏，返回脱敏后的副本，不修改原对象。
- **FR-3.2** 内建规则集必须覆盖已知敏感模式：API Key、Bearer/token、绝对文件路径中的用户名段、邮箱、常见密钥前缀。
- **FR-3.3** 脱敏必须保留可读结构（用占位符如 `***REDACTED***` 替换，而非整体删除），便于排障。
- **FR-3.4** 脱敏规则集为 SK 单一事实来源；新增敏感模式只在此处扩展。

### FR-4 i18n 翻译端口 (TranslationPort)
- **FR-4.1** TranslationPort 必须按（消息键 + 语言 + 可选插值参数）返回文案。
- **FR-4.2** SK 只定义端口签名与自身产生的内建消息键清单（如 16 类错误的 `messageKey`）；具体文案表由适配器/各上下文提供。
- **FR-4.3** 缺失键时必须有确定行为：返回键名本身或标记缺失，不得抛出、不得返回空串静默。

### FR-5 运行时日志环形缓冲 (RuntimeLog)
- **FR-5.1** RuntimeLog 必须是有界环形缓冲：达到容量上限后淘汰最旧条目（FIFO 覆盖）。
- **FR-5.2** 每条日志必须携带时间戳（经 Clock 获取）、级别、来源标识、消息体。
- **FR-5.3** 写入 RuntimeLog 的消息体默认必须经 Redactor 脱敏。
- **FR-5.4** 必须支持导出当前缓冲快照（用于诊断），导出内容为脱敏后内容。

### FR-6 时钟 (Clock)
- **FR-6.1** Clock 端口必须提供获取当前时刻的方法（返回可比较的时间值）。
- **FR-6.2** 生产适配器返回系统真实时间；测试适配器可注入冻结/可推进的时钟。
- **FR-6.3** SK 内部及上层用例获取时间必须经 Clock，禁止直接调用 `Date.now()` / `new Date()`。

### FR-7 ID 生成 (IdGenerator)
- **FR-7.1** IdGenerator 端口必须提供生成唯一标识的方法。
- **FR-7.2** 生产适配器返回真实唯一 ID；测试适配器可注入确定性序列。
- **FR-7.3** SK 内部及上层用例生成 ID 必须经 IdGenerator，禁止直接调用随机/uuid 库。

## 3. 非功能需求 (Non-Functional Requirements)

### NFR-1 零框架 / 零业务依赖（架构铁律）
- `packages/core/shared-kernel/` 源码中禁止出现对具体框架/第三方实现的 import（`@nestjs/*`、`better-sqlite3`、`anthropic`、`uuid` 等）。
- SK 依赖端口清单为"无"，不得反向依赖任何 C1–C10。

### NFR-2 可测试性
- 所有涉及时间、ID、随机性的能力必须端口化，支持在单元测试中注入确定性替身。
- SK 全部逻辑可在无 dev server、无框架容器的纯 Node 测试环境下运行（对应 `npm run test` 层）。

### NFR-3 语义一致性
- 同一底层异常在任意上下文经 ErrorClassifier 得到的分类结果必须一致。
- 同一敏感模式在任意脱敏点必须被同样处理。

### NFR-4 安全 / 隐私
- 任何经 RuntimeLog / 错误上报路径的数据默认脱敏；新增日志点不得绕过 Redactor。
- Redactor 不得把敏感值写入自身日志或抛出的错误消息中。

### NFR-5 稳定性
- 端口接口一旦发布应保持稳定；破坏性变更需评估对全部 10 个下游上下文的影响。
- ErrorClassifier、Redactor、Platform 语义在进程内确定、无副作用。

### NFR-6 性能
- ErrorClassifier、Redactor 为高频调用路径（每条日志/每个错误），单次调用开销应为常数级、无 I/O、无阻塞。
- RuntimeLog 环形缓冲写入为 O(1)。

## 4. 验收标准 (Acceptance Criteria)

| # | 关联 FR/NFR | 验收标准 | 验证方式 |
|---|---|---|---|
| AC-1 | FR-1, NFR-3 | 16 类错误码全部定义；构造 16 个代表性底层异常，分类结果逐一命中预期类，且每类含 `messageKey`+`retryable` | 单元测试（表驱动） |
| AC-2 | FR-1.4 | 同一异常输入连续分类 100 次结果完全一致 | 单元测试 |
| AC-3 | FR-3.2 | 对含 API Key/token/绝对路径/邮箱的样本脱敏后，原始敏感值不出现在输出中 | 单元测试（反例断言：脱敏前后 diff） |
| AC-4 | FR-3.1 | 脱敏返回新副本，原对象不被修改 | 单元测试 |
| AC-5 | FR-4.3 | 请求一个不存在的 key 不抛异常，返回约定的缺失行为 | 单元测试 |
| AC-6 | FR-5.1 | 向容量为 N 的 RuntimeLog 写 N+K 条，缓冲仅保留最新 N 条 | 单元测试 |
| AC-7 | FR-5.3 | 向 RuntimeLog 写入含敏感值的消息，导出快照中敏感值已被脱敏 | 单元测试（反例断言） |
| AC-8 | FR-6.2 | 注入冻结 Clock 后，两次取时返回相同值 | 单元测试 |
| AC-9 | FR-7.2 | 注入确定性 IdGenerator 后，连续生成 ID 与预期序列一致 | 单元测试 |
| AC-10 | NFR-1 | 对 `shared-kernel/` 源码做 import 扫描，无禁用的框架/第三方实现 import | 静态检查 / lint 规则 |
| AC-11 | FR-2 | Platform 返回的 OS/架构值与实际运行环境一致且只读 | 单元测试 |
| AC-12 | NFR-3 | 试点上下文 C7 实际消费 ErrorClassifier，同一 Provider 探针异常在 C7 与 SK 直测得到一致分类 | 集成 smoke（反例：不同来源同异常） |

## 5. 依赖与假设

- **依赖端口：** 无（SK 是最底层）。
- **对外提供端口：** `ErrorClassifier`、`Platform`、`Redactor`、`TranslationPort`、`RuntimeLog`、`Clock`、`IdGenerator`（详见 architecture.md）。
- **假设：** 具体 i18n 文案表、真实脱敏正则库、系统时钟/UUID 实现均在适配器层提供，本 PRD 不约束其内部实现，仅约束端口契约。

## 6. 超出范围 (Out of Scope)

- 业务领域实体与用例（会话/消息/Provider/Runtime 等 → C1–C10）。
- i18n 文案内容本身、翻译工作流。
- 持久化 / 数据库（RuntimeLog 是内存环形缓冲，不落库）。
- 分布式 / 多租户场景（本机单用户单机）。
