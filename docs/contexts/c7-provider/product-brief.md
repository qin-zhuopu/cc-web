---
title: 产品简报 — C7 ProviderManagement 提供商管理
context: C7 · ProviderManagement
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C7 · ProviderManagement（提供商管理）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 一句话定位

C7 是 CodePilot Web 里**管理"AI 提供商配置"并**对配置健康度做**结构化诊断**的限界上下文。它让单机用户在浏览器里增删改查 Provider、解析出可用的认证方式、一键跑诊断并按建议修复——但它**自己从不发起 AI 对话**（那是 C2 的职责，C2 消费 C7 产出的 Provider 配置）。

## 2. 解决什么问题

现有 Electron 版 CodePilot 的痛点集中在"配置对不对、能不能用"这条链路：

- **配置正确但用不了**：默认 Provider 指向已删除记录，解析器静默回退到环境变量，用户以为在用配置的 Provider，实际走的是环境变量（`provider.default-missing`）。
- **认证风格歧义**：同时设置 `ANTHROPIC_API_KEY`（走 `x-api-key`）和 `ANTHROPIC_AUTH_TOKEN`（走 `Bearer`），产生 header 冲突，用户不知道生效的是哪个（`auth.both-styles-set` / `auth.style-mismatch`）。
- **第三方端点模型名不匹配**：第三方 Anthropic 兼容端点仍用 `sonnet/opus/haiku` 默认模型名，上游不认（`provider.no-explicit-model`）。
- **空 base_url 的静默代理**：Anthropic 协议 Provider 留空 base_url 会静默代理到官方端点并继承一方能力，几乎不是第三方配置的本意（`provider.anthropic-empty-base-url`）。
- **能力开关与协议不匹配**：thinking / 1M context 只在 Anthropic 原生 API 生效，开在其他协议上无声失败（`features.thinking-unsupported` / `features.context1m-unsupported`）。
- **诊断结果散、无法行动**：诊断只报错不给修复动作，用户拿到 finding 不知道下一步做什么。

C7 把这些做成**可观测（诊断） + 可行动（修复动作）**的闭环，并给出稳定的错误分类（复用 SK.ErrorClassifier），使 UI 数字/状态的语义可追溯、不误导。

## 3. 目标用户与价值

- **单机开发者用户**：在 Settings → Providers 里配置多家提供商，切换默认 Provider，出问题时点"诊断"看到人话解释 + "Fix"按钮，不用读源码。
- **接入 C7 的其他上下文（主要是 C2）**：通过 `ProviderRepository` 拿到解析后的 Provider 配置与认证，无需理解 C7 内部的诊断/修复逻辑。

价值主张：**把"配置能不能用"从玄学变成一次可点击的诊断，并把每条问题绑定到可执行的修复动作。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C7 契约：

- **拥有**：
  - Provider 配置（增删改查、默认 Provider 选择、排序、启用态）
  - 5 探针诊断（CLI / Auth / Provider / Features / Network）+ 独立的 Live 深度探针
  - Auth 解析（把 Provider 配置 + 环境变量解析成"生效的认证风格与可用凭据"）
  - 每条 finding 的修复动作建议与执行（set-default / apply-to-session / clear-stale-resume / switch-auth-style / reimport-env）
- **不包含**：
  - AI 调用本身、流式、多 Runtime 编排 —— 属 C2。C7 只产出配置，C2 消费。
  - 会话/消息实体 —— 属 C1。
  - MCP/Skill —— 属 C9。
- **依赖端口（只引用，不重写）**：
  - `SK.ErrorClassifier` —— 把 Live 探针/网络探针的异常统一分类为结构化 `ClassifiedError`。
  - （横切）`SK.Redactor` / `SK.RuntimeLog` / `SK.Clock` / `SK.TranslationPort` —— 脱敏、日志、时间、诊断文案 i18n。
- **对外提供端口**：
  - `ConfigureProviderUseCase` —— Provider CRUD + 默认选择 + 启用切换。
  - `DiagnoseUseCase` —— 跑诊断、给修复动作、执行修复。
  - `ProviderRepository` —— 出站持久化端口，同时是 C2 消费 Provider 配置的读取入口。

## 5. 与 CodePilot 现有实现的对应

| C7 概念 | 现有落点 |
|---|---|
| Provider 配置 CRUD | `api_providers` 表、`getAllProviders/getProvider/createProvider/updateProvider/deleteProvider` |
| 5 探针诊断 | `provider-doctor.ts`：`runCliProbe` / `runAuthProbe` / `runProviderProbe` / `runFeaturesProbe` / `runNetworkProbe` |
| Live 深度探针 | `provider-doctor.ts`：`runLiveProbe`（真实 spawn，15s，独立于 5 探针） |
| Auth 解析 | `provider-resolver.ts`：`resolveProvider` / `resolveForClaudeCode`（authStyle / hasCredentials） |
| 修复动作 | `provider-doctor.ts`：`REPAIR_ACTIONS`（5 类） |
| 错误分类 | 现 `error-classifier.ts` → 重构后统一走 `SK.ErrorClassifier` |

> 现有 `provider-doctor.ts` 有 6 个探针函数，其中 5 个（cli/auth/provider/features/network）是**秒级、配置时**探针，构成契约里的"5 探针诊断"；`live` 探针是**十几秒、真实调用**的深度探针，作为按需独立能力（`DiagnoseUseCase.runLiveProbe`），不计入默认 5 探针集合。此约定在 PRD FR-2 与架构文档里明确写出，避免"5 vs 6"语义歧义。

## 6. 成功标准（可度量）

- **S1 配置闭环**：用户能在 SPA 里完成 Provider 增删改查、设默认、切启用，全部经 `ConfigureProviderUseCase`，写路径拒绝已知非法态（空 base_url 的 anthropic 第三方等）。
- **S2 诊断可行动**：5 探针诊断在秒级返回，每条非 ok finding 至少能追到来源探针，且可修复项挂上对应修复动作。
- **S3 修复有效**：对 `provider.default-missing`、`auth.style-mismatch`、`features.stale-session-id` 三类高发问题，一键修复后重跑诊断该 finding 消失（反例 smoke 断言）。
- **S4 分类一致**：同一 Provider 的同类异常，无论来自 network 探针还是 live 探针，经 `SK.ErrorClassifier` 得到相同 `ErrorCode`（跨来源一致性，对齐 SK AC-12 试点）。
- **S5 边界纯净**：C7 核心包不 import Claude SDK / better-sqlite3 / NestJS；不出现会话/消息/MCP 概念。

## 7. 非目标（明确排除）

- 不做 AI 对话、不做流式、不做 Runtime 切换（C2）。
- 不做多租户/远程认证（单机 `~/.codepilot/`）。
- 不替 SK 重新实现错误分类/脱敏/日志/时钟。
- 不做 Provider 的计费/额度可视化（超出诊断范畴，若需另立需求）。

## 8. 关键风险与假设

- **假设**：C2 只通过 `ProviderRepository`（+ 解析结果）消费 Provider，不反向依赖 C7 的诊断/修复。
- **风险**：Live 探针要真实 spawn CLI，属 C7 里唯一有重 I/O 副作用的路径；须经出站端口（`LiveProbeRunner`）隔离，核心不直接依赖 SDK。
- **风险**：Auth 解析的"生效风格"语义容易与 UI 显示脱节；必须给每个用户可见字段写 source breadcrumb（见 PRD 反假数据条款）。
</content>
</invoke>
