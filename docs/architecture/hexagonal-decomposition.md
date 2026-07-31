# CodePilot Web — 六边形架构主拆解文档

> 本文件是整个重构工程的**基线**：定义限界上下文、六边形分层、迁移顺序。
> 每个上下文的全套 BMad 文档见 `docs/contexts/<ctx>/`。
> 进度见 `docs/bmad-progress/progress.md`。

## 1. 目标形态

**本机运行的 Web 应用**（不是远程 SaaS，不是 Electron 桌面端）：

```
用户浏览器 (localhost:5173, Vite React SPA)
   ↕ HTTP / SSE
NestJS 后端 (localhost:3001，跑在用户本机)
   ↕
本地文件系统 / better-sqlite3 / Claude SDK / Codex （本机进程直接访问）
```

因为后端在本机 localhost：
- ✅ 本地文件访问 —— NestJS 本地进程照读
- ✅ better-sqlite3 —— 单用户单机，不换 Postgres
- ✅ 凭据 —— 继续用 `~/.codepilot/`，不做多租户认证

## 2. 六边形分层铁律

依赖方向永远指向核心。核心定义接口，适配器实现接口。
`packages/core` 里禁止出现 `import { anthropic }`、`import Database from 'better-sqlite3'`、`import { NestjsXxx }`。

```
[驱动适配器]  HTTP Controller / SSE / IPC        ← 外部主动调用
     ↓
[驱动端口 = UseCase 接口]
     ↓
[应用核心] Domain Model + Use Cases（纯逻辑，零框架）
     ↓ 依赖倒置
[驱动端口 = 出站接口]
     ↓
[被驱动适配器] SQLite / Claude SDK / 文件系统 / IM API  ← 系统主动调用外部
```

NestJS 的 Module/Provider/DI 充当"接线盒"（替代手写 composition-root）。

## 3. 限界上下文（10 + 共享内核）

| # | 上下文 | 职责 | CodePilot 现有落点 |
|---|--------|------|-------------------|
| SK | **Shared Kernel** | 错误分类/平台检测/脱敏/i18n/日志 | error-classifier, platform, runtime-log |
| C1 | **Conversation** 会话 | 会话/消息生命周期 | db.ts(部分), chat API |
| C2 | **AgentRuntime** 运行时 | AI 调用编排、多 Runtime、流式 | claude-client, stream-session-manager, conversation-registry |
| C3 | **SubagentOrchestration** | logical run / attempt / durable phase | subagent_runs, subagent_run_events |
| C4 | **MediaGeneration** | 图片生成、批量任务 | image-generator, job-executor |
| C5 | **Bridge** IM桥接 | 外部 IM 接入会话 | lib/bridge/ |
| C6 | **Channel** 渠道 | 结构化渠道插件合约 | lib/channels/ |
| C7 | **ProviderManagement** | Provider 配置/诊断/Auth | provider-doctor, api_providers |
| C8 | **Workspace** | 文件浏览/预览 | files.ts |
| C9 | **PluginMCP** | MCP server / Skill | plugins |
| C10 | **Task** | TodoWrite 任务项 | tasks |

## 4. 迁移顺序（绞杀者模式，从低风险试点起步）

1. **SK Shared Kernel** — 无业务依赖，最先，给所有上下文打底
2. **C7 Provider** — 收益清晰、blast radius 最小，作试点验证模式
3. **C1 Conversation** — 核心数据模型
4. **C2 AgentRuntime** — 最复杂、最多 guardrail，等模式成熟再动
5. **C3 Subagent** — 依赖 C2
6. **C8 Workspace** — 相对独立
7. **C9 PluginMCP**
8. **C10 Task**
9. **C4 Media**
10. **C6 Channel** — Bridge 依赖它
11. **C5 Bridge** — 依赖最多，最后

## 5. 每个上下文的 BMad 文档产出

存 `docs/contexts/<ctx>/`：
1. `product-brief.md` — 产品简报（解决什么问题、边界、用户价值）
2. `prd.md` — 需求（功能需求 + 非功能需求 + 验收标准）
3. `architecture.md` — 六边形架构（domain model / driving ports / driven ports / adapters，到函数签名级）
4. `epics-stories.md` — 史诗与故事拆分（可排期的开发任务）

## 6. 目标目录结构

```
codepilot-web/
├── packages/core/           # 六边形核心（零框架）
│   ├── shared-kernel/
│   ├── conversation/  agent-runtime/  subagent/ ...
│   └── (每个: domain/ ports/{driving,driven}/ usecases/)
├── apps/
│   ├── api/                 # NestJS：每上下文一个 Module，Controller + Adapter
│   └── web/                 # Vite + React SPA
└── docs/
    ├── architecture/        # 顶层架构 + 本拆解 + 映射 + 索引
    ├── contexts/<ctx>/       # 各上下文 BMad 文档
    └── bmad-progress/        # 进度总账
```
