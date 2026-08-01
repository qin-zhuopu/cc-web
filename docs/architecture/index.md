---
title: CodePilot Web — 架构文档索引
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# CodePilot Web — 架构文档索引

> 全套六边形架构 BMad 文档入口。11 限界上下文 × 4 份文档 = 44 份，均全中文、纯文档、未写代码。

## 顶层文档

| 文档 | 内容 |
|------|------|
| [overview.md](./overview.md) | 顶层架构总览：定位、六边形风格、11 上下文、依赖图、迁移策略 |
| [hexagonal-decomposition.md](./hexagonal-decomposition.md) | 主拆解基线：目标形态、分层铁律、上下文划分、迁移顺序 |
| [context-boundaries.md](./context-boundaries.md) | 边界契约：每个上下文的拥有/不包含/依赖端口/对外端口（防重叠） |
| [../bmad-progress/progress.md](../bmad-progress/progress.md) | 进度总账：44 格表 + 决策日志（含 API 中断自愈记录） |

## 各上下文 BMad 文档（按迁移顺序）

每个上下文含 4 份：`product-brief.md`（产品简报）、`prd.md`（需求）、`architecture.md`（六边形架构，到函数签名级）、`epics-stories.md`（史诗故事 + AC 追溯 + Sprint 排期）。

| 顺序 | 上下文 | 目录 | 史诗/故事 |
|------|--------|------|----------|
| 1 | SK · Shared Kernel | [shared-kernel/](../contexts/shared-kernel/) | 4 史诗 12 故事 |
| 2 | C7 · ProviderManagement | [c7-provider/](../contexts/c7-provider/) | 7 史诗 33 故事 |
| 3 | C1 · Conversation | [c1-conversation/](../contexts/c1-conversation/) | 6 史诗 27 故事 |
| 4 | C2 · AgentRuntime | [c2-agent-runtime/](../contexts/c2-agent-runtime/) | 7 史诗 40 故事 |
| 5 | C3 · SubagentOrchestration | [c3-subagent/](../contexts/c3-subagent/) | — |
| 6 | C8 · Workspace | [c8-workspace/](../contexts/c8-workspace/) | 6 史诗 30 故事 |
| 7 | C9 · PluginMCP | [c9-plugin-mcp/](../contexts/c9-plugin-mcp/) | 7 史诗 30 故事 |
| 8 | C10 · Task | [c10-task/](../contexts/c10-task/) | 7 史诗 27 故事 |
| 9 | C4 · MediaGeneration | [c4-media/](../contexts/c4-media/) | 7 史诗 30 故事 |
| 10 | C6 · Channel | [c6-channel/](../contexts/c6-channel/) | 8 史诗 34 故事 |
| 11 | C5 · Bridge | [c5-bridge/](../contexts/c5-bridge/) | 6 史诗 31 故事 |

## 阅读建议

- **想了解全貌**：先读 `overview.md` → `hexagonal-decomposition.md`。
- **想开发某个上下文**：读该上下文的 4 份文档 + `context-boundaries.md` 里它那一节。
- **想理解跨上下文协作**：读 `overview.md` 第 4 节依赖图 + 各上下文 architecture 的"跨上下文契约核对"节。
- **实施排期**：各上下文 `epics-stories.md` 的 Sprint 排期 + `overview.md` 第 6 节迁移顺序。

## 关键设计决策速查

- **phase 状态机根治 abort 卡死**：C2 `architecture.md`（StreamPhase 领域不变量 + force-abort 先行）。
- **持久 StreamStatus vs 实时 phase 分离**：C1 与 C2 architecture（切断 stop/abort 误用根因）。
- **本机直读文件的优势与路径安全**：C8 `architecture.md`（NodeFsAdapter + realpath 逃逸防护）。
- **反假数据（Skill 三语义/能力同源/凭据不外泄）**：C9、C6 的 prd §0 语义契约。
- **at-least-once 交付**：C5 `architecture.md`（fetch/committed offset 分离）。
