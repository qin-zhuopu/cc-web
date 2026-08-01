---
title: 架构 — C9 PluginMCP 插件与 MCP
context: C9 · PluginMCP
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C9 · PluginMCP（插件与 MCP）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS PluginMcpController
                     (HTTP: GET /api/mcp/servers, POST /api/mcp/servers, PATCH /api/mcp/servers/:name,
                            POST /api/mcp/servers/:name/probe, GET /api/skills, GET /api/skills/:name/body)
               ↓ 调用驱动端口
        [驱动端口] RegisterMcpServerUseCase / LoadSkillUseCase / GetRunSupplyUseCase
               ↓
        [应用核心] Domain Model + Use Cases（纯逻辑，零框架，零 fs/sdk/db）
               ↓ 依赖倒置，只依赖接口
        [出站端口] McpServerPort / SkillLoaderPort / CredentialResolverPort
               +   （横切）SK: RuntimeLog / Redactor / ErrorClassifier / TranslationPort / IdGenerator
               ↓ 由适配器实现
        [被驱动适配器] NodeMcpAdapter（读 .claude.json/.mcp.json + MCP SDK 连接探测）
                       FsSkillAdapter（扫技能目录 + 读 SKILL.md）
                       DbCredentialResolver（${...} → CodePilot 设置项，凭据仅此处出现）
```

依赖方向永远指向核心。C9 核心**只依赖 `McpServerPort`/`SkillLoaderPort`/`CredentialResolverPort` 接口与横切 SK 端口**，绝不 import `fs`/`path`/`os`/`@modelcontextprotocol/sdk`/框架/DB。按边界契约，C9 **依赖 SK**（横切），对业务上下文无依赖；其对外产物由 **C2 消费**（本轮 server 清单 + 可用 Skill 描述 + 指定 Skill 正文）。

**编排归属红线（最关键的一条边界）**：C9 只到"注册与加载"为止——回答"有哪些 server/Skill、长什么样、启用没启用、自动批准策略是什么、正文是什么"。"本轮把哪些 server 传给哪个 Runtime""AI 请求调某工具时的 canUseTool 放行与执行（`callMcpTool`）""Skill 正文注入对话后如何驱动 AI/起 fork 子 agent"全部属 **C2/C3**。C9 的 `McpServerPort.probe` 是**注册期能力探测**（连一下、列个工具、报状态），不是运行时工具调用。这条线若守不住，C9 会越界成"MCP 运行时"，与 C2 职责重叠。

## 2. 目录结构

```
packages/core/plugin-mcp/
├── domain/
│   ├── mcp/
│   │   ├── mcp-server-config.ts       # McpServerConfig 值对象（command/args/env/type/url/headers/enabled）
│   │   ├── mcp-server-registration.ts # McpServerRegistration 聚合（配置 + 有效 enabled + 来源 + 凭据解析状态）
│   │   ├── mcp-connection-status.ts    # ConnectionStatus 值对象（status + toolCount + tools + 脱敏 error）
│   │   ├── mcp-tool-descriptor.ts      # McpToolDescriptor 值对象（qualifiedName/originalName/serverName/description/inputSchema）
│   │   └── config-source.ts            # ConfigSource 枚举 + 合并优先级常量
│   ├── autoapprove/
│   │   ├── auto-approve-policy.ts      # AutoApprovePolicy 值对象 + 纯函数 computeAutoApprove
│   │   └── external-mcp-status.ts      # ExternalMcpStatus + summarizeExternalMcp 纯函数（承接现有 external-mcp）
│   ├── skill/
│   │   ├── skill-descriptor.ts         # SkillDescriptor 值对象（描述视图，不含 body）
│   │   ├── loaded-skill.ts             # LoadedSkill 值对象（正文视图：prompt/fork/allowedTools/model/effort）
│   │   ├── skill-definition.ts         # SkillDefinition 完整解析结果（承接现有 SkillDefinition）
│   │   ├── skill-frontmatter.ts        # parseSkillFrontmatter / splitFrontmatter 纯函数（吃字符串）
│   │   └── skill-template.ts           # substituteSkillArgs 纯函数（$arg/${arg}/${CLAUDE_SKILL_DIR} 替换）
│   ├── error/
│   │   ├── mcp-error.ts                # McpError + McpErrorCode
│   │   └── skill-error.ts              # SkillError + SkillErrorCode
│   └── message-keys.ts                 # C9 自身 i18n 键（c9.*）
├── ports/
│   ├── driving/
│   │   ├── register-mcp-server-usecase.ts  # RegisterMcpServerUseCase 驱动端口（契约对外）
│   │   ├── load-skill-usecase.ts           # LoadSkillUseCase 驱动端口
│   │   └── get-run-supply-usecase.ts       # GetRunSupplyUseCase 聚合读端口（供 C2）
│   └── driven/
│       ├── mcp-server-port.ts          # McpServerPort 出站端口（契约对外，供 C2 消费）
│       ├── skill-loader-port.ts        # SkillLoaderPort 出站端口（契约对外，供 C2 消费）
│       └── credential-resolver-port.ts # CredentialResolverPort 出站端口（${...} 解析，凭据仅此处）
├── usecases/
│   ├── register-mcp-server.ts          # RegisterMcpServerService（实现 driving 端口）
│   ├── load-skill.ts                   # LoadSkillService
│   └── get-run-supply.ts               # GetRunSupplyService（聚合 McpServerPort + SkillLoaderPort）
└── index.ts                            # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`NodeMcpAdapter`/`FsSkillAdapter`/`DbCredentialResolver`）位于 `apps/api` 适配器层，不在核心包内。领域层的 SKILL.md 解析（`splitFrontmatter`/`parseSkillFrontmatter`/`substituteSkillArgs`）与自动批准策略（`computeAutoApprove`/`summarizeExternalMcp`）**只放纯函数**（吃字符串/结构、吐结构），真正的 `fs.readdir`/`fs.readFile`/MCP `client.connect`/DB 读取归适配器——见 §7 归属决策。

## 3. 领域模型 (Domain Model)

### 3.1 McpServerConfig — MCP server 配置值对象

```ts
// domain/mcp/mcp-server-config.ts
export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpServerConfig {
  readonly command?: string;                 // stdio 用
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>; // 可能含 ${...} 占位符（解析前）
  readonly type?: McpTransportType;           // 缺省 'stdio'
  readonly url?: string;                       // sse/http 用
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;                  // 文件自身的 enabled（未叠加 overrides）
}
```

> 字段对齐现有 `@/types` 的 `MCPServerConfig`。**env 值在此层可能仍是 `${...}` 占位符**——真实凭据解析在 `CredentialResolverPort` 适配器完成，且解析结果不写回可见字段（见 §5.3）。

### 3.2 McpServerRegistration — 注册项聚合

```ts
// domain/mcp/mcp-server-registration.ts
export type ConfigSource = 'user:.claude.json' | 'user:settings.json' | 'project:.mcp.json';

export interface McpServerRegistration {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly effectiveEnabled: boolean;        // 叠加 mcpServerOverrides 后的有效启用值（FR-1.2）
  readonly source: ConfigSource;             // 来源 breadcrumb（后来源覆盖前来源）
  readonly credentialResolved: boolean;      // ${...} 是否全部命中设置项（FR-1.3；缺失=false，不冒充）
  readonly credentialKeysMissing: ReadonlyArray<string>; // 缺失的设置键名（不含值），供 UI 诊断
}
```

> **不变量**：`credentialResolved === (credentialKeysMissing.length === 0)`。**真实凭据值绝不出现在本聚合的任何字段**——只暴露"解析成功没""缺哪些键名"，落实反假数据 + 凭据不外泄（NFR-2）。

### 3.3 ConnectionStatus / McpToolDescriptor — 探测结果（注册期能力探测）

```ts
// domain/mcp/mcp-connection-status.ts
export type ConnectionState = 'connected' | 'connecting' | 'failed' | 'disabled' | 'unknown';

export interface ConnectionStatus {
  readonly serverName: string;
  readonly state: ConnectionState;           // 未探测=unknown，不冒充 connected（§0 反假）
  readonly toolCount?: number;               // 实测 listTools 长度；未连接留空，不填假 0
  readonly tools: ReadonlyArray<McpToolDescriptor>;
  readonly error?: string;                   // 已脱敏（经 SK.Redactor），仅诊断
}

// domain/mcp/mcp-tool-descriptor.ts
export interface McpToolDescriptor {
  readonly qualifiedName: string;            // mcp__{serverName}__{toolName}（FR-2.4）
  readonly originalName: string;
  readonly serverName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>; // JSON Schema，来自 server
}
```

> 字段对齐现有 `McpToolDefinition`。这是**注册期探测**产出，用于 UI 状态显示与自动批准策略计算，**不驱动 AI 调用**（那属 C2）。

### 3.4 自动批准策略与外部 MCP 状态（领域纯函数）

```ts
// domain/autoapprove/external-mcp-status.ts —— 承接现有 permission/external-mcp.ts，迁入 C9 domain
export type ExternalMcpStatus =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly certainty: 'configured' | 'undetectable'; // configured=看得见并能命名；undetectable=配置不可读
      readonly sources: ReadonlyArray<string>;           // 来源标签，绝不含文件内容/凭据
    };

export interface McpConfigProbe {
  readonly label: string;                     // 稳定标签，如 'user:~/.claude.json'
  readonly outcome: 'absent' | 'empty' | 'has-servers' | 'unreadable';
}

/** fail-closed 汇总：看得见的 server 优先，其次不可读→undetectable→present。纯函数。 */
export function summarizeExternalMcp(input: {
  readonly explicitServerNames?: ReadonlyArray<string>;
  readonly probes?: ReadonlyArray<McpConfigProbe>;
}): ExternalMcpStatus;

// domain/autoapprove/auto-approve-policy.ts
export interface AutoApprovePolicy {
  readonly qualifiedName: string;            // 针对某工具（或 server 级通配）
  readonly autoApprove: boolean;
  readonly reason: string;                    // 来源 breadcrumb（server 名 + certainty），无来源不得 true（FR-3.1/AC-8）
}

/**
 * 计算自动批准策略。fail-closed：外部 MCP present 且 certainty=undetectable 时收紧。
 * 禁止基于名字前缀信任——trustedRegistry 是显式可信来源集，绝不看名字（FR-3.3）。纯函数。
 */
export function computeAutoApprove(input: {
  readonly tools: ReadonlyArray<McpToolDescriptor>;
  readonly externalStatus: ExternalMcpStatus;
  readonly trustedRegistry: ReadonlySet<string>; // 显式可信来源（进程内注册），非名字前缀
}): ReadonlyArray<AutoApprovePolicy>;
```

> `summarizeExternalMcp` 与 fail-closed / 不看前缀的语义**完整承接现有 `external-mcp.ts`（review round #4/#5 结论）**，只是从 `permission/` 迁入 C9 domain 作纯函数。C9 只产出"策略信号"，**运行时是否真的放行**由权限链路（C5/C2 canUseTool）决定——C9 不做放行。

### 3.5 SkillDescriptor vs LoadedSkill vs SkillDefinition（三语义分离，反假红线）

```ts
// domain/skill/skill-definition.ts —— 完整解析结果（承接现有 SkillDefinition）
export interface SkillArgumentDef {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}
export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly body: string;                      // 正文（prompt），只在加载语义里出现
  readonly allowedTools: ReadonlyArray<string>;
  readonly whenToUse?: string;
  readonly context: 'inline' | 'fork';
  readonly arguments: ReadonlyArray<SkillArgumentDef>;
  readonly model?: string;
  readonly effort?: string;
  readonly userInvocable: boolean;
  readonly filePath: string;
}

// domain/skill/skill-descriptor.ts —— “可用 Skill 描述”视图（§0.1 第 1 类，不含 body）
export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly userInvocable: boolean;
  readonly context: 'inline' | 'fork';
  readonly arguments: ReadonlyArray<SkillArgumentDef>;
  // 刻意不含 body —— 描述视图绝不携带正文，从类型上切断“可用”与“已加载”混淆
}

// domain/skill/loaded-skill.ts —— “本轮加载的 Skill 正文”视图（§0.1 第 2 类）
export interface LoadedSkill {
  readonly name: string;
  readonly prompt: string;                    // 参数替换后的正文，供 C2 注入（C9 不注入）
  readonly fork: boolean;                      // context==='fork'
  readonly allowedTools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly effort?: string;
}
```

> **反假数据核心契约**：`SkillDescriptor`（描述，无 body）与 `LoadedSkill`（正文）是**两个不同类型**，从类型层强制区分"可用"与"已加载"。"实际调用结果"（§0.1 第 3 类）**根本没有对应 C9 类型**——它属 C2 的执行事件。任何把三者混成一个计数的 UI 都违反本契约（AC-11）。

### 3.6 SKILL.md 解析与参数替换（领域纯函数）

```ts
// domain/skill/skill-frontmatter.ts
/** 拆 YAML frontmatter 与 body。无 frontmatter 时 frontmatter={}、body=原文。纯函数。 */
export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string };

/** frontmatter + filePath → SkillDefinition（全字段：allowed-tools/when_to_use/context/arguments/...）。纯函数。 */
export function parseSkillDefinition(content: string, filePath: string): SkillDefinition;

// domain/skill/skill-template.ts
/** 替换 $arg / ${arg} 与内建 ${CLAUDE_SKILL_DIR}。纯函数，承接现有 prepareSkillExecution 的替换逻辑。 */
export function substituteSkillArgs(
  body: string,
  args: Readonly<Record<string, string>>,
  skillDir: string,
): string;
```

> 承接现有 `skill-parser.ts` 的 `parseSkillFile`/`splitFrontmatter` 与 `skill-executor.ts` 的 `prepareSkillExecution`。全为纯函数（吃字符串、吐结构），可表驱动单测（NFR-7）；真正的目录扫描/读文件在 `FsSkillAdapter`。

### 3.7 结构化错误

```ts
// domain/error/mcp-error.ts
export type McpErrorCode =
  | 'server_not_found' | 'invalid_config' | 'unsupported_transport'
  | 'connection_failed' | 'credential_missing';
export class McpError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    public readonly messageKey: string,        // c9.* i18n 键，经 SK.TranslationPort 渲染
    public readonly meta?: Readonly<Record<string, unknown>>, // 绝不含凭据值
  );
}

// domain/error/skill-error.ts
export type SkillErrorCode = 'skill_not_found' | 'unparseable_skill' | 'missing_required_arg';
export class SkillError extends Error {
  constructor(
    public readonly code: SkillErrorCode,
    public readonly messageKey: string,
    public readonly meta?: Readonly<Record<string, unknown>>,
  );
}
```

> 错误只带 `code` + `messageKey`（`c9.*`），不硬编码文案（NFR-5/6）；`meta` 绝不含凭据值。

## 4. 驱动端口 (Driving Ports)

### 4.1 RegisterMcpServerUseCase（契约对外提供）

```ts
// ports/driving/register-mcp-server-usecase.ts
export interface RegisterMcpServerInput {
  name: string;
  config: McpServerConfig;
  workingDirectory?: string;                  // .mcp.json 用真实工作目录（FR-1.6）
}

export interface RegisterMcpServerUseCase {
  /** 注册/更新单个 server，写回约定来源；读回 enabled 与实际生效一致（FR-1.4）。 */
  register(input: RegisterMcpServerInput): Promise<McpServerRegistration>;
  /** 删除一个 server。 */
  remove(name: string, workingDirectory?: string): Promise<void>;
  /** 启停一个 server（写 mcpServerOverrides）。 */
  setEnabled(name: string, enabled: boolean): Promise<McpServerRegistration>;
  /** 列全部已注册（含禁用 + 状态，供 UI）。（FR-1.5） */
  listAll(workingDirectory?: string): Promise<ReadonlyArray<McpServerRegistration>>;
  /** 探测单个 server（注册期能力探测：连接 + listTools + 状态）。（FR-2） */
  probe(name: string, workingDirectory?: string): Promise<ConnectionStatus>;
  /** 计算自动批准策略 + 外部 MCP 存在信号（供权限链路消费，C9 不放行）。（FR-3） */
  describeAutoApprove(workingDirectory?: string): Promise<{
    externalStatus: ExternalMcpStatus;
    policies: ReadonlyArray<AutoApprovePolicy>;
  }>;
}
```

### 4.2 LoadSkillUseCase（Skill 三语义的加载侧）

```ts
// ports/driving/load-skill-usecase.ts
export interface LoadSkillUseCase {
  /** 列可用 Skill 描述（§0.1 第 1 类，不含 body）。项目级优先、按名去重。（FR-4.1） */
  listAvailable(workingDirectory?: string): Promise<ReadonlyArray<SkillDescriptor>>;
  /** 加载指定 Skill 正文 + 参数替换（§0.1 第 2 类）。未知→SkillError('skill_not_found')。（FR-4.2/4.5） */
  loadBody(name: string, args?: Readonly<Record<string, string>>, workingDirectory?: string): Promise<LoadedSkill>;
  /** 失效发现缓存（技能文件变更后由 UI 主动触发）。（FR-4.4） */
  invalidate(workingDirectory?: string): void;
}
```

> C9 只到 `LoadedSkill`（正文 + fork 标志 + allowedTools）为止——**注入对话/起 fork 子 agent 属 C2/C3**（FR-4.5/AC-13）。

### 4.3 GetRunSupplyUseCase（聚合读，供 C2 一次性取本轮供给）

```ts
// ports/driving/get-run-supply-usecase.ts
export interface RunSupply {
  /** 本轮该用的 MCP server（仅启用 + 凭据已解析；env 含真实凭据供 Runtime）。（FR-1.5/5.1） */
  readonly mcpServersForRun: Readonly<Record<string, McpServerConfig>>;
  /** 可用 Skill 描述（供模型选择；不含正文）。（FR-4.1） */
  readonly availableSkills: ReadonlyArray<SkillDescriptor>;
  /** 外部 MCP 存在信号（供权限档位决策）。（FR-3.2） */
  readonly externalMcpStatus: ExternalMcpStatus;
}

export interface GetRunSupplyUseCase {
  /** 给定工作目录，产出本轮供给快照。严格只含“可注册/可加载”供给，不含“已调用/已执行”语义。（FR-5） */
  getRunSupply(workingDirectory?: string): Promise<RunSupply>;
}
```

## 5. 出站端口 (Driven Ports)

### 5.1 McpServerPort（契约对外提供；供 C2 消费）

```ts
// ports/driven/mcp-server-port.ts
export interface McpServerPort {
  /**
   * 从多来源读并合并 server 定义（.claude.json / settings.json / <workingDir>/.mcp.json），
   * 应用 mcpServerOverrides，产出注册项（含 source / effectiveEnabled）。
   * 凭据 ${...} 解析委托 CredentialResolverPort；本方法不返回真实凭据值到可见字段。
   */
  readRegistrations(workingDirectory?: string): Promise<ReadonlyArray<McpServerRegistration>>;
  /** 写回单个 server 定义到约定来源。 */
  writeServer(name: string, config: McpServerConfig, workingDirectory?: string): Promise<void>;
  /** 删除一个 server。 */
  deleteServer(name: string, workingDirectory?: string): Promise<void>;
  /** 写 mcpServerOverrides 的 enable/disable 持久覆盖。 */
  writeEnabledOverride(name: string, enabled: boolean): Promise<void>;
  /** 注册期能力探测：按 type 建连 + listTools；失败→state=failed + 脱敏 error，不抛。（FR-2） */
  probe(config: McpServerConfig, serverName: string): Promise<ConnectionStatus>;
  /** 各来源配置探针（供 external-mcp fail-closed 汇总）。（FR-3.2） */
  probeConfigSources(workingDirectory?: string): Promise<ReadonlyArray<McpConfigProbe>>;
  /** “本轮该用”的 server：仅启用 + 凭据解析（env 含真实值，供 Runtime）。（FR-1.5） */
  resolveServersForRun(workingDirectory?: string): Promise<Readonly<Record<string, McpServerConfig>>>;
}
```

- **实现位置**：适配器 `NodeMcpAdapter`（`apps/api`），承接现有 `mcp-loader.ts` + `mcp-connection-manager.ts`：
  - `readRegistrations` = `loadAndMerge` 的三来源合并 + `mcpServerOverrides` 覆盖 + `source` 归属。
  - `resolveServersForRun` = `loadCodePilotMcpServers` / `loadProjectMcpServers`（用 `workingDirectory` 而非 `process.cwd()`，承接现有坑修复）+ `${...}` 经 `CredentialResolverPort` 解析。
  - `probe` = `mcp-connection-manager` 的 `connectServer` + `listTools`（stdio/sse/http transport），**只连+列，不 `callMcpTool`**。
  - `probeConfigSources` = `collectMcpConfigProbes`（承接现有 external-mcp）。
- **供 C2 消费**：C2 在发起一轮调用时经 C9 的 `resolveServersForRun`（或经 `GetRunSupplyUseCase`）拿本轮 server，自己接进 Runtime。C9 不接线、不调用。

### 5.2 SkillLoaderPort（契约对外提供；供 C2 消费）

```ts
// ports/driven/skill-loader-port.ts
export interface SkillLoaderPort {
  /** 扫描技能目录，读每个 SKILL.md 原文 + 路径（解析在核心纯函数做）。项目级优先、去重。 */
  discoverRaw(workingDirectory?: string): Promise<ReadonlyArray<{ content: string; filePath: string }>>;
  /** 读单个已知 Skill 的 SKILL.md 原文（供 loadBody）。未找到→undefined。 */
  readSkillRaw(name: string, workingDirectory?: string): Promise<{ content: string; filePath: string } | undefined>;
  /** 失效发现缓存（承接现有 invalidateSkillCache）。 */
  invalidate(workingDirectory?: string): void;
}
```

- **实现位置**：适配器 `FsSkillAdapter`（`apps/api`），承接现有 `skill-discovery.ts`：多目录扫描、`SKILL.md` 子目录探测、去重缓存。**解析（`parseSkillDefinition`/`substituteSkillArgs`）不在适配器**——适配器只吐原文字符串 + 路径，解析由核心纯函数做（守 NFR-1）。

### 5.3 CredentialResolverPort（凭据仅此处出现）

```ts
// ports/driven/credential-resolver-port.ts
export interface CredentialResolution {
  readonly resolved: Readonly<Record<string, string>>; // 已解析的 env（含真实凭据，供 Runtime）
  readonly missingKeys: ReadonlyArray<string>;          // 缺失的设置键名（不含值）
}
export interface CredentialResolverPort {
  /** 把 env 里的 ${SETTING_KEY} 解析为 CodePilot 设置项真实值；缺失键记入 missingKeys、值不冒充。 */
  resolveEnv(env: Readonly<Record<string, string>>): Promise<CredentialResolution>;
}
```

- **实现位置**：适配器 `DbCredentialResolver`（`apps/api`），读 CodePilot 设置项（现有 `getSetting`）。**这是唯一接触真实凭据的地方**：解析结果只进 `resolveServersForRun` 的 Runtime 交付路径，绝不进 `McpServerRegistration` 可见字段、不进日志（NFR-2）。

## 6. 用例编排要点

```ts
// usecases/get-run-supply.ts
export class GetRunSupplyService implements GetRunSupplyUseCase {
  constructor(
    private readonly mcp: McpServerPort,
    private readonly skills: SkillLoaderPort,
    private readonly log: RuntimeLog,          // SK 横切
    private readonly redactor: Redactor,       // SK 横切
    private readonly errors: ErrorClassifier,  // SK 横切
  ) {}
  // getRunSupply: resolveServersForRun + discoverRaw→parseSkillDefinition→toDescriptor + probeConfigSources→summarizeExternalMcp
}
```

- **`RegisterMcpServerService.probe`**：`mcp.probe(config)` → 成功 `state=connected` + `toolCount`；失败 `errors.classify` 归 NETWORK/PROCESS/TIMEOUT → `state=failed`，error 经 `redactor` 脱敏后 `log.append({source:'c9.mcp', ...})`，不抛。
- **`RegisterMcpServerService.describeAutoApprove`**：`mcp.probeConfigSources` + 显式 server 名 → `summarizeExternalMcp` → `computeAutoApprove(tools, externalStatus, trustedRegistry)`。**fail-closed + 不看前缀**。
- **`LoadSkillService.listAvailable`**：`skills.discoverRaw` → 逐个 `parseSkillDefinition` → 映射为 `SkillDescriptor`（**丢弃 body**，只留描述字段）。
- **`LoadSkillService.loadBody`**：`skills.readSkillRaw(name)`（未找到→`SkillError('skill_not_found')`）→ `parseSkillDefinition` → 校验 required 参数（缺→`missing_required_arg`）→ `substituteSkillArgs(body, args, skillDir)` → 组 `LoadedSkill{ prompt, fork: def.context==='fork', allowedTools, model, effort }`。
- **凭据路径**：`resolveServersForRun` 内 `mcp` 适配器调 `CredentialResolverPort.resolveEnv`；解析后的真实 env 只放进返回给 C2 的 `McpServerConfig`，**不经过任何 `log.append`**；`readRegistrations`（UI 视图）走另一条路，只标 `credentialResolved`/`credentialKeysMissing`，不带真实值。

## 7. 归属决策：领域纯函数 vs 适配器 I/O（关键设计决策）

C9 既涉及**纯字符串/结构判定**（frontmatter 解析、参数替换、自动批准策略、external-mcp 汇总），又涉及**真实 I/O**（读配置文件、扫技能目录、MCP SDK 建连、DB 读凭据）。为守住"核心零 fs/sdk/db 依赖"（NFR-1）：

- **判定/解析逻辑（纯函数）留核心**：`splitFrontmatter` / `parseSkillDefinition` / `substituteSkillArgs` / `summarizeExternalMcp` / `computeAutoApprove`。它们只吃字符串/结构，不碰 `fs`/`@modelcontextprotocol/sdk`/DB，可表驱动单测。
- **I/O 进适配器**：`NodeMcpAdapter`（读 `.claude.json`/`.mcp.json`、`mcpServerOverrides`、MCP `client.connect`+`listTools`）、`FsSkillAdapter`（扫技能目录、读 SKILL.md 原文）、`DbCredentialResolver`（`getSetting` 解析 `${...}`）。适配器吐原始字符串/结构，喂给核心纯函数。
- **凭据收口**：真实凭据只在 `DbCredentialResolver` → `resolveServersForRun` 的 Runtime 交付路径出现，是 C9 最敏感的一段；核心纯函数与 UI 视图都拿不到真实值（NFR-2）。
- **探测 ≠ 调用**：`probe` 在适配器里连接 + listTools，但**没有** `callMcpTool`——工具的实际调用是 C2 运行时的事，C9 适配器不提供该能力（AC-6/AC-13 的边界断言）。

## 8. 依赖注入接线 (NestJS 侧)

```
PluginMcpModule (apps/api)
  imports: [SharedKernelModule]      // 注入 RuntimeLog / Redactor / ErrorClassifier / TranslationPort / IdGenerator
  provides:
    RegisterMcpServerUseCase → RegisterMcpServerService(McpServerPort, RuntimeLog, Redactor, ErrorClassifier)
    LoadSkillUseCase         → LoadSkillService(SkillLoaderPort, ErrorClassifier)
    GetRunSupplyUseCase      → GetRunSupplyService(McpServerPort, SkillLoaderPort, RuntimeLog, Redactor, ErrorClassifier)
    McpServerPort            → NodeMcpAdapter(CredentialResolverPort)   // 本机读文件 + MCP SDK
    SkillLoaderPort          → FsSkillAdapter()                          // 本机扫技能目录
    CredentialResolverPort   → DbCredentialResolver()                    // 读 CodePilot 设置项，凭据仅此处
  exports:
    RegisterMcpServerUseCase   // 契约对外（供 UI 控制器 / 未来上下文）
    McpServerPort              // 契约对外：供 C2 取本轮 server（跨 Module 注入）
    SkillLoaderPort            // 契约对外：供 C2 取可用描述 / 正文
    GetRunSupplyUseCase        // 供 C2 一次性取本轮供给聚合
    // CredentialResolverPort 是 C9 出站实现细节（凭据敏感），不导出
  controllers:
    PluginMcpController
      GET   /api/mcp/servers?workingDir=              → listAll
      POST  /api/mcp/servers                          → register
      PATCH /api/mcp/servers/:name  { enabled }       → setEnabled
      DELETE /api/mcp/servers/:name                   → remove
      POST  /api/mcp/servers/:name/probe              → probe
      GET   /api/mcp/auto-approve?workingDir=         → describeAutoApprove
      GET   /api/skills?workingDir=                   → listAvailable（描述视图，不含 body）
      GET   /api/skills/:name/body?workingDir=&args=  → loadBody（正文视图）
      POST  /api/skills/invalidate                    → invalidate
      // 控制器负责：McpError/SkillError.code → HTTP 400/404/409/500，SK.TranslationPort 渲染 messageKey，
      //            SK.Redactor 脱敏日志；绝不把真实凭据序列化进任何响应。
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。`McpServerPort`/`SkillLoaderPort` **需 export**——C2 跨 Module 注入它们取本轮供给（落地引用图上 C2 消费 C9 的关系）；`CredentialResolverPort` 因涉真实凭据、无其它上下文消费，**不导出**（区别于对外的两个出站端口）。

**C2 消费方式（澄清接线，不越界）**：C2 的 `AgentRuntimeModule` `imports: [PluginMcpModule]`，注入 `McpServerPort.resolveServersForRun` / `SkillLoaderPort` / `GetRunSupplyUseCase`。C2 拿到 server 清单与 Skill 描述/正文后，**自己**接进各 Runtime、编排 canUseTool、注入 Skill 正文——这些都在 C2，不回流到 C9。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `RegisterMcpServerUseCase` | C9 对外提供 | context-boundaries.md：C9「对外提供端口：RegisterMcpServerUseCase」 |
| `McpServerPort` | C9 对外提供（出站，供 C2 消费） | C9「对外提供端口：McpServerPort」——由 NodeMcpAdapter 实现 |
| `SkillLoaderPort` | C9 对外提供（出站，供 C2 消费） | C9「对外提供端口：SkillLoaderPort」——由 FsSkillAdapter 实现 |
| `LoadSkillUseCase` / `GetRunSupplyUseCase` | C9 对外提供（本上下文补充驱动端口） | 支撑 Skill 三语义分离与 C2 聚合取用，不越 C9「拥有：Skill 加载」边界 |
| `CredentialResolverPort` | C9 内部出站（不导出） | C9 自用；凭据敏感，无跨上下文消费 |
| `SK.RuntimeLog/Redactor/ErrorClassifier/TranslationPort/IdGenerator` | C9 依赖 SK（横切） | 契约 C9「依赖端口：SK」 |

**边界纪律自检**：
- C9 不含"MCP 工具被 AI 调用的编排"：无 `callMcpTool` 运行时调用、无 canUseTool 放行、无 Skill 正文注入对话/起 fork 子 agent——那属 C2/C3。C9 `probe` 只做注册期能力探测（AC-6/AC-13）。
- C9 不做运行时权限放行：只产出自动批准**策略信号**（fail-closed + 不看前缀），放行判定归 C5/C2 canUseTool（FR-3.1）。
- C9 不含会话/消息（C1）、Provider auth（C7；MCP `${...}` 读通用设置项，与 Provider auth 两条线）、文件浏览（C8）、子 agent 编排（C3）。
- **Skill 三语义类型层分离**：`SkillDescriptor`（无 body）≠ `LoadedSkill`（正文）；"调用结果"无 C9 类型（AC-11）。
- C9 不 import `fs`/`path`/`os`/`@modelcontextprotocol/sdk`/`better-sqlite3`/`@nestjs/*`：全部 I/O 锁在三个适配器后（AC-14 静态扫描）。
- **凭据不外泄**：真实凭据只在 `DbCredentialResolver`→`resolveServersForRun`→C2 交付路径出现，不进可见字段/日志（NFR-2/AC-2/AC-16）。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，用假 `McpServerPort`/`SkillLoaderPort`/`CredentialResolverPort`）：
  - SKILL.md 解析纯函数表驱动：`splitFrontmatter`（有/无 frontmatter）、`parseSkillDefinition`（全字段：allowed-tools/context/arguments/user-invocable）、`substituteSkillArgs`（`$arg`/`${arg}`/`${CLAUDE_SKILL_DIR}`）（AC-9/10）。
  - `summarizeExternalMcp` / `computeAutoApprove` 表驱动：fail-closed（unreadable→undetectable→present）、不看前缀（`codepilot-vault` 不豁免）、无来源不 autoApprove（AC-7/8）。
  - MCP 合并/覆盖：三来源顺序、`mcpServerOverrides` 有效 enabled、`.mcp.json` 用传入 workingDirectory 而非 cwd（AC-1/3/4）。
  - Skill 三语义：`listAvailable` 计数恒定 vs `loadBody` 只在触发路径返回正文（AC-11 反假核心反例）；`invalidate` 后不显已删（AC-12）。
- 反例 smoke（安全触发路径）：
  - 凭据脱敏：含 `${MY_KEY}` 的 server，`resolveServersForRun` env 含真实值但 `SK.RuntimeLog` 脱敏、`readRegistrations` 视图不带真实值、缺失键 `credentialResolved=false`（AC-2/16）。
  - 边界断言：C9 无 `callMcpTool`/无注入/无起 fork（AC-6/13）——用类型/接口断言证明缺失这些方法。
- 适配器可替换（AC-15）：全部用例跑在内存假端口上全绿，证明核心不依赖 `NodeMcpAdapter`/`FsSkillAdapter`。
- 静态检查（AC-14）：对 `plugin-mcp/` 核心包做禁用 import 扫描（`fs`/`path`/`os`/`@modelcontextprotocol/sdk`/`better-sqlite3`/`@nestjs/*`）0 命中。
- 集成 smoke（真实文件 + 真实/内存 MCP server，可选）：临时目录造 `.mcp.json` + SKILL.md，端到端验证 controller 返回的 code、HTTP 状态、以及探测的 connected/failed 状态与工具数。
