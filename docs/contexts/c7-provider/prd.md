---
title: 需求文档 (PRD) — C7 ProviderManagement 提供商管理
context: C7 · ProviderManagement
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C7 · ProviderManagement（提供商管理）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C7 存在大量"用户可见的状态/能力支持/诊断结论"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能：

| 用户可见字段 | 语义（用户会怎么理解） | 真实来源 breadcrumb | 缺失来源时的降级 |
|---|---|---|---|
| Provider "已配置" 计数 | 用户配了几家提供商 | `ProviderRepository.listAll().length` | 无（永远可算） |
| "默认 Provider" | 新会话默认走哪家 | `ProviderRepository.getDefaultId()` → 命中记录 | 指向已删除记录时显示 `error: default-missing`，不显示假名字 |
| "生效认证风格" | 实际请求用 Bearer 还是 x-api-key | `AuthResolver.resolve().authStyle` | 无法判定时标 `ambiguous` + warn，不猜 |
| "有可用凭据" | 这家现在能用吗 | `AuthResolver.resolve().hasCredentials` | 无凭据显 false，不显假 true |
| 探针 severity | ok/warn/error | `Probe.run()` 实测结果 | 探针跳过时显 `skipped`，不显 ok |
| Live 探针结论 | 模型真的回话了吗 | `LiveProbeRunner.run()` 真实 spawn 结果 | 无 CLI/无凭据时显 `skipped`，不伪造 passed |
| 修复动作可用性 | 这条问题能不能一键修 | `finding.repairActions`（由 finding.code 反查 REPAIR_ACTIONS + 上下文参数） | 缺参数（如无 Provider 可设默认）时不挂按钮 |
| 错误分类 code | 是网络还是认证还是限流问题 | `SK.ErrorClassifier.classify()` 的 `ClassifiedError.code` | 无法归类归 `UNKNOWN`，不硬套 |

**原则**：没有真实来源的字段一律隐藏 / 标 unsupported / 明确写"估算"；禁止假 0、placeholder、伪 passed。

## 1. 功能需求 (Functional Requirements)

### FR-1 Provider 配置管理（`ConfigureProviderUseCase`）
- FR-1.1 支持 Provider 的创建、读取、更新、删除、列表，字段对齐 `api_providers` 表（id/name/provider_type/preset_key/protocol/base_url/api_key/is_active/sort_order/extra_env/headers_json/env_overrides_json/role_models_json/options_json/notes）。
- FR-1.2 支持设置默认 Provider（单选）与切换启用态（`is_active`，同一时刻至多一个 active）。
- FR-1.3 支持排序（`sort_order`）。
- FR-1.4 **写路径校验（fail-closed）**：创建/更新时拒绝已知非法态，至少覆盖：
  - anthropic 协议 + 空 base_url + 非官方（第三方）→ 拒绝或强制显式选择（防 `provider.anthropic-empty-base-url` 静默代理）。
  - `env_overrides_json`/`extra_env` 同时含 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` → 拒绝（防 `auth.style-mismatch`）。
  - 非法 JSON 字段 → 拒绝并给出可读错误。
- FR-1.5 API Key 等敏感字段在返回给前端 / 写日志前必须经 `SK.Redactor` 脱敏（仅暴露 `exists` + `last4`）。

### FR-2 诊断（`DiagnoseUseCase.runDiagnosis`）— 5 探针
秒级、无副作用（除 network 的 HEAD 请求）的配置时诊断，聚合 5 个探针：
- FR-2.1 **CLI 探针**：检测 Claude CLI 二进制存在性、版本、多安装冲突；Windows 额外检测 Git Bash。
- FR-2.2 **Auth 探针**：检测环境变量 / DB 凭据 / Provider Key / OAuth（OpenAI/xAI）；报告 both-styles-set、style-mismatch、no-credentials、resolved-no-creds 等。
- FR-2.3 **Provider 探针**：Provider 计数、默认设置态、default-missing、missing-base-url、anthropic-empty-base-url、no-models、no-explicit-model、sdk-proxy-only、resolve 路径。
- FR-2.4 **Features 探针**：thinking / 1M context 与当前协议的兼容性；stale sdk_session_id 检测。
- FR-2.5 **Network 探针**：对生效的 base URL 做 HEAD 探测（不发凭据），报告 reachable / timeout / unreachable / invalid-url。
- FR-2.6 每个探针产出 `ProbeResult{ probe, severity, findings[], durationMs }`；`severity = max(findings.severity)`；诊断 `overallSeverity = max(probes.severity)`。
- FR-2.7 诊断结果可缓存（`lastDiagnosisResult`），供导出复用，不重复跑。

### FR-3 Live 深度探针（`DiagnoseUseCase.runLiveProbe`）— 独立于 5 探针
- FR-3.1 真实 spawn 一次最小 Claude Code 调用（`maxTurns:1`，`prompt:'Say OK'`），验证运行时真的能用。
- FR-3.2 超时（默认 15s）→ `live.timeout`（warn）；无 CLI / 无凭据 / 无法解析 → `live.skipped`（不伪造 passed）。
- FR-3.3 失败异常经 `SK.ErrorClassifier` 分类为 `ClassifiedError`，finding 里带 `code` + 人话消息 + action hint；stderr 截断（末 500 字符）并脱敏。
- FR-3.4 Live 探针**不**进入默认 `runDiagnosis`（避免 15s 阻塞 UI），仅按需触发。

### FR-4 Auth 解析（`AuthResolver` / 经 `ConfigureProviderUseCase` 暴露只读）
- FR-4.1 输入 Provider 配置 + 环境变量，输出 `{ provider?, protocol, model?, authStyle, hasCredentials }`。
- FR-4.2 `authStyle ∈ { 'api_key' | 'auth_token' | 'ambiguous' }`；以 preset 目录为单一真相源，legacy 记录回退到 extra_env 推断。
- FR-4.3 默认 Provider 指向已删除记录时，解析回退环境变量并明确标记（供 Provider 探针报 default-missing）。
- FR-4.4 解析纯函数化（相同输入相同输出），I/O（读环境/OAuth 状态）经出站端口注入。

### FR-5 修复动作（`DiagnoseUseCase.listRepairs` / `applyRepair`）
- FR-5.1 支持 5 类修复动作：`set-default-provider`、`apply-provider-to-session`、`clear-stale-resume`、`switch-auth-style`、`reimport-env-config`。
- FR-5.2 每条非 ok finding 按其 `code` 反查可用修复动作并附加执行参数（如 `providerId`、`authStyle`）；缺必要参数则不挂该动作。
- FR-5.3 `applyRepair(actionType, params)` 执行修复并返回结果；修复后调用方可重跑诊断验证。
- FR-5.4 修复动作对状态的改动必须经 `ProviderRepository` / 设置出站端口，核心不直接写 DB。

### FR-6 对 C2 的消费契约（`ProviderRepository`）
- FR-6.1 `ProviderRepository` 是 C7 的出站持久化端口，也是 C2 读取 Provider 配置的唯一入口。
- FR-6.2 C2 只读消费；对 Provider 的写操作必须回到 C7 的 `ConfigureProviderUseCase`，不得由 C2 直接改。
- FR-6.3 提供 `getById` / `getDefault` / `listAll` / `listModelGroups` 等只读投影，凭据字段的暴露策略由 C7 决定（C2 拿到解析结果而非明文散落）。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/provider-management/` 禁止 import `@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`process`/`os`/`fs` 的直接用法；全部经出站端口注入。
- NFR-2 **性能**：`runDiagnosis`（5 探针并发）P95 < 2s（network 探针单 URL 超时 5s，整体并发）；Live 探针独立、可 15s。
- NFR-3 **脱敏**：任何离开 C7 的路径（HTTP 响应、日志、诊断导出）中 API Key/Token/绝对路径用户名段必须经 `SK.Redactor`。
- NFR-4 **错误统一**：所有对外异常语义经 `SK.ErrorClassifier` 归类，UI 拿 `ErrorCode` 而非裸 message。
- NFR-5 **i18n**：诊断 finding 文案经 `SK.TranslationPort`，C7 只贡献自己的 message keys（`c7.*`）。
- NFR-6 **可测**：探针与解析均可用假出站端口（内存 Provider、FakePlatform、FakeLiveRunner）做纯单元测试，无需真实 CLI / 网络。
- NFR-7 **可观测**：诊断/修复关键路径经 `SK.RuntimeLog` 记（脱敏后）source=`c7.doctor` / `c7.repair`。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.1）Provider CRUD 全通，字段与 `api_providers` 一致，往返读写不丢字段。
- AC-2（FR-1.4）写路径反例：提交 anthropic+空 base_url+第三方 → 被拒并给可读原因；提交双 auth 风格 → 被拒。
- AC-3（FR-1.5）返回体/日志中 api_key 仅见 `{exists:true,last4:'xxxx'}`，明文不出现（脱敏反例断言）。
- AC-4（FR-2.6）构造已知问题态（默认指向已删除记录），`runDiagnosis` 的 provider 探针含 `provider.default-missing`(error)，`overallSeverity=error`。
- AC-5（FR-2）**反例 smoke**：健康配置 → 全 ok / overallSeverity=ok；注入 both-styles-set → auth 探针 warn。两条路径结果必须不同。
- AC-6（FR-3.2）无 CLI 环境跑 Live 探针 → `live.skipped`，**断言不出现 `live.passed`**（禁伪造）。
- AC-7（FR-3.3）Live 探针注入网络异常 → finding.code 来自 `SK.ErrorClassifier`（如 `NETWORK`/`TIMEOUT`），非裸字符串。
- AC-8（FR-4.2）preset=auth_token 的 Provider 解析出 `authStyle='auth_token'`；同时含两种 env → `ambiguous`。
- AC-9（FR-5.2/5.3）对 `provider.default-missing` finding 挂 `set-default-provider`(带 providerId)，`applyRepair` 后重跑诊断该 finding 消失（修复有效性反例）。
- AC-10（FR-5.2）无任何 Provider 时，`set-default-provider` 因缺 providerId **不**挂到 finding 上（缺参不挂）。
- AC-11（NFR-1）对 `provider-management/` 核心包做禁用 import 静态扫描，0 命中。
- AC-12（S4 / 对齐 SK AC-12）同一 Provider 的同类异常，network 探针与 live 探针经 `SK.ErrorClassifier` 得到相同 `ErrorCode`（跨来源一致性）。
- AC-13（FR-6.2）C2 侧对 Provider 的写尝试无对应端口（编译期不可达），只能读；文档与类型层面可验证。

## 4. 依赖与假设

- 依赖 SK 已交付：`ErrorClassifier` / `Redactor` / `RuntimeLog` / `Clock` / `TranslationPort` 端口稳定（见 SK architecture 第 4 节）。
- 假设 C1（会话）提供 stale sdk_session_id 的读取投影，或 C7 通过出站端口只读探测该字段（Features 探针需要）；跨界只读，不写会话。
- 假设 OAuth 状态（OpenAI/xAI）由适配器层出站端口提供，核心不 import OAuth 管理器。
</content>
