---
title: 产品简报 — C9 PluginMCP 插件与 MCP
context: C9 · PluginMCP
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C9 · PluginMCP（插件与 MCP）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 一句话定位

C9 是 CodePilot Web 里负责**注册与管理 MCP server、发现与加载 Skill** 的限界上下文。它把"用户配了哪些 MCP server""这个工作目录下有哪些可用 Skill""某个 Skill 的正文是什么"这套**能力清单与内容供给**收口成一组可测、可审计的端口——但它**不负责 MCP 工具怎么被 AI 调用、Skill 怎么被注入到对话里执行**（那属 C2 AgentRuntime 的编排职责）。C9 只回答"有什么、长什么样、启用没启用、自动批准策略是什么"，不回答"这一轮 AI 实际调了它没有、结果是什么"。

## 2. 解决什么问题

CodePilot 从 Electron 桌面端重构为"本机运行的 Web 应用"后，MCP server 的注册（读多来源配置文件、解析 `${...}` 凭据占位符、合并 enable/disable 覆盖、探测连接与工具清单）与 Skill 的发现加载（扫多个技能目录、解析 SKILL.md frontmatter、去重、按优先级覆盖）这两条能力供给链路，散落在 `mcp-loader.ts` / `mcp-connection-manager.ts` / `skill-discovery.ts` / `skill-parser.ts` / `skill-executor.ts` / `permission/external-mcp.ts` 等多个工具模块里，直接被 route/claude-client 等消费方调用。重构的任务是把它们收口进六边形架构，让"注册与加载"与"调用与编排"（C2）彻底分离。

痛点集中在：

- **配置来源多、合并规则易错**：MCP server 配置来自 `~/.claude.json`、`~/.claude/settings.json`、`<cwd>/.mcp.json` 三处，还有 `mcpServerOverrides` 的 enable/disable 持久覆盖、`${...}` 凭据占位符解析。合并顺序、覆盖优先级、占位符解析口径若在不同消费方各写一遍，就会出现"UI 显示启用、SDK 实际没加载"这类状态失真（现有 `loadAndMerge` 与 `loadProjectMcpServers` 已经踩过 cwd 不一致的坑）。
- **凭据占位符是敏感面**：`${API_KEY}` 这类占位符要从 CodePilot DB 解析出真实凭据。这些值绝不能进日志、进 UI 明文、进跨上下文传递。
- **自动批准策略语义模糊**：MCP 工具的自动批准（auto-approve）直接关系到"AI 能不能不经用户点头就调外部工具"。哪些 server / 工具属于可自动批准、哪些必须人工确认、外部 MCP 的存在如何影响 `auto_review` 能力档位——这套策略必须由一个地方权威声明并给出可审计来源，不能靠散落的前缀猜测（现有 `external-mcp.ts` 已明确"禁止基于名字前缀的信任"）。
- **Skill 三种语义被混为一谈（反假数据头号风险）**：用户/UI 看到的"Skills"到底是指"发现了哪些可用 Skill（名字+描述）"、"本轮实际加载了哪个 Skill 的正文"、还是"AI 实际调用某 Skill 跑出来的结果"？这三者来源完全不同、数量完全不同。若 UI 用一个笼统的 "Skills: 12" 糊在一起，用户会误以为"这一轮用了 12 个 Skill"，而真相可能是"发现 12 个、本轮加载 0 个、调用 0 个"。这是 CLAUDE.md「语义验收与反假数据」点名的 C9 核心风险。

## 3. 目标用户与价值

- **单机开发者用户**：在插件页管理自己的 MCP server（增删、启停、看连接状态与工具数、配 JSON），在技能页浏览、创建、编辑本地 Skill。C9 保证他看到的"启用状态""工具数""可用 Skill 列表"都来自实测或明确标注的来源，不糊数字。
- **消费 C9 的其他上下文（主要是 C2）**：C2 在发起一轮 AI 调用时，需要知道"这一轮该把哪些 MCP server 交给 Runtime""这个工作目录有哪些可用 Skill 描述可以喂给模型做选择""用户点了某个 Skill 后它的正文是什么"。C2 通过 C9 的 `McpServerPort` / `SkillLoaderPort` 拿到这些**供给数据**，然后由 **C2 自己**负责把它们接进 Runtime、编排调用、收集结果。C9 只供给，不编排。

价值主张：**把"有哪些 MCP server / Skill 可用、它们长什么样、启用没启用、自动批准策略是什么"收口成一份来源可追、语义清晰、凭据脱敏的能力清单，让消费方（尤其 C2）拿到诚实的供给数据，而不必各自重复解析配置、各自猜测策略。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C9 契约：

- **拥有**：
  - **MCP server 注册**：从多来源配置合并 MCP server 定义、解析 `${...}` 凭据占位符、应用 enable/disable 覆盖、探测连接状态与工具清单（listTools）、声明自动批准策略。
  - **Skill 加载**：从多技能目录发现 SKILL.md、解析 frontmatter（name/description/allowed-tools/when_to_use/context/arguments/model/effort/user-invocable）、按优先级去重、加载指定 Skill 的正文并做参数模板替换（供消费方注入）。
- **不包含**：
  - **MCP 工具被 AI 调用的编排** —— "这一轮把哪些 MCP server 传给哪个 Runtime""AI 请求调某工具时的 canUseTool 判定与执行""Skill 正文注入对话后如何驱动 AI 跑" 全部属 **C2 AgentRuntime**。C9 只提供"可注册/可加载的供给数据"，不提供"已调用/已执行的结果"。
  - **权限判定与经纪**：自动批准**策略**（哪些应被自动批准）由 C9 声明为供给数据；但一次实际调用**是否放行**的运行时判定与人工确认经纪属权限链路（C5.PermissionBroker + C2 的 canUseTool），C9 不做运行时放行决策。
  - 会话/消息（C1）、Provider 配置（C7，MCP 的 `${...}` 凭据解析读的是 CodePilot 设置项，与 C7 的 Provider auth 是两条线）、文件浏览/预览（C8）、子 agent 编排（C3）。
- **依赖端口（只引用，不重写）**：
  - 契约表声明 C9 **依赖 SK**：`SK.RuntimeLog`（记注册/加载日志）、`SK.Redactor`（脱敏日志里的凭据与绝对路径）、`SK.ErrorClassifier`（把配置读取/连接异常归类）、`SK.TranslationPort`（错误文案 i18n）、`SK.IdGenerator`（如需为注册项生成稳定 id）。均为横切注入，不重写。
- **对外提供端口**：
  - `RegisterMcpServerUseCase` —— 注册/更新/启停/查询 MCP server + 声明自动批准策略的驱动端口。
  - `McpServerPort` —— 出站端口，抽象"如何真正读配置来源、探测连接、列工具"，由 `NodeMcpAdapter` 实现（本机读文件 + MCP SDK 连接），供 C2 消费"本轮该用哪些 server"。
  - `SkillLoaderPort` —— 出站端口，抽象"如何发现技能目录、解析 SKILL.md、加载正文"，由 `FsSkillAdapter` 实现，供 C2 消费"可用 Skill 描述"与"指定 Skill 正文"。

## 5. 与 CodePilot 现有实现的对应

| C9 概念 | 现有落点 |
|---|---|
| MCP 多来源合并 + 占位符解析 + enable 覆盖 | `src/lib/mcp-loader.ts`（`loadAndMerge` / `loadCodePilotMcpServers` / `loadAllMcpServers` / `loadProjectMcpServers`） |
| MCP 连接探测 + listTools + 状态 | `src/lib/mcp-connection-manager.ts`（`connectServer` / `syncMcpConnections` / `getMcpStatus` / `getAllMcpTools`；`McpToolDefinition`） |
| MCP server 配置类型 | `src/types/index.ts` `MCPServerConfig`（command/args/env/type/url/headers/enabled）、`MCPConfig` |
| 外部 MCP 存在探测 + 自动批准策略输入 | `src/lib/permission/external-mcp.ts`（`probeExternalMcp` / `summarizeExternalMcp` / `collectMcpConfigProbes`；`ExternalMcpStatus` 的 `configured` / `undetectable` certainty 语义） |
| Skill 发现（多目录扫描 + 去重 + 缓存） | `src/lib/skill-discovery.ts`（`discoverSkills` / `getSkill` / `invalidateSkillCache`） |
| SKILL.md 解析（frontmatter + body） | `src/lib/skill-parser.ts`（`parseSkillFile`；`SkillDefinition` / `SkillArgument`） |
| Skill 正文准备（参数替换 + inline/fork） | `src/lib/skill-executor.ts`（`prepareSkillExecution`；`SkillExecutionResult`） |
| MCP / 插件 / 技能 UI | `src/components/plugins/*`、`src/components/skills/*` |

> 现有实现把"加载/注册"（loader / discovery / parser）与"连接/调用"（connection-manager 的 `callMcpTool`、executor 被 agent loop 消费）放在相邻模块里，边界模糊。C9 只拥有**注册与加载**：`callMcpTool`（实际调工具）、Skill 正文注入对话后的驱动，都属 C2。C9 的 `McpServerPort.probe` 可以探测"某 server 能连上、有几个工具"（这是**注册期的能力探测**，用于 UI 显示状态与工具数），但"AI 请求调用某工具→执行→拿结果"不在 C9。这条线要在架构文档里画清楚，避免 C9 越界成"MCP 运行时"。

## 6. 成功标准（可度量）

- **S1 注册闭环**：用户能在插件页增删/启停 MCP server，配置持久化到约定来源，`RegisterMcpServerUseCase` 读回的启用状态与实际生效状态一致（不出现"UI 启用、实际未加载"）。
- **S2 凭据脱敏**：MCP server 的 `${...}` 占位符解析出的真实凭据，绝不出现在 `SK.RuntimeLog`、UI 明文、跨上下文传递里；日志中的凭据段经 `SK.Redactor` 脱敏（反例断言）。
- **S3 Skill 三语义分离（反假数据核心）**：C9 对外明确区分 `availableSkills`（可用描述，来自 discover）、`loadSkillBody`（本轮加载正文，来自 parse+参数替换）两类供给；"实际调用结果"这一类**根本不由 C9 产出**（属 C2）。任何 UI 展示 Skill 数字都必须标注是哪一类，禁止用一个笼统计数糊三者。
- **S4 自动批准策略可审计**：MCP 工具的自动批准策略由 C9 权威声明，每条带来源 breadcrumb（来自哪个 server、certainty 是 configured 还是 undetectable）；外部 MCP 存在时对 `auto_review` 能力档位的影响 fail-closed（宁可多报"存在"，不漏报），且不基于名字前缀信任。
- **S5 边界纯净**：C9 核心包不 import `fs`/`path`/`os`、不 import `@modelcontextprotocol/sdk`、不 import `better-sqlite3`/`@nestjs/*`；全部文件读取、MCP 连接、DB 凭据解析经 `McpServerPort`/`SkillLoaderPort` 注入。核心不出现"AI 如何调工具/跑 Skill"的编排概念。
- **S6 编排归属清晰**：C9 只供给 server 清单与 Skill 描述/正文；"本轮传哪些 server 给 Runtime""canUseTool 放行判定""Skill 正文注入后驱动 AI"全部在 C2/C5，C9 无这些逻辑（边界纪律自检通过）。

## 7. 非目标（明确排除）

- 不做 MCP 工具的**实际调用与结果收集**（`callMcpTool` 的运行时调用、canUseTool 放行、工具结果回填对话）——属 C2。
- 不做 Skill 的**执行编排**（inline 正文注入对话后如何驱动 AI、fork 模式如何起子 agent）——注入点与驱动属 C2/C3；C9 只到"把正文和 fork 标志、allowedTools 准备好"为止。
- 不做运行时权限放行决策与人工确认经纪（属 C5.PermissionBroker + C2 canUseTool）；C9 只声明"自动批准策略"作为供给数据。
- 不做 Provider 配置/诊断/Auth（属 C7）；MCP 的 `${...}` 凭据解析读的是通用 CodePilot 设置项，不与 C7 的 Provider auth 混。
- 不做 MCP server 的市场/远程分发、Skill marketplace 的后端（本期只管本机已存在的配置与技能文件；marketplace UI 若接入按只读展示对待）。
- 不替 SK 重新实现脱敏 / 错误分类 / 日志 / i18n。

## 8. 关键风险与假设

- **风险（反假数据头号）**：Skill 三语义混淆。必须在类型层就把 `availableSkills`（描述）与 `loadedSkillBody`（正文）分成不同返回体，并在文档、UI 文案、字段命名上强制区分；"调用结果"不在 C9 出现。对应 PRD §0 语义契约表。
- **风险（安全）**：凭据泄漏。`${...}` 解析出的真实凭据是敏感面，必须只在 `McpServerPort` 适配器边界内解析、只在交给 Runtime 的那一刻存在，绝不进日志/UI/跨上下文；`SK.Redactor` 脱敏是最后防线。
- **风险（安全）**：自动批准策略被误信。外部 MCP 的自动批准直接关系"AI 能不能不经用户点头调外部工具"。必须 fail-closed（配置不可读→按"存在"处理）、不基于名字前缀信任（承接 `external-mcp.ts` 的 review round #5 结论）、每条策略带 certainty 来源。
- **风险（状态失真）**：配置多来源合并口径不一致。合并顺序、`mcpServerOverrides` 覆盖优先级、cwd 用哪个（process.cwd() vs 请求的真实工作目录）必须由 `McpServerPort` 单一收口，避免现有 `loadAndMerge` / `loadProjectMcpServers` 分叉再现。
- **假设**：本机 NestJS 进程拥有读取配置文件与技能目录的操作系统权限（单机形态成立）；工作目录由上层（会话/请求）给定。
- **假设**：`MCPServerConfig` / `SkillDefinition` 领域类型由 C9 拥有并从 C9 桶文件导出；现有 `@/types` 的 `MCPServerConfig` 与 `skill-parser` 的 `SkillDefinition` 在重构后迁入 C9 domain。
- **假设**：MCP 连接探测（`probe`）是**注册期能力探测**（"能连上吗、几个工具"），与 C2 的运行时工具调用是两条线；本期 C9 只做探测，不做调用。
