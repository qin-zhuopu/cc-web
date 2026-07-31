---
title: 史诗与故事 — C7 ProviderManagement 提供商管理
context: C7 · ProviderManagement
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C7 · ProviderManagement（提供商管理）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C7 核心包（domain + ports），零框架 | FR-1~6 的类型基础、NFR-1 |
| E2 Provider 配置管理 | CRUD + 默认/启用/排序 + 写路径校验 + 脱敏 | FR-1 |
| E3 Auth 解析 | 纯函数解析 authStyle / hasCredentials | FR-4 |
| E4 5 探针诊断 | cli/auth/provider/features/network 并发诊断 | FR-2 |
| E5 Live 深度探针 | 真实 spawn 探测 + 错误分类隔离 | FR-3 |
| E6 修复动作 | 5 类修复的建议与执行闭环 | FR-5 |
| E7 NestJS 接线与 C2 消费契约 | Module/Controller/适配器 + Repository 供 C2 只读 | FR-6、DI |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 Provider 实体 + Protocol/AuthStyle/RoleModels 值对象（对齐 `api_providers` 字段）。**AC**：类型往返编解码不丢字段。（FR-1.1）
- **S1.2** 定义诊断值对象：Severity(含 skipped)/Finding/ProbeResult/DiagnosisResult/RepairAction。**AC**：`maxSeverity` 单测覆盖 skipped 不拉高整体。（FR-2.6）
- **S1.3** 定义 finding-code 常量表与 C7 message-keys（`c7.*`）。**AC**：所有探针 finding 引用常量，无裸字符串。（NFR-5）
- **S1.4** 定义驱动端口（ConfigureProviderUseCase / DiagnoseUseCase）与出站端口（ProviderRepository / SettingsPort / PlatformProbePort / NetworkProbePort / LiveProbeRunner / OAuthStatusPort）接口。**AC**：核心包 `index.ts` 只导出端口与领域类型。
- **S1.5** 建立禁用 import 静态扫描。**AC-11**：`provider-management/` 对 `@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*` 0 命中。（NFR-1）

## E2 · Provider 配置管理

- **S2.1** 实现 `ConfigureProviderService.list/getById`（默认脱敏 apiKey）。**AC-3**：返回体 apiKey 仅见 `{exists,last4}`。（FR-1.1/1.5）
- **S2.2** 实现 create/update/remove，经 `ProviderRepository` 持久化。**AC-1**：CRUD 往返一致。（FR-1.1）
- **S2.3** 实现 setDefault/setActive/reorder。**AC**：同一时刻至多一个 active；默认单选。（FR-1.2/1.3）
- **S2.4** 写路径校验（fail-closed）：拒绝 anthropic+空 base_url+第三方、双 auth 风格、非法 JSON。**AC-2**：非法态被拒 + 可读原因（`INVALID_REQUEST`）。（FR-1.4）

## E3 · Auth 解析

- **S3.1** 实现 `AuthResolver.resolve`（纯函数）：provider/default → env 回退 → oauth-only 标记。**AC-8**：preset=auth_token → `authStyle='auth_token'`。（FR-4.1/4.2）
- **S3.2** 双 auth 风格判定 `ambiguous`；默认指向已删记录时回退 env 并标记。**AC**：ambiguous 与 default-missing 两条反例断言。（FR-4.2/4.3）
- **S3.3** 经 `ConfigureProviderUseCase.resolveAuth` 暴露只读结果给 UI，带 source breadcrumb。**AC**：UI 字段可追到 `resolve().source`。（FR-4、反假数据）

## E4 · 5 探针诊断

- **S4.1** CLI 探针（binary/version/多安装/Windows Git Bash），经 `PlatformProbePort`。**AC**：无 binary → `cli.not-found`(error)。（FR-2.1）
- **S4.2** Auth 探针（env/DB/provider key/OAuth/both-styles/style-mismatch/no-credentials）。**AC-5**：注入 both-styles-set → warn。（FR-2.2）
- **S4.3** Provider 探针（count/default-missing/missing-base-url/anthropic-empty-base-url/no-models/no-explicit-model/sdk-proxy-only/resolve）。**AC-4**：默认指向已删记录 → `provider.default-missing`(error)。（FR-2.3）
- **S4.4** Features 探针（thinking/1M 与协议兼容、stale sdk_session_id 只读探测）。**AC**：非 anthropic 开 thinking → `features.thinking-unsupported`(warn)。（FR-2.4）
- **S4.5** Network 探针（HEAD 探测，经 `NetworkProbePort`，不发凭据）。**AC**：不可达 URL → `network.unreachable`(warn)。（FR-2.5）
- **S4.6** `DiagnoseService.runDiagnosis` 并发聚合 + severity + 缓存。**AC-5**：健康态全 ok vs 问题态两条路径结果不同（反例 smoke）。（FR-2.6/2.7）

## E5 · Live 深度探针

- **S5.1** 定义 `LiveProbeRunner` 适配器契约（真实 spawn `Say OK`，maxTurns:1，15s 超时，stderr 末 500 截断）。（FR-3.1）
- **S5.2** `live-probe` 用例：skipped（无 CLI/无凭据/无法解析）/ timeout / empty / passed / failed 分支。**AC-6**：无 CLI 环境断言 `live.skipped`，**不出现 `live.passed`**（禁伪造）。（FR-3.2）
- **S5.3** failed 分支经 `SK.ErrorClassifier` 分类，finding 带 `errorCode` + action hint；stderr 经 `SK.Redactor`。**AC-7**：注入网络异常 → `errorCode` 来自 SK（如 `NETWORK`/`TIMEOUT`）。（FR-3.3）
- **S5.4** Live 探针独立触发，不进 `runDiagnosis`。**AC**：`runDiagnosis` 的 probes 不含 `live`。（FR-3.4）

## E6 · 修复动作

- **S6.1** 定义 REPAIR_ACTIONS 表（5 类）与 finding.code → action 反查。（FR-5.1）
- **S6.2** `attachRepairsToFindings`：按 code 挂动作并填参（providerId/authStyle）。**AC-10**：无 Provider 时 `set-default-provider` 因缺参不挂。（FR-5.2）
- **S6.3** `applyRepair` 分派执行（经 Repository/SettingsPort），返回结论 key。（FR-5.3/5.4）
- **S6.4** 修复有效性回归。**AC-9**：对 `provider.default-missing` 一键修复后重跑诊断该 finding 消失。（反例 smoke）

## E7 · NestJS 接线与 C2 消费契约

- **S7.1** `ProviderManagementModule`：imports SharedKernelModule，provides/exports 全部端口，接线适配器。（DI 章节）
- **S7.2** `ProviderController`（REST）+ `DiagnoseController`（诊断/live/last/repair）。**AC**：敏感字段响应脱敏。
- **S7.3** 适配器实现：`SqliteProviderRepository`/`SqliteSettingsAdapter`/`NodePlatformProbe`/`FetchNetworkProbe`/`ClaudeSdkLiveProbe`/`OAuthStatusAdapter`。
- **S7.4** C2 消费契约：C2 `imports` 本 Module 后**只读**注入 `ProviderRepository`；写回 `ConfigureProviderUseCase`。**AC-13**：C2 侧无 Provider 写端口（编译期不可达）。（FR-6）
- **S7.5** 分类一致性集成 smoke。**AC-12**：同一异常经 network/live 探针得同一 `ErrorCode`。（对齐 SK AC-12）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S2.2 |
| AC-2 | S2.4 |
| AC-3 | S2.1 |
| AC-4 | S4.3 |
| AC-5 | S4.2, S4.6 |
| AC-6 | S5.2 |
| AC-7 | S5.3 |
| AC-8 | S3.1 |
| AC-9 | S6.4 |
| AC-10 | S6.2 |
| AC-11 | S1.5 |
| AC-12 | S7.5 |
| AC-13 | S7.4 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + 配置）**：E1 全部、E2 全部、E3 全部。产出可 CRUD + 解析的 C7 核心 + 单测。
- **Sprint 2（诊断）**：E4 全部、E6 全部。产出 5 探针 + 修复闭环，反例 smoke 通过。
- **Sprint 3（Live + 接线）**：E5 全部、E7 全部。产出 NestJS Module/Controller/适配器 + C2 消费契约 + 分类一致性 smoke。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，无需真实 CLI/网络，用假出站端口）。
- 禁用 import 静态扫描 0 命中（AC-11）。
- 脱敏反例断言通过（AC-3）；无伪 passed（AC-6）。
- C2 消费契约文档与类型对齐（AC-13）；`ProviderRepository → C2` 引用图闭合。
</content>
