---
title: 架构 — C7 ProviderManagement 提供商管理
context: C7 · ProviderManagement
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C7 · ProviderManagement（提供商管理）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS ProviderController / DiagnoseController (HTTP/SSE)
               ↓ 调用驱动端口
        [驱动端口] ConfigureProviderUseCase / DiagnoseUseCase
               ↓
        [应用核心] Domain Model + Use Cases（纯逻辑，零框架）
               ↓ 依赖倒置，只依赖接口
        [出站端口] ProviderRepository / SettingsPort / PlatformProbePort
                   / NetworkProbePort / LiveProbeRunner / OAuthStatusPort
               +   SK: ErrorClassifier / Redactor / RuntimeLog / Clock / TranslationPort
               ↓ 由适配器实现
        [被驱动适配器] SqliteProviderRepository / NodePlatformProbe
                       / FetchNetworkProbe / ClaudeSdkLiveProbe / OAuthAdapter
```

依赖方向永远指向核心。C7 核心**只依赖 SK 端口与 C7 自己的出站端口接口**，绝不 import 框架/SDK/DB。C2 是 C7 的**下游消费者**（读 `ProviderRepository`），不是 C7 的依赖。

## 2. 目录结构

```
packages/core/provider-management/
├── domain/
│   ├── provider/
│   │   ├── provider.ts              # Provider 实体 + ProviderId 值对象
│   │   ├── protocol.ts              # Protocol 枚举 + 分类谓词
│   │   ├── auth-style.ts            # AuthStyle 值对象
│   │   └── model-role.ts            # RoleModels 值对象（default/reasoning/small/...）
│   ├── diagnosis/
│   │   ├── severity.ts              # Severity 值对象 + maxSeverity
│   │   ├── finding.ts               # Finding / ProbeResult / DiagnosisResult 值对象
│   │   ├── finding-code.ts          # C7 稳定 finding code 常量（cli.* / auth.* / ...）
│   │   └── repair-action.ts         # RepairAction / RepairActionType 值对象
│   ├── auth/
│   │   └── resolved-provider.ts     # ResolvedProvider 值对象（解析结果）
│   └── message-keys.ts              # C7 自身 i18n 键（c7.*）
├── ports/
│   ├── driving/
│   │   ├── configure-provider-usecase.ts   # ConfigureProviderUseCase 端口
│   │   └── diagnose-usecase.ts              # DiagnoseUseCase 端口
│   └── driven/
│       ├── provider-repository.ts   # ProviderRepository 出站端口（C2 消费入口）
│       ├── settings-port.ts         # SettingsPort（默认 provider id / 会话绑定 / 环境凭据）
│       ├── platform-probe-port.ts   # PlatformProbePort（CLI 探测：binary/version/gitbash）
│       ├── network-probe-port.ts    # NetworkProbePort（HEAD 探测）
│       ├── live-probe-runner.ts     # LiveProbeRunner（真实 spawn，重 I/O 隔离）
│       └── oauth-status-port.ts     # OAuthStatusPort（OpenAI/xAI OAuth 状态）
├── usecases/
│   ├── configure-provider.ts        # ConfigureProviderService（实现 driving 端口）
│   ├── diagnose.ts                  # DiagnoseService（编排 5 探针 + live + 修复）
│   ├── auth-resolver.ts             # AuthResolver（纯函数解析）
│   └── probes/
│       ├── cli-probe.ts
│       ├── auth-probe.ts
│       ├── provider-probe.ts
│       ├── features-probe.ts
│       ├── network-probe.ts
│       └── live-probe.ts            # 组合 LiveProbeRunner + SK.ErrorClassifier
└── index.ts                         # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`SqliteProviderRepository`、`ClaudeSdkLiveProbe` 等）位于 `apps/api` 适配器层，不在核心包内。本文件给签名，不给实现。

## 3. 领域模型 (Domain Model)

### 3.1 Provider 实体

```ts
// domain/provider/provider.ts
export type ProviderId = string;

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly providerType: string;        // legacy: anthropic|openrouter|bedrock|vertex|custom
  readonly presetKey: string;           // 稳定目录身份；空=legacy/ambiguous
  readonly protocol: Protocol;          // 见 protocol.ts
  readonly baseUrl: string;
  readonly apiKey: string;              // 明文只在核心内；出核心前经 Redactor
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly extraEnv: Readonly<Record<string, string>>;        // 由 extra_env JSON 解析
  readonly headers: Readonly<Record<string, string>>;         // headers_json
  readonly envOverrides: Readonly<Record<string, string>>;    // env_overrides_json
  readonly roleModels: RoleModels;                            // role_models_json
  readonly options: ProviderOptions;                          // options_json: {thinkingMode?, context1m?}
  readonly notes: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderOptions {
  readonly thinkingMode?: string;
  readonly context1m?: boolean;
}
```

> 字段一一对应现有 `api_providers` 表（见 CodePilot `src/types/index.ts` 的 `ApiProvider`）。核心用富类型（对象/枚举），JSON string ↔ 对象的编解码在适配器边界完成。

### 3.2 Protocol 枚举与谓词

```ts
// domain/provider/protocol.ts
export enum Protocol {
  ANTHROPIC        = 'anthropic',
  OPENAI_COMPATIBLE= 'openai-compatible',
  XAI              = 'xai',
  OPENROUTER       = 'openrouter',
  BEDROCK          = 'bedrock',
  VERTEX           = 'vertex',
  GOOGLE           = 'google',
  GEMINI_IMAGE     = 'gemini-image',
  OPENAI_IMAGE     = 'openai-image',
  UNKNOWN          = 'unknown',
}

/** 无需 base_url 的协议（云凭据/IAM/官方端点）。 */
export function protocolNeedsBaseUrl(p: Protocol): boolean;
/** 是否 Anthropic 系（决定 thinking / 1M context 兼容）。 */
export function isAnthropicNative(p: Protocol, baseUrl: string): boolean;
```

### 3.3 AuthStyle 与 ResolvedProvider

```ts
// domain/provider/auth-style.ts
export type AuthStyle = 'api_key' | 'auth_token' | 'ambiguous';

// domain/auth/resolved-provider.ts
export interface ResolvedProvider {
  readonly provider?: Provider;      // 缺省=回退环境变量模式
  readonly protocol: Protocol;
  readonly model?: string;
  readonly authStyle: AuthStyle;
  readonly hasCredentials: boolean;
  /** 解析来源标记，供 UI source breadcrumb：'provider' | 'env' | 'oauth' | 'none' */
  readonly source: 'provider' | 'env' | 'oauth' | 'none';
}
```

### 3.4 诊断值对象

```ts
// domain/diagnosis/severity.ts
export type Severity = 'ok' | 'warn' | 'error' | 'skipped';
export function maxSeverity(a: Severity, b: Severity): Severity; // skipped 不拉高整体

// domain/diagnosis/finding.ts
export type ProbeName = 'cli' | 'auth' | 'provider' | 'features' | 'network' | 'live';

export interface Finding {
  readonly severity: Severity;
  readonly code: string;                    // 见 finding-code.ts
  readonly messageKey: string;              // 经 SK.TranslationPort 渲染
  readonly messageParams?: Readonly<Record<string, string | number>>;
  readonly detail?: string;                 // 已脱敏
  readonly errorCode?: string;              // 来自 SK.ErrorClassifier（若源于异常）
  readonly repairActions?: ReadonlyArray<RepairActionRef>;
}

export interface ProbeResult {
  readonly probe: ProbeName;
  readonly severity: Severity;
  readonly findings: ReadonlyArray<Finding>;
  readonly durationMs: number;
}

export interface DiagnosisResult {
  readonly overallSeverity: Severity;
  readonly probes: ReadonlyArray<ProbeResult>;
  readonly repairs: ReadonlyArray<RepairAction>;
  readonly timestamp: number;               // 来自 SK.Clock
  readonly durationMs: number;
}

// domain/diagnosis/repair-action.ts
export type RepairActionType =
  | 'set-default-provider'
  | 'apply-provider-to-session'
  | 'clear-stale-resume'
  | 'switch-auth-style'
  | 'reimport-env-config';

export interface RepairAction {
  readonly type: RepairActionType;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly addresses: ReadonlyArray<string>;   // 能处理的 finding code
}

export interface RepairActionRef {
  readonly type: RepairActionType;
  readonly params?: Readonly<Record<string, string>>;   // 如 { providerId, authStyle }
}
```

## 4. 驱动端口 (Driving Ports)

### 4.1 ConfigureProviderUseCase

```ts
// ports/driving/configure-provider-usecase.ts
export interface CreateProviderInput {
  name: string; providerType: string; presetKey?: string; protocol: Protocol;
  baseUrl?: string; apiKey?: string;
  extraEnv?: Record<string, string>; headers?: Record<string, string>;
  envOverrides?: Record<string, string>; roleModels?: Partial<RoleModels>;
  options?: ProviderOptions; notes?: string;
}
export type UpdateProviderInput = Partial<CreateProviderInput>;

export interface ConfigureProviderUseCase {
  /** 列表（默认脱敏 apiKey），供设置页。 */
  list(): Promise<ReadonlyArray<Provider>>;
  getById(id: ProviderId): Promise<Provider | undefined>;
  /** 创建；FR-1.4 写路径校验，非法态抛 ClassifiedError(INVALID_REQUEST)。 */
  create(input: CreateProviderInput): Promise<Provider>;
  update(id: ProviderId, patch: UpdateProviderInput): Promise<Provider>;
  remove(id: ProviderId): Promise<void>;
  /** 设默认 Provider（单选）。 */
  setDefault(id: ProviderId): Promise<void>;
  /** 切换启用态（至多一个 active）。 */
  setActive(id: ProviderId): Promise<void>;
  reorder(orderedIds: ReadonlyArray<ProviderId>): Promise<void>;
  /** 只读：解析当前生效的认证（供 UI 显示 authStyle/hasCredentials）。 */
  resolveAuth(opts?: { providerId?: ProviderId }): Promise<ResolvedProvider>;
}
```

### 4.2 DiagnoseUseCase

```ts
// ports/driving/diagnose-usecase.ts
export interface DiagnoseUseCase {
  /** 5 探针并发诊断（不含 live），秒级返回，结果缓存。 */
  runDiagnosis(): Promise<DiagnosisResult>;
  /** Live 深度探针，独立触发（可 15s），返回单个 ProbeResult。 */
  runLiveProbe(): Promise<ProbeResult>;
  /** 取上次缓存的诊断结果（供导出，不重跑）。 */
  getLastDiagnosis(): DiagnosisResult | undefined;
  /** 列出针对某诊断结果可用的修复动作。 */
  listRepairs(result: DiagnosisResult): ReadonlyArray<RepairAction>;
  /** 执行一条修复动作；返回是否成功 + 可读结论 key。 */
  applyRepair(type: RepairActionType, params?: Record<string, string>): Promise<{ ok: boolean; messageKey: string }>;
}
```

## 5. 出站端口 (Driven Ports)

### 5.1 ProviderRepository（同时是 C2 消费入口）

```ts
// ports/driven/provider-repository.ts
export interface ProviderRepository {
  listAll(): Promise<ReadonlyArray<Provider>>;
  getById(id: ProviderId): Promise<Provider | undefined>;
  getDefaultId(): Promise<ProviderId | undefined>;
  getActive(): Promise<Provider | undefined>;
  save(provider: Provider): Promise<void>;      // upsert
  delete(id: ProviderId): Promise<void>;
  setDefaultId(id: ProviderId | undefined): Promise<void>;
  setActive(id: ProviderId): Promise<void>;     // 清其余 active
  reorder(orderedIds: ReadonlyArray<ProviderId>): Promise<void>;
}
```
- **实现位置**：适配器 `SqliteProviderRepository`（读写 `api_providers` + `provider_models` + `default_provider_id` 设置；JSON string ↔ 对象编解码）。
- **消费方**：C7 内部用例 + **C2（只读消费 Provider 配置）**。契约图 `C7.ProviderRepository → C2 消费` 由此落地：C2 `imports: [ProviderManagementModule]` 后注入本端口只读使用，写操作回 `ConfigureProviderUseCase`。

### 5.2 SettingsPort

```ts
// ports/driven/settings-port.ts
export interface SettingsPort {
  get(key: string): Promise<string | undefined>;         // thinking_mode / context_1m / anthropic_auth_token 等
  set(key: string, value: string): Promise<void>;
  /** 环境变量只读快照（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 等），已脱敏由调用方决定。 */
  envSnapshot(): Promise<Readonly<Record<string, string | undefined>>>;
  /** 近期会话 stale sdk_session_id 只读探测（Features 探针用，跨界只读 C1）。 */
  listStaleSessionIds(limit: number): Promise<ReadonlyArray<{ sessionId: string; sdkSessionId: string }>>;
  clearStaleSessionIds(sessionId?: string): Promise<number>;
}
```

### 5.3 PlatformProbePort / NetworkProbePort

```ts
// ports/driven/platform-probe-port.ts
export interface PlatformProbePort {
  findClaudeBinary(): Promise<string | undefined>;
  getClaudeVersion(bin: string): Promise<string | undefined>;
  findAllClaudeBinaries(): Promise<ReadonlyArray<{ path: string; version?: string }>>;
  isWindows(): boolean;
  findGitBash(): Promise<string | undefined>;
}

// ports/driven/network-probe-port.ts
export interface NetworkProbePort {
  /** HEAD 探测（不发凭据），超时/失败以结果返回，不抛。 */
  head(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: unknown }>;
}
```

### 5.4 LiveProbeRunner / OAuthStatusPort

```ts
// ports/driven/live-probe-runner.ts
export interface LiveProbeInput {
  resolved: ResolvedProvider;
  promptText: string;      // 'Say OK'
  timeoutMs: number;       // 15_000
}
export interface LiveProbeOutcome {
  kind: 'passed' | 'empty' | 'skipped' | 'timeout' | 'failed';
  stderrTail?: string;     // 末 500 字符，未脱敏；核心侧再经 Redactor
  error?: unknown;         // failed 时的原始异常，交 SK.ErrorClassifier
  detail?: string;
}
export interface LiveProbeRunner {
  run(input: LiveProbeInput): Promise<LiveProbeOutcome>;
}

// ports/driven/oauth-status-port.ts
export interface OAuthStatus {
  authenticated: boolean; needsRefresh?: boolean; email?: string; plan?: string;
}
export interface OAuthStatusPort {
  openai(): Promise<OAuthStatus | undefined>;
  xai(): Promise<OAuthStatus | undefined>;
}
```
- `LiveProbeRunner` 把唯一的重 I/O（真实 spawn Claude SDK）挡在核心之外——核心只拿结构化 `LiveProbeOutcome`，再用 `SK.ErrorClassifier` 分类。适配器 `ClaudeSdkLiveProbe` 对应现有 `runLiveProbe`。

## 6. 用例编排要点

- `AuthResolver.resolve(providers, defaultId, env, oauth)` —— 纯函数：优先 providerId/default，缺失或指向已删记录则回退 env，OAuth-only 时标 `source='oauth'`；双 auth 风格 → `authStyle='ambiguous'`。（对应现有 `provider-resolver.ts`）
- `DiagnoseService.runDiagnosis()` —— `Promise.all` 并发 5 探针 → 聚合 severity → `attachRepairsToFindings`（按 finding.code 反查 REPAIR_ACTIONS 并填参）→ 缓存。
- `applyRepair` —— 按 type 分派，经 `ProviderRepository`/`SettingsPort` 改状态；核心不碰 DB。
- 所有 finding 消息用 `messageKey` + `messageParams`，渲染交 `SK.TranslationPort`；异常统一 `SK.ErrorClassifier.classify` → `errorCode`；离核心的 detail/stderr 经 `SK.Redactor`。

## 7. 依赖注入接线 (NestJS 侧)

```
ProviderManagementModule (apps/api)
  imports: [SharedKernelModule]      // 注入 ErrorClassifier/Redactor/RuntimeLog/Clock/TranslationPort
  provides:
    ConfigureProviderUseCase  → ConfigureProviderService(ProviderRepository, SettingsPort, AuthResolver, Redactor)
    DiagnoseUseCase           → DiagnoseService(所有 5 探针 + LiveProbe, ProviderRepository, SettingsPort,
                                                 PlatformProbePort, NetworkProbePort, LiveProbeRunner,
                                                 OAuthStatusPort, ErrorClassifier, Clock, RuntimeLog)
    ProviderRepository        → SqliteProviderRepository(Database)
    SettingsPort              → SqliteSettingsAdapter(Database)
    PlatformProbePort         → NodePlatformProbe
    NetworkProbePort          → FetchNetworkProbe
    LiveProbeRunner           → ClaudeSdkLiveProbe(prepareSdkSubprocessEnv 等)
    OAuthStatusPort           → OAuthStatusAdapter(openai/xai oauth managers)
  exports:
    ConfigureProviderUseCase, DiagnoseUseCase, ProviderRepository   // ProviderRepository 供 C2 import 消费
  controllers:
    ProviderController   (REST: GET/POST/PATCH/DELETE /api/providers, PUT default/active/order, GET resolve-auth)
    DiagnoseController   (POST /api/doctor/diagnose, POST /api/doctor/live, GET /api/doctor/last, POST /api/doctor/repair)
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。

## 8. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `SK.ErrorClassifier` | C7 依赖 SK | context-boundaries.md：C7「依赖端口：SK.ErrorClassifier」；SK architecture 4.1 明列 C7 为消费方 |
| `SK.Redactor/RuntimeLog/Clock/TranslationPort` | C7 依赖 SK（横切） | SK 对外端口清单（横切全上下文） |
| `ConfigureProviderUseCase` | C7 对外提供 | C7「对外提供端口」 |
| `DiagnoseUseCase` | C7 对外提供 | C7「对外提供端口」 |
| `ProviderRepository` | C7 对外提供 → C2 消费 | C7「对外提供端口」+ 引用图 `C7.ProviderRepository → C2 消费` |

**边界纪律自检**：
- C7 未定义/未重写任何 SK 概念（ErrorCode/Redactor 等只引用）。
- C7 不含会话/消息/流式/MCP 概念；Features 探针对 stale session id 仅经 `SettingsPort` **只读**探测，不写会话（写属 C1）。
- C7 不 import Claude SDK：真实调用锁在 `LiveProbeRunner` 适配器后。
- 无循环依赖：C2 依赖 C7（读 Repository），C7 不依赖 C2。

## 9. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层）：`AuthResolver` 表驱动（api_key/auth_token/ambiguous/env 回退/oauth-only）；各探针用假出站端口（内存 Provider、FakePlatformProbe、FakeNetworkProbe、FakeLiveRunner）断言 finding code 与 severity。
- 反例 smoke（AC-5/6/9）：健康态 vs 注入问题态两条路径断言结果不同；无 CLI 环境断言 `live.skipped` 不出现 `live.passed`；修复后重跑断言 finding 消失。
- 分类一致（AC-12）：同一异常喂给 network 探针与 live 探针，断言经 `SK.ErrorClassifier` 得同一 `ErrorCode`。
- 静态检查（AC-11）：对 `provider-management/` 核心包做禁用 import 扫描（`@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`）0 命中。
- 脱敏反例（AC-3）：断言返回体/日志无 api_key 明文，仅 `last4`。
</content>
