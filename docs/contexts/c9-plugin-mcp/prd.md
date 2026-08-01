---
title: 需求文档 (PRD) — C9 PluginMCP 插件与 MCP
context: C9 · PluginMCP
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C9 · PluginMCP（插件与 MCP）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C9 存在大量"用户/消费方可见的能力清单与状态"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能。C9 最容易误导的是 **Skill 的三种语义** 与 **MCP 的启用/连接状态**——它们来源不同、数量不同，绝不能糊在一个笼统计数里。

### 0.1 Skill 三语义（头号反假红线）

CLAUDE.md 点名："`Skills` 必须区分'可用 Skill 描述'、'本轮加载的 Skill 正文'、'实际调用的 Skill 结果'。" C9 的职责边界正好切在这三者之间：

| 语义 | 用户/消费方会怎么理解 | 真实来源 breadcrumb | 归属 |
|---|---|---|---|
| **可用 Skill 描述** `availableSkills` | 这个工作目录有哪些 Skill 可以用（名字+描述+触发条件） | `SkillLoaderPort.discover()` → 扫描 `.claude/skills` 等目录 → `parseSkillFile` 的 name/description/whenToUse | **C9 拥有** |
| **本轮加载的 Skill 正文** `loadedSkillBody` | 用户点了/模型选了某个 Skill，它的完整 prompt 正文是什么 | `SkillLoaderPort.loadBody(name, args)` → parse 的 body + 参数模板替换 | **C9 拥有** |
| **实际调用的 Skill 结果** | 这一轮 AI 真的用了这个 Skill、跑出来什么 | 由 C2 在 Runtime 里注入正文/起 fork 后的执行事件 | **C2 拥有，C9 不产出** |

**红线**：C9 对外类型必须把 `availableSkills`（描述数组）与 `loadedSkillBody`（单个正文）分成不同返回体，字段名自解释。"实际调用结果"这一类**根本不由 C9 返回**。任何 UI 展示 "Skills: N" 都必须标注 N 是"可用描述数"还是"本轮加载数"，禁止用一个数字暗示"本轮用了 N 个 Skill"。反例 smoke 必须验证：普通消息（loaded=0）vs 点了某 Skill 的消息（loaded=1）产生的 `loadedSkillBody` 不同，而 `availableSkills` 计数不变。

### 0.2 MCP 与其它可见字段

| 用户可见字段 | 语义（会怎么理解） | 真实来源 breadcrumb | 缺失/不确定来源时的降级 |
|---|---|---|---|
| MCP server `enabled` | 这个 server 现在是启用还是禁用 | 合并 `mcpServerOverrides` 覆盖后的实测有效值 | 无覆盖时用文件里的 `enabled`；均无按启用（对齐现有默认） |
| MCP server `connectionStatus` | 能不能连上、连接是否失败 | `McpServerPort.probe()` → MCP SDK `client.connect` 实测 | 未探测=`unknown`，不显假 `connected`；探测失败=`failed` + 脱敏 error |
| MCP server `toolCount` | 这个 server 提供几个工具 | `probe()` → `client.listTools()` 实测长度 | 未连接/未探测=留空（`undefined`），不显假 0 |
| MCP server `credentialResolved` | 凭据占位符解析成功没 | `${...}` → CodePilot 设置项是否命中 | 缺失键→标 `false`，不静默用空串冒充成功 |
| 自动批准策略 `autoApprove` | 这个 server/工具能否不经用户点头被调 | C9 策略声明 + `ExternalMcpStatus.certainty` | 来源不可读→certainty=`undetectable`→fail-closed 按"不可自动批准" |
| 外部 MCP 存在 `externalMcpPresent` | 有没有第三方 MCP 会进本轮工具面 | `probeExternalMcp` fail-closed 汇总 | 任何不确定→`present:true`（宁多报不漏报） |

**原则**：没有真实来源的字段一律隐藏 / 标 unsupported / 明确写"未探测/估算"。凭据的真实值**永不**作为可见字段返回，只返回 `credentialResolved` 布尔。

## 1. 功能需求 (Functional Requirements)

### FR-1 MCP server 注册与管理（`RegisterMcpServerUseCase`）
- FR-1.1 从多来源合并 MCP server 定义：`~/.claude.json`、`~/.claude/settings.json`、`<workingDir>/.mcp.json`（对齐现有 `loadAndMerge` 三来源），后来源覆盖前来源。合并顺序与优先级由 `McpServerPort` 单一收口，不在消费方各写一遍。
- FR-1.2 应用 `mcpServerOverrides` 的 enable/disable 持久覆盖：UI 层持久化的 per-server 启停状态优先于文件自身的 `enabled` 字段（对齐现有 loader 的覆盖精度），产出 `enabled` 的**有效值**。
- FR-1.3 解析 `${...}` 凭据占位符：`env` 值形如 `${SETTING_KEY}` 时从 CodePilot 设置项解析真实值；缺失键解析为空并标 `credentialResolved=false`（不静默冒充成功）。**解析出的真实凭据只在适配器边界内存在，不进领域返回体的可见字段、不进日志。**
- FR-1.4 注册/更新/删除/启停单个 MCP server：写回约定配置来源，写后 `RegisterMcpServerUseCase` 读回的 `enabled` 与实际生效一致（S1，防"UI 启用、实际未加载"）。
- FR-1.5 列出全部已注册 server（供 UI）与"本轮该用的 server"（供 C2 消费）两个视图分开：前者含禁用项与状态，后者只含启用且解析好凭据的 server（对齐现有 `loadAllMcpServers` vs `loadCodePilotMcpServers` / `loadProjectMcpServers` 的分工）。
- FR-1.6 工作目录感知：`<workingDir>/.mcp.json` 用**请求的真实工作目录**而非 `process.cwd()`（承接现有 `loadProjectMcpServers` 修复的坑），由调用方传入 `workingDirectory`。

### FR-2 MCP 连接探测（`McpServerPort.probe`，注册期能力探测）
- FR-2.1 探测单个 server：按 `type`（stdio/sse/http）建立连接、`listTools()` 拉工具清单，产出 `connectionStatus`（connected/connecting/failed/disabled/unknown）+ `toolCount` + 工具描述列表 + 脱敏后的 error。
- FR-2.2 探测是**注册期能力探测**，用于 UI 显示状态/工具数与自动批准策略计算；**不是 AI 运行时调用工具**（`callMcpTool` 属 C2）。探测结果不驱动任何 AI 行为。
- FR-2.3 探测失败优雅降级：连接/listTools 异常经 `SK.ErrorClassifier` 归类（NETWORK/PROCESS/TIMEOUT 等），`connectionStatus=failed`，error 经 `SK.Redactor` 脱敏后记 `SK.RuntimeLog`，不抛出中断整个列表探测。
- FR-2.4 工具限定名规范：工具以 `mcp__{serverName}__{toolName}` 限定名暴露（对齐现有 `McpToolDefinition.qualifiedName`），供消费方与自动批准策略引用。

### FR-3 自动批准策略与外部 MCP 探测（`RegisterMcpServerUseCase` 的策略声明）
- FR-3.1 声明每个 server / 工具的自动批准策略（`autoApprove: boolean` + 来源 breadcrumb），作为**供给数据**交消费方（C5 权限经纪/C2 canUseTool）判定，C9 不做运行时放行决策。
- FR-3.2 外部 MCP 存在探测 fail-closed：承接 `probeExternalMcp` / `summarizeExternalMcp` 语义——任何配置来源不可读→`certainty='undetectable'`→按"存在"处理；能看到 server→`certainty='configured'` 且可命名来源。宁可多报"存在"，不漏报。
- FR-3.3 **禁止基于名字前缀的信任**（承接 `external-mcp.ts` review round #5 P1）：所有到达策略计算的 server 名都来自用户可控来源，信任只能来自**来源**（是否 CodePilot 自身在进程内注册的可信 registry），绝不来自名字（如 `codepilot-*` 前缀）。
- FR-3.4 外部 MCP 存在时对 `auto_review` 能力档位的影响：若任何外部 MCP 可能进入本轮工具面，则该档位承诺的"凭据/账单/发布类工具被拦截"无法保证，策略据此收紧（对齐现有 external-mcp 模块的 gate 语义）。C9 只产出这个"存在/certainty/sources"信号，档位决策由权限链路做。

### FR-4 Skill 发现与加载（`SkillLoaderPort` + Skill 用例）
- FR-4.1 **发现可用 Skill 描述**（`availableSkills`）：扫描多技能目录（`<cwd>/.claude/skills`、`<cwd>/.claude/commands`、`~/.claude/skills`、`~/.claude/commands`、`~/.agents/skills`，对齐现有 `skill-discovery`），解析每个 SKILL.md 的 frontmatter，产出 `SkillDescriptor{ name, description, whenToUse, userInvocable, context, arguments }` 列表。项目级优先，按名去重（首个胜出）。
- FR-4.2 **加载指定 Skill 正文**（`loadedSkillBody`）：给定 skill 名 + 参数，解析该 SKILL.md 的 body，做参数模板替换（`$arg`/`${arg}` 与内建 `${CLAUDE_SKILL_DIR}`，对齐现有 `prepareSkillExecution`），产出 `LoadedSkill{ prompt, fork, allowedTools, model?, effort? }`。这是"本轮加载正文"，与"可用描述"是不同返回体。
- FR-4.3 SKILL.md 全字段解析：name/description/allowed-tools/when_to_use/context(inline|fork)/arguments/model/effort/user-invocable（对齐现有 `SkillDefinition`，不只 name+description）。
- FR-4.4 缓存与失效：发现结果按工作目录缓存，提供显式失效（技能文件变更后调用，对齐现有 `invalidateSkillCache`）。缓存不得让 UI 显示已删除的 Skill——失效语义要能被 UI 主动触发。
- FR-4.5 **加载正文到"准备好"为止**：C9 产出 `LoadedSkill`（正文 + fork 标志 + allowedTools），**不负责注入对话、不负责起 fork 子 agent**——注入点与驱动属 C2/C3。

### FR-5 能力清单聚合（供 C2 一次性取本轮供给）
- FR-5.1 提供一个聚合读端口，给定 `workingDirectory` 返回本轮供给快照：`{ mcpServersForRun, availableSkills }`，均带来源 breadcrumb。C2 据此接线 Runtime，不必自己重复解析配置/扫技能目录。
- FR-5.2 聚合快照严格区分供给类别，不混入任何"已调用/已执行"语义（那不是 C9 能产出的）。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/plugin-mcp/` 禁止 import `fs`/`path`/`os`、`@modelcontextprotocol/sdk`、`better-sqlite3`、`@nestjs/*`；全部文件读取、MCP 连接、DB 凭据解析经 `McpServerPort`/`SkillLoaderPort` 注入。SKILL.md 解析、frontmatter 拆分、参数替换等**纯字符串逻辑**以纯函数放核心（吃字符串、吐结构），真实文件 I/O 在适配器。
- NFR-2 **安全（凭据）**：`${...}` 解析出的真实凭据只在 `McpServerPort` 适配器内存在，只在交给消费方 Runtime 的那一刻传递，绝不进领域可见字段、不进 `SK.RuntimeLog`、不进 UI 明文、不跨上下文广播。日志中出现的凭据段与绝对路径经 `SK.Redactor` 脱敏。
- NFR-3 **安全（自动批准）**：策略计算 fail-closed（不确定→按最严处理）、不基于名字前缀信任、每条策略带 certainty 来源。宁可让用户多点一次确认，不可让外部工具被误自动批准。
- NFR-4 **状态诚实**：MCP 连接状态/工具数、Skill 计数必须来自实测或明确标注（见 §0）；未探测不显假 `connected`/假 `0`；Skill 三语义不混计。
- NFR-5 **错误统一**：配置读取/连接/解析底层异常经 `SK.ErrorClassifier` 归类；C9 自身业务错误用稳定 code + i18n messageKey（`c9.*`），UI 拿 code 而非裸 message。
- NFR-6 **i18n**：注册/加载/探测错误文案经 `SK.TranslationPort`，C9 只贡献自己的 message keys（`c9.*`）。
- NFR-7 **可测**：MCP 注册/探测、Skill 发现/加载均可用假 `McpServerPort`/`SkillLoaderPort`（内存配置、内存技能树、可编程连接失败/凭据缺失/不可读配置场景）做纯单元测试，无需真实文件/真实 MCP server。SKILL.md 解析、参数替换、自动批准策略、external-mcp 汇总为纯函数，表驱动测试。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.1/1.2）给定三来源配置 + `mcpServerOverrides`，`RegisterMcpServerUseCase` 列出的 server 合并顺序正确、启用有效值等于覆盖后的值（UI 关掉的项 `enabled=false`）。
- AC-2（FR-1.3/NFR-2）**凭据脱敏反例**：一个含 `${MY_KEY}` 的 server，解析后交给"本轮该用"视图的 env 含真实值，但 `SK.RuntimeLog` 里该值经 `SK.Redactor` 脱敏、不明文出现；`credentialResolved` 在键缺失时为 `false` 且 env 值不冒充成功。
- AC-3（FR-1.5）`listAll`（含禁用+状态）与 `serversForRun`（仅启用+凭据解析）两视图内容不同：禁用项只出现在前者。
- AC-4（FR-1.6）`.mcp.json` 用传入的 `workingDirectory` 读取，而非 `process.cwd()`；传两个不同工作目录得到不同 server 集（防现有 cwd 坑回归）。
- AC-5（FR-2.1/2.3）探测一个可连 server → `connectionStatus=connected` + `toolCount` 等于 listTools 长度 + 工具限定名 `mcp__x__y`；探测一个连不上的 server → `failed` + 脱敏 error，不抛、不中断其它 server 探测。
- AC-6（FR-2.2）**边界反例**：C9 无 `callMcpTool` 类"实际调用工具"能力；探测只连接+listTools，断言探测不触发任何工具执行。
- AC-7（FR-3.2/3.3）**fail-closed 反例**：一个不可读的配置文件 → `externalMcpPresent=true` 且 `certainty='undetectable'`；一个名为 `codepilot-vault` 的用户配置 server **不因前缀被豁免**，仍计入"存在"。
- AC-8（FR-3.1）自动批准策略每条带来源 breadcrumb（server 名 + certainty）；无来源的工具不得标 `autoApprove=true`。
- AC-9（FR-4.1）**Skill 可用描述**：扫含项目级+用户级同名 Skill 的目录 → `availableSkills` 按名去重、项目级胜出；每项含 name/description/whenToUse/userInvocable，**不含 body**（描述视图不带正文）。
- AC-10（FR-4.2）**Skill 正文加载**：`loadBody('foo', {arg:'x'})` → 返回 body 且模板变量被替换、`fork` 反映 context、`allowedTools` 反映 frontmatter；未知 skill → 结构化错误 `skill_not_found`。
- AC-11（FR-4.1/4.2/§0.1）**反假数据核心反例**：同一工作目录下，`availableSkills` 计数在"普通请求"与"加载了某 Skill 的请求"之间**不变**；而 `loadBody` 只在后者被调用并返回正文。断言两语义的返回体类型不同、数量语义不同——普通路径 loaded=0、触发路径 loaded=1，availableSkills 恒定。
- AC-12（FR-4.4）删除一个 SKILL.md 后调用 `invalidate` → 再次 `discover` 不再含该 Skill（缓存不显已删项）。
- AC-13（FR-4.5）**边界反例**：`loadBody` 只返回 `LoadedSkill{prompt,fork,allowedTools}`，C9 无"注入对话""起 fork 子 agent"能力（断言无此方法/无对 C2/C3 的调用）。
- AC-14（NFR-1）对 `plugin-mcp/` 核心包做禁用 import 静态扫描（`fs`/`path`/`os`/`@modelcontextprotocol/sdk`/`better-sqlite3`/`@nestjs/*`），0 命中。
- AC-15（NFR-7）用内存假 `McpServerPort`/`SkillLoaderPort` 跑通全部 FR 用例，证明 C9 核心不依赖 `NodeMcpAdapter`/`FsSkillAdapter`（换适配器不动核心）。
- AC-16（NFR-2）日志断言：注册/探测/加载写入 `SK.RuntimeLog` 的凭据与绝对路径经 `SK.Redactor` 脱敏，不明文出现。

## 4. 依赖与假设

- 依赖 SK 已交付：`RuntimeLog` / `Redactor` / `ErrorClassifier` / `TranslationPort` / `IdGenerator` 端口稳定（见 SK architecture §4）作为**横切**注入；契约 C9「依赖端口：SK」。C9 对其它**业务上下文**无依赖。
- C9 的消费方是 C2（`McpServerPort` 取本轮 server、`SkillLoaderPort` 取可用描述与正文）；C9 只**供给**，C2 负责**接线与编排**。自动批准策略信号供权限链路（C5/C2 canUseTool）消费。
- 假设工作目录由上层（会话/请求）给定并传入；C9 不决定"用哪个工作目录"（防 process.cwd() 坑）。
- 假设本机 NestJS 进程拥有读取配置文件、技能目录、建立 MCP 连接的操作系统权限（单机形态成立）。
- 假设 `MCPServerConfig`（现 `@/types`）与 `SkillDefinition`（现 `skill-parser`）领域类型由 C9 拥有并从 C9 桶文件导出；重构后迁入 C9 domain。
- 假设 MCP 凭据 `${...}` 读的是通用 CodePilot 设置项，与 C7 Provider auth 是两条线，不交叉。
