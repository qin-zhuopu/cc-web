---
title: 史诗与故事 — C9 PluginMCP 插件与 MCP
context: C9 · PluginMCP
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C9 · PluginMCP（插件与 MCP）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C9 核心包（domain + ports），零框架/零 fs/sdk/db | FR-1~5 类型基础、NFR-1 |
| E2 MCP 注册与合并 | 多来源合并 + overrides + 凭据解析 + 两视图分离 | FR-1 |
| E3 MCP 连接探测 | 注册期能力探测（连接 + listTools + 状态），非运行时调用 | FR-2 |
| E4 自动批准策略与外部 MCP | fail-closed + 不看前缀 + 来源可审计的策略信号 | FR-3 |
| E5 Skill 三语义加载 | 可用描述 vs 加载正文分离（反假红线）+ 全字段解析 | FR-4 |
| E6 供给聚合与适配器 | RunSupply 聚合 + NodeMcp/FsSkill/DbCredential 适配器 + 可替换验证 | FR-5、FR-4.2 |
| E7 NestJS 接线与错误映射 | Module/Controller + 错误码→HTTP + i18n + 脱敏 + 凭据不外泄 | DI、NFR-2/5/6 |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `McpServerConfig`（对齐现有 `MCPServerConfig`）/ `McpTransportType` 值对象；env 可含 `${...}` 占位符（解析前）。**AC**：类型往返不丢字段。（FR-1.1）
- **S1.2** 定义 `McpServerRegistration` 聚合（config + effectiveEnabled + source + credentialResolved + credentialKeysMissing），不变量 `credentialResolved === (missing.length===0)`，**真实凭据绝不进任何字段**。**AC**：类型层无凭据值字段。（FR-1.2/1.3/NFR-2）
- **S1.3** 定义 `ConnectionStatus`（state=connected/connecting/failed/disabled/unknown，toolCount 可选留空）/ `McpToolDescriptor`（qualifiedName `mcp__x__y`）。**AC**：未探测=unknown、未连接 toolCount 留空，不冒充。（FR-2.1/2.4/§0.2）
- **S1.4** 定义 Skill 三视图类型：`SkillDefinition`（全字段含 body）/ `SkillDescriptor`（描述，**无 body**）/ `LoadedSkill`（正文 prompt+fork+allowedTools）。**AC**：Descriptor 类型不含 body 字段（编译期切断混淆）。（FR-4.1/4.2/§0.1）
- **S1.5** 定义结构化错误 `McpError`(5 类) / `SkillError`(3 类)，均带 `messageKey`(`c9.*`)，`meta` 不含凭据。**AC**：错误无硬编码 message。（NFR-5/6）
- **S1.6** 定义驱动端口 `RegisterMcpServerUseCase` / `LoadSkillUseCase` / `GetRunSupplyUseCase` 与出站端口 `McpServerPort` / `SkillLoaderPort` / `CredentialResolverPort`。**AC**：核心 `index.ts` 只导出端口与领域类型。（FR-1~5）
- **S1.7** 建立禁用 import 静态扫描。**AC-14**：`plugin-mcp/` 对 `fs`/`path`/`os`/`@modelcontextprotocol/sdk`/`better-sqlite3`/`@nestjs/*` 0 命中。（NFR-1）

## E2 · MCP 注册与合并

- **S2.1** `McpServerPort.readRegistrations` 契约 + 核心消费：三来源合并（`.claude.json`/`settings.json`/`.mcp.json`），后来源覆盖前来源，标 `source`。**AC-1**：合并顺序正确。（FR-1.1）
- **S2.2** `mcpServerOverrides` 有效 enabled：UI 持久覆盖优先于文件 `enabled`，产出 `effectiveEnabled`。**AC-1**：UI 关掉的项 `enabled=false`。（FR-1.2）
- **S2.3** `${...}` 凭据解析经 `CredentialResolverPort`：缺失键→`credentialResolved=false` + `credentialKeysMissing`，值不冒充。**AC-2**：缺失键不显成功。（FR-1.3）
- **S2.4** 两视图分离：`listAll`（含禁用+状态，供 UI）vs `resolveServersForRun`（仅启用+凭据解析，供 C2）。**AC-3**：禁用项只在前者。（FR-1.5）
- **S2.5** 工作目录感知：`.mcp.json` 用传入 `workingDirectory` 而非 `process.cwd()`。**AC-4**：两工作目录得不同 server 集（防现有坑回归）。（FR-1.6）
- **S2.6** 注册/更新/删除/启停用例（`register`/`remove`/`setEnabled`），写回约定来源。**AC-1**：读回 enabled 与生效一致。（FR-1.4）

## E3 · MCP 连接探测

- **S3.1** `McpServerPort.probe` 契约：按 type（stdio/sse/http）建连 + `listTools`，产出 state + toolCount + tools + 脱敏 error。**AC-5**：connected + toolCount 等于 listTools 长度 + 限定名 `mcp__x__y`。（FR-2.1）
- **S3.2** 探测失败降级：连接/listTools 异常经 `SK.ErrorClassifier` 归类、`state=failed`、error 经 `SK.Redactor` 脱敏记日志，不抛不中断。**AC-5**：连不上→failed，不影响其它 server。（FR-2.3）
- **S3.3** 探测边界：`probe` 只连+列，**无 `callMcpTool`**。**AC-6**：断言探测不触发任何工具执行（探测≠调用）。（FR-2.2）

## E4 · 自动批准策略与外部 MCP

- **S4.1** 迁入 `summarizeExternalMcp` / `collectMcpConfigProbes` 纯函数（承接现有 `external-mcp.ts`）：fail-closed（unreadable→undetectable→present）。**AC-7**：不可读配置→present+undetectable。（FR-3.2）
- **S4.2** `computeAutoApprove` 纯函数：每条策略带来源 breadcrumb（server+certainty），无来源不 `autoApprove=true`；**禁止前缀信任**（trustedRegistry 显式来源，不看名字）。**AC-7/8**：`codepilot-vault` 不豁免、无来源不批准。（FR-3.1/3.3）
- **S4.3** `describeAutoApprove` 用例：聚合 `probeConfigSources` + 显式 server 名 → externalStatus + policies，供权限链路消费（C9 不放行）。**AC-8**：策略信号可审计。（FR-3.1/3.4）

## E5 · Skill 三语义加载

- **S5.1** 迁入 SKILL.md 解析纯函数（承接 `skill-parser`）：`splitFrontmatter` / `parseSkillDefinition`（全字段 allowed-tools/when_to_use/context/arguments/model/effort/user-invocable）。**AC-10**：全字段解析正确。（FR-4.3）
- **S5.2** `substituteSkillArgs` 纯函数（承接 `skill-executor`）：`$arg`/`${arg}`/`${CLAUDE_SKILL_DIR}` 替换。**AC-10**：模板变量被替换。（FR-4.2）
- **S5.3** `listAvailable`（可用描述视图）：`discoverRaw` → `parseSkillDefinition` → `SkillDescriptor`（**丢弃 body**）；项目级优先、按名去重。**AC-9**：去重+项目级胜出、每项不含 body。（FR-4.1）
- **S5.4** `loadBody`（加载正文视图）：`readSkillRaw`（未找到→`skill_not_found`）→ parse → 校验 required 参数（缺→`missing_required_arg`）→ 替换 → `LoadedSkill{prompt,fork,allowedTools,model,effort}`。**AC-10**：正文+fork+allowedTools 正确。（FR-4.2/4.5）
- **S5.5** **反假数据核心反例**：同工作目录，`availableSkills` 计数在普通请求 vs 加载某 Skill 请求间**不变**；`loadBody` 只在后者返回正文。**AC-11**：普通路径 loaded=0、触发路径 loaded=1，availableSkills 恒定；两语义返回体类型不同。（§0.1）
- **S5.6** 缓存失效：`SkillLoaderPort.invalidate`（承接 `invalidateSkillCache`）；删 SKILL.md 后 invalidate → discover 不再含。**AC-12**：缓存不显已删项。（FR-4.4）
- **S5.7** **加载边界**：`loadBody` 只到 `LoadedSkill` 为止，C9 无"注入对话""起 fork 子 agent"能力。**AC-13**：断言无此方法/无对 C2/C3 的调用。（FR-4.5）

## E6 · 供给聚合与适配器

- **S6.1** `GetRunSupplyUseCase.getRunSupply`：聚合 `resolveServersForRun` + `availableSkills` + `externalMcpStatus`，严格只含供给、不含"已调用/已执行"。**AC**：RunSupply 无执行语义字段。（FR-5.1/5.2）
- **S6.2** 实现 `NodeMcpAdapter`（承接 `mcp-loader` + `mcp-connection-manager`）：readRegistrations/writeServer/deleteServer/writeEnabledOverride/probe/probeConfigSources/resolveServersForRun。**AC-1/4/5**：全套注册/探测经真实文件+MCP SDK。（FR-1/2）
- **S6.3** 实现 `FsSkillAdapter`（承接 `skill-discovery`）：discoverRaw/readSkillRaw/invalidate，多目录扫描+子目录 SKILL.md 探测+去重缓存；**解析不在适配器**（只吐原文）。（FR-4.1/4.2）
- **S6.4** 实现 `DbCredentialResolver`（承接 `getSetting`）：`resolveEnv` 解析 `${SETTING_KEY}`；**唯一接触真实凭据处**，结果只进 Runtime 交付路径。**AC-2/16**：凭据不进日志/可见字段。（FR-1.3/NFR-2）
- **S6.5** 内存假 `McpServerPort`/`SkillLoaderPort`/`CredentialResolverPort`（可编程连接失败/凭据缺失/不可读配置）供单测。**AC-15**：全部用例跑在假端口上绿，证明核心不依赖真实适配器。（NFR-7）

## E7 · NestJS 接线与错误映射

- **S7.1** `PluginMcpModule`：imports SharedKernelModule，provides 三驱动端口+三出站端口，exports `RegisterMcpServerUseCase`/`McpServerPort`/`SkillLoaderPort`/`GetRunSupplyUseCase`（`CredentialResolverPort` 不导出）。**AC**：C2 可跨 Module 注入两出站端口。（DI 章节）
- **S7.2** `PluginMcpController`：MCP servers CRUD + probe + auto-approve；skills listAvailable（描述）+ loadBody（正文）+ invalidate。（DI 章节）
- **S7.3** 错误码→HTTP：`McpError`/`SkillError.code` → 400/404/409/500；`messageKey` 经 `SK.TranslationPort` 渲染。**AC**：各 code 映射正确。（NFR-5/6）
- **S7.4** 凭据不外泄接线：控制器绝不把真实凭据序列化进任何响应；`readRegistrations` 只回 `credentialResolved`/`credentialKeysMissing`。**AC-2/16**：响应/日志无凭据明文。（NFR-2）
- **S7.5** 日志脱敏：注册/探测/加载关键路径经 `SK.Redactor` 脱敏凭据段与绝对路径后写 `SK.RuntimeLog`（source=`c9.mcp`/`c9.skill`）。**AC-16**：日志中凭据/用户名段不明文。（NFR-2）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S2.1, S2.2, S2.6, S6.2 |
| AC-2 | S2.3, S6.4, S7.4 |
| AC-3 | S2.4 |
| AC-4 | S2.5, S6.2 |
| AC-5 | S3.1, S3.2, S6.2 |
| AC-6 | S3.3 |
| AC-7 | S4.1, S4.2 |
| AC-8 | S4.2, S4.3 |
| AC-9 | S5.3 |
| AC-10 | S5.1, S5.2, S5.4 |
| AC-11 | S5.5 |
| AC-12 | S5.6 |
| AC-13 | S5.7 |
| AC-14 | S1.7 |
| AC-15 | S6.5 |
| AC-16 | S6.4, S7.4, S7.5 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + 注册合并）**：E1 全部、E2 全部。产出零框架 C9 核心 + 三视图/三端口接口 + 静态扫描门禁 + MCP 多来源合并/覆盖/凭据解析（两视图分离，AC-1~4）。
- **Sprint 2（探测 + 策略 + Skill）**：E3、E4、E5 全部。产出注册期探测（AC-5/6）、fail-closed 不看前缀的自动批准策略（AC-7/8）、Skill 三语义分离（反假核心 AC-11）与全字段解析（AC-9/10/12/13），全用假端口。
- **Sprint 3（聚合 + 适配器 + 接线）**：E6、E7 全部。产出 RunSupply 聚合 + NodeMcp/FsSkill/DbCredential 适配器 + 内存假端口可替换验证（AC-15）+ NestJS Module/Controller + 错误映射 + 凭据不外泄 + 脱敏日志（AC-2/16）。

## 定义完成 (DoD)

- 对应 FR/AC 单测与反例 smoke 全绿（`npm run test` 层，用内存假端口，无需真实文件/MCP server）。
- 禁用 import 静态扫描 0 命中（AC-14）。
- **反假数据红线断言通过**：`availableSkills` 计数恒定 vs `loadBody` 触发路径返回正文（AC-11）；`SkillDescriptor` 无 body 字段（编译期）。
- **凭据不外泄断言通过**：`resolveServersForRun` env 含真实值但日志脱敏、`readRegistrations` 视图/HTTP 响应不带真实凭据、缺失键 `credentialResolved=false`（AC-2/16）。
- **自动批准 fail-closed 断言通过**：不可读配置→undetectable→present、`codepilot-vault` 不因前缀豁免、无来源不 autoApprove（AC-7/8）。
- **边界断言通过**：C9 无 `callMcpTool`（AC-6）、无 Skill 注入/起 fork（AC-13）；核心不 import fs/sdk/db（AC-14）。
- 适配器可替换验证通过：核心用例跑在内存假端口上全绿（AC-15）。
- 边界纪律：C9 不出现"MCP 工具被 AI 调用的编排"/会话/Provider auth/文件浏览/子 agent 概念。
