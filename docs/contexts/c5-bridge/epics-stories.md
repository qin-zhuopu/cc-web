---
title: 史诗与故事 — C5 Bridge IM 桥接
context: C5 · Bridge
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C5 · Bridge（IM 桥接）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 本文档由 API 中断后主编排层直接补写，覆盖 prd 的 FR-1~FR-5 与 AC-1~AC-19。

## 史诗总览

| 史诗 | 主题 | 关联 FR | 故事数 |
|------|------|---------|--------|
| E1 | 入站路由与绑定解析 | FR-1 | 6 |
| E2 | 出站投递管线（顺序/限速/重试/降级/dedup） | FR-2 | 6 |
| E3 | 流式卡片时序编排 | FR-3 | 4 |
| E4 | 权限经纪（供 C3 复用） | FR-4 | 6 |
| E5 | 桥接生命周期与绑定管理 | FR-5 | 5 |
| E6 | 边界纪律与可测性（横切） | NFR | 4 |

合计 6 史诗 31 故事。

---

## E1 · 入站路由与绑定解析（FR-1）

- **S1.1** 作为桥接，我要按 `channelType+chatId` 稳定解析 `ChannelBinding`，未绑定时经 `C1.ManageSessionUseCase.create` 建会话并建绑定，使同一 IM chat 二次入站命中同一会话。（AC-1）
- **S1.2** 作为桥接，我要在入站先经 `C6.ChannelPlugin.isAuthorized` 做渠道准入，未授权丢弃并记审计。（AC-2）
- **S1.3** 作为桥接，我要识别 callback query（权限决议 callbackData）并分流到权限经纪，不当普通消息路由。（AC-3）
- **S1.4** 作为桥接，我要路由后经 `C2.StartStreamUseCase.start` 用绑定的 provider/model/mode/cwd 发起回合，拿到 `AgentStreamEvent` 流交给投递/卡片编排。（AC-4）
- **S1.5** 作为桥接，我要在会话有 active 回合时按 busy 处理新入站（消费 C2/C1 lock 结果），不并发起两回合。（AC-5）
- **S1.6** 作为桥接，我要把用户消息与 AI 回复经 `C1.AppendMessageUseCase` 落库（复用 web 端附件格式），不直写 messages 表。（FR-1.6）

## E2 · 出站投递管线（FR-2）

- **S2.1** 作为投递层，我要经 `C6.RenderMessageUseCase.render` 取渲染后 payloads，自身不做 Markdown→渠道渲染。（FR-2.1）
- **S2.2** 作为投递层，我要多 payload 按序投递、块间插入延迟防限速乱序。（AC-7）
- **S2.3** 作为投递层，我要每 chat 令牌桶限速，超限排队不丢。（AC-7）
- **S2.4** 作为投递层，我要 `send` 失败时经 `SK.ErrorClassifier` 归类，可重试错误指数退避重试、4xx 不重试。（AC-9）
- **S2.5** 作为投递层，我要彻底失败或能力不支持时降级（卡片失败→普通分片），降级路径记 RuntimeLog。（AC-9）
- **S2.6** 作为投递层，我要按内容/消息 id dedup 防重发，并记 outbound ref + 审计（经 DeliveryLogPort）。（AC-8/AC-10）

## E3 · 流式卡片时序编排（FR-3）

- **S3.1** 作为卡片编排器，我要仅当绑定渠道 `ChannelCapabilities.streaming=true`（C6 实测）才走卡片，否则走普通分片，且不按 channelType 名字猜能力。（AC-13）
- **S3.2** 作为卡片编排器，我要消费 `AgentStreamEvent` 驱动 `CardStreamController`：首 text→create、增量→节流合并 update、终态→finalize（三态映射自 C2 终态）。（FR-3.2）
- **S3.3** 作为卡片编排器，我要在 `create` 返回空串时判定建卡失败，降级为普通分片，不把空 id 当有效卡片调 update/finalize。（AC-14）
- **S3.4** 作为卡片编排器，我要在 C5 侧持有节流窗口，一次 update 失败置 degraded 跳过后续 preview，终态仍走 finalize；实际 API 调用归 C6 controller。（FR-3.4）

## E4 · 权限经纪（FR-4，供 C3 复用）

- **S4.1** 作为权限经纪，我要在流阻塞**期间**把 `permission_request` 转成 IM 内联按钮发出，破解 deadlock。（AC-12）
- **S4.2** 作为权限经纪，我要建立 `permissionRequestId ↔ IM message` 唯一映射（经 PermissionLinkRepository）。（AC-11）
- **S4.3** 作为权限经纪，我要按唯一 `permissionRequestId` 定向决议回对应 Runtime 调用，不串会话，未回状态为 pending 不冒充。（AC-11）
- **S4.4** 作为权限经纪，我要在交互式工具不支持时明确拒绝并给理由。（FR-4.4）
- **S4.5** 作为权限经纪，我要在会话中断/结束时自动批准/清理该会话 pending 权限，避免悬挂。（FR-4.5）
- **S4.6** 作为权限经纪，我要把 `PermissionBrokerPort` 导出供 C3 子 agent 复用，编排不区分主会话/子 agent 调用方。（AC-18）

## E5 · 桥接生命周期与绑定管理（FR-5）

- **S5.1** 作为桥接管理器，我要提供 start/stop/restart/status，start 后对每个启用渠道起 `runAdapterLoop`、stop 优雅关闭全部 adapter。（FR-5.1）
- **S5.2** 作为桥接管理器，我要在 `runAdapterLoop` 中分离 fetchOffset 与 committedOffset，仅 route 处理完成后推进 committed，实现 at-least-once。（AC-6）
- **S5.3** 作为桥接管理器，我要启动前经 `C6.ProbeChannelUseCase` 预检连通与能力，探测失败的渠道不起 loop、状态记 error（脱敏）。（FR-5.3）
- **S5.4** 作为桥接管理器，我要提供 `ManageBindingUseCase` 列/建/改/删绑定，支持改 provider/model/mode/cwd。（FR-5.4）
- **S5.5** 作为桥接管理器，我要在 dev HMR 下防 adapter loop 重复起（globalThis 标志），生产单实例。（FR-5.5）

## E6 · 边界纪律与可测性（NFR，横切）

- **S6.1** 作为架构守卫，我要保证 `bridge/` 核心包对渠道 SDK/`ws`/AI SDK/DB/`@nestjs`/`node:*` 静态扫描 0 命中。（AC-15）
- **S6.2** 作为架构守卫，我要让全部用例可在内存假端口上跑单测，无需真实 SDK/AI/网络/DB。（AC-16）
- **S6.3** 作为架构守卫，我要保证一个渠道 loop 抛错时该 loop 标 error 停、其它 loop 继续，桥接不整体 crash。（AC-17）
- **S6.4** 作为架构守卫，我要用接口断言证明 C5 无渠道渲染方法、无会话/消息实体、无 StreamPhase/StreamSession、无 Provider 配置（只 import type）。（AC-19）

---

## Story → AC 追溯矩阵

| Story | 覆盖 AC |
|-------|---------|
| S1.1 | AC-1 |
| S1.2 | AC-2 |
| S1.3 | AC-3 |
| S1.4 | AC-4 |
| S1.5 | AC-5 |
| S1.6 | AC-4（落库路径） |
| S2.1 | FR-2.1 |
| S2.2 / S2.3 | AC-7 |
| S2.4 / S2.5 | AC-9 |
| S2.6 | AC-8 / AC-10 |
| S3.1 | AC-13 |
| S3.2 | FR-3.2 |
| S3.3 | AC-14 |
| S3.4 | FR-3.4 |
| S4.1 | AC-12 |
| S4.2 / S4.3 | AC-11 |
| S4.4 | FR-4.4 |
| S4.5 | FR-4.5 |
| S4.6 | AC-18 |
| S5.1 | FR-5.1 |
| S5.2 | AC-6 |
| S5.3 | FR-5.3 |
| S5.4 | FR-5.4 |
| S5.5 | FR-5.5 |
| S6.1 | AC-15 |
| S6.2 | AC-16 |
| S6.3 | AC-17 |
| S6.4 | AC-19 |

## Sprint 排期建议

- **Sprint 1（骨架 + 入站闭环）**：E1 全部 + E5 的 S5.1/S5.2/S5.4 + E6 的 S6.1/S6.2。打通"IM 入站→建会话→起回合→落库"最小闭环，立起 at-least-once 与边界扫描。
- **Sprint 2（投递 + 卡片）**：E2 全部 + E3 全部 + E5 的 S5.3/S5.5。完善出站管线与流式卡片降级。
- **Sprint 3（权限 + 隔离加固）**：E4 全部 + E6 的 S6.3/S6.4。破解 deadlock、供 C3 复用、故障隔离与边界断言收口。

> C5 依赖 C6/C1/C2 已完成，排期应在三者对应 Sprint 之后。C3 子 agent 编排依赖本上下文 `PermissionBrokerPort`（S4.6），需在 C3 权限相关 Sprint 前交付。
