---
title: CodePilot Web — 顶层架构总览
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# CodePilot Web — 顶层架构总览

> 本文件是全套架构文档的入口。主拆解见 [hexagonal-decomposition.md](./hexagonal-decomposition.md)，边界契约见 [context-boundaries.md](./context-boundaries.md)，各上下文详见 [索引](./index.md)。
> 进度总账见 [../bmad-progress/progress.md](../bmad-progress/progress.md)。

## 1. 项目定位

CodePilot Web 是把现有 Electron 桌面应用 CodePilot 重构为**本机运行的 Web 应用**：

```
用户浏览器 (localhost:5173, Vite + React SPA)
   ↕ HTTP / SSE
NestJS 后端 (localhost:3001，跑在用户本机)
   ↕
本地文件系统 / better-sqlite3 / Claude SDK （本机进程直接访问；其他 AI agent 运行时为预留扩展点，未具名）
```

后端跑在本机 localhost，因此保留了桌面端"直读本地文件、用本地凭据、单用户单机 DB"的能力，同时获得 Web 的跨平台与前后端分离优势。

## 2. 架构风格：六边形（Ports & Adapters）

- **应用核心** `packages/core/*`：领域模型 + 用例，零框架依赖（禁止 import NestJS / SDK / better-sqlite3 / node:*）。
- **驱动适配器**（入站）：NestJS Controller / SSE / IM Gateway → 调用用例端口。
- **被驱动适配器**（出站）：SQLite Repository / Claude SDK Runtime / 文件系统 / IM SDK，实现核心定义的出站端口。其他 AI agent 运行时为预留扩展点（未具名）。
- **接线盒**：NestJS Module + DI 替代手写 composition-root，把适配器注入核心。

依赖方向永远指向核心。

## 3. 十一个限界上下文

| 编号 | 上下文 | 职责 | 核心对外端口 |
|------|--------|------|-------------|
| SK | Shared Kernel | 错误分类/平台/脱敏/i18n/日志/Clock/Id | ErrorClassifier, Redactor, Clock, IdGenerator, TranslationPort, RuntimeLog, Platform |
| C1 | Conversation | 会话/消息生命周期 | ManageSessionUseCase, AppendMessageUseCase, SetSessionTitleUseCase, SessionRepository, MessageRepository |
| C2 | AgentRuntime | AI 调用编排/多 Runtime/流式 | StartStreamUseCase, AbortStreamUseCase, AgentRuntimePort, TitleGenerator |
| C3 | SubagentOrchestration | logical run / attempt / durable phase | SpawnSubagentUseCase, SubagentRunRepository |
| C4 | MediaGeneration | 图片生成/批量任务 | GenerateImageUseCase, RunBatchJobUseCase, ImageGeneratorPort, MediaRepository |
| C5 | Bridge | IM 接入会话（编排层） | RouteInboundMessageUseCase, DeliveryPort, PermissionBrokerPort |
| C6 | Channel | 渠道插件合约/能力/渲染 | ChannelPluginPort<T>, ProbeChannelUseCase, RenderMessageUseCase, CardStreamController |
| C7 | ProviderManagement | Provider 配置/诊断/Auth | ConfigureProviderUseCase, DiagnoseUseCase, ProviderRepository |
| C8 | Workspace | 文件浏览/预览 | BrowseFilesUseCase, FileSystemPort |
| C9 | PluginMCP | MCP server 注册/Skill 加载 | RegisterMcpServerUseCase, McpServerPort, SkillLoaderPort |
| C10 | Task | TodoWrite 任务项同步 | SyncTasksUseCase, TaskRepository |

## 4. 跨上下文依赖图（已核对一致）

```
SK  ←  所有上下文（横切）

C2.AgentRuntimePort      ←  C3        （子 agent 复用运行时）
C2.TitleGenerator        ←  C1        （标题 AI 生成）
C5.PermissionBrokerPort  ←  C3        （子 agent 权限转 IM）
C6.ChannelPluginPort     ←  C5        （渠道收发/能力）
C7.ProviderRepository    →  C2 消费   （运行时读 Provider 配置）
C1 会话用例              ←  C5        （IM 入站建会话/落库）
C2 运行时用例            ←  C5        （IM 入站起回合）
C4                       ←  C2/C9 消费（图片生成用例）
```

**无环保证**：唯一的双向关系 C1↔C2（C1 需 C2.TitleGenerator，C2 需 C1.AppendMessageUseCase）在 NestJS 接线层用双侧 forwardRef 解，核心包只单向 import type。其余全部单向。

## 5. 目标目录结构

```
codepilot-web/
├── packages/core/           # 六边形核心（零框架）
│   └── <ctx>/ (domain/ ports/{driving,driven}/ usecases/)
├── apps/
│   ├── api/                 # NestJS：每上下文一个 Module（Controller + Adapter）
│   └── web/                 # Vite + React SPA
└── docs/
    ├── architecture/        # 本总览 + 主拆解 + 边界契约 + 索引
    ├── contexts/<ctx>/       # 各上下文 4 份 BMad 文档
    └── bmad-progress/        # 进度总账
```

## 6. 迁移策略（绞杀者模式）

按依赖从底到顶、从低风险到高风险逐个上下文迁移，每个可独立验证：

**SK → C7 → C1 → C2 → C3 → C8 → C9 → C10 → C4 → C6 → C5**

- 先迁 SK（无依赖，打底）与 C7（收益清晰、风险最小，作试点）。
- C2 最复杂、guardrail 最多（phase 状态机、abort 卡死、外部 AI agent 进程隔离），排在模式成熟后。
- C5 依赖最多（编排 C1/C2/C6），压轴。

## 7. 文档规模总览

11 上下文 × 4 份 BMad 文档 = **44 份文档**，累计约 **60 史诗、320+ 用户故事**（含各上下文 Story→AC 追溯矩阵与 3 Sprint 排期）。每份 architecture 到函数签名级 + NestJS Module DI 接线。
