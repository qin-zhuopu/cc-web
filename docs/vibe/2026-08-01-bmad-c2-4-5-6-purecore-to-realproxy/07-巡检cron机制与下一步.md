# 07 · 巡检 cron 机制与下一步

## 巡检 cron 机制复盘

用户指令「启动一个 cron 20 分钟检查一次进度防止卡死，直到整个 sprint 开发完成」。

- **配置**：`13,33,53 * * * *`（每小时 3 次，约 20 分钟一次；避开 :00/:30 整点减轻 API 峰值），session-only（会话级、不落盘）。
- **巡检步骤**（每次触发执行）：
  1. `/mingw64/bin/git log --oneline` 看是否有新断点。
  2. 读 sprint-status.yaml 看 epic 状态。
  3. 看 workflow transcript 的 journal.jsonl 行数/类型统计判断是否推进。
  4. 疑似卡死则诊断根因（网络/输出退化/模型），按需 TaskStop + resumeFromRunId 恢复。
  5. workflow 完成但门禁/评审/提交未做则接续。
  6. c2-4 完成自动接 c2-5。
  7. 到需真代理的 epic 停下报告、结束循环、删 cron。
  8. 无进展变化只简报「仍在推进中」不做多余动作。

## 卡死判定的双信号法（实战有效）

巡检中真遇到「journal 两连查停在同一行、同一 agent started 无 result 约 20 分钟」的疑似卡死。判定方法：
- **journal 行数/类型**：停滞 = 可疑。
- **agent transcript 文件 mtime**：距当前仅 2 秒 = 仍在活跃写入 = **非卡死**，只是该 agent（c2-4-6 落 C1）工具调用多、transcript 达 485KB 所以慢。

结论：没误判打断。**journal 停滞 + transcript 仍在写 = 慢而非死**；journal 停滞 + transcript 也不动 + 有 API 错误 = 真需 resume。

## cron 生命周期

c2-4/c2-5 两个纯核心 epic 完成、提交断点后，按方针推进到硬边界（需真代理的 c2-6+），**删除巡检 cron `b4b30d92`**、结束自主循环、报告剩余待人验。随后用户回来在场，转入 c2-6 人工接真代理阶段（不再需要 cron）。

## 本轮完整交付

| Epic | 断点 | 内容 | 测试 |
|---|---|---|---|
| c2-4 StartStream | `087af84` | 发起回合用例编排（修 2 个 AC-11 真缺陷） | 546 |
| c2-5 AbortStream | `220d711` | #578 编排层切断（force-abort 先行 + reconcile） | 584 |
| c2-6 ClaudeSdk 适配器 | `096a8bf` | 接真代理（EventMapper+Adapter+Router） | 623 |

- C2 进度：**c2-1~c2-6 全部完成**（SK 全 + C1 全由用户合并进 master）。
- 623 测试全绿，守卫扫 93 文件 0 命中，核心零框架未污染。
- litellm 网关双协议均验证连通，SDK 端到端跑通真实回合。

## 剩余工作

### c2-7 · TitleGenerator + 权限中转 + AgentRuntimeModule（DI 接线）
- c2-7-1 GenerateTitleService（非流式，不进 registry/不影响 canAccept）
- c2-7-2/3 权限请求事件产出 + 决议中转（C2 不做经纪判定）
- c2-7-4 **AgentRuntimeModule**：NestJS DI 接线，**forwardRef 解 C1↔C2 环**（C1 用 C2.TitleGenerator、C2 用 C1.AppendMessageUseCase）
- c2-7-5 驱动适配器 Controller（ChatController/PermissionController/RuntimeController）
- c2-7-6 终态→C1 持久 StreamStatus 映射接线
- 把 StartStreamService/AbortStreamService/RuntimeRouter/ClaudeSdkRuntimeAdapter 用 useFactory 接进 DI（参照 ConversationModule 范式）。

### epic-accept · 验收链路（替代前端）
- accept-1 ProviderRepository Claude stub（顶替 C7）
- accept-2 SSE 广播 hub（per session）
- accept-3 事件日志文件适配器（append-only + seq）
- accept-4/5/6 REST 三件套（POST /stream 新建、GET /stream 挂载、POST /messages 发消息）
- accept-7 Last-Event-ID 断线补发
- accept-8 CLI 监听客户端
- accept-9 端到端 smoke（新建流 → 发消息 → 重连）

这些都要 NestJS DI 接线 + 连真代理端到端，须人在场。

## 恢复方式（新会话接续）

1. **读进度**：sprint-status.yaml（c2-1~6 done、c2-7/accept backlog）+ `git log --oneline`（本轮 3 个 c2 断点）。
2. **读本 vibe 目录**全部 8 个文件了解来龙去脉与铁律。
3. **验证基线**：`npm run test`（应 623 绿、守卫 0 命中），用 `/mingw64/bin/git`。
4. **确认代理**：`.env` token `sk-ZhYDqRcQZUT_pK8eqxhy1g` 已验证连通；需要时用 `apps/api/scripts/c2-6-integration-check.mts` 复验。
5. **继续 c2-7**：拆 epic-c2-7 → 实现 GenerateTitleService/权限中转 → 建 AgentRuntimeModule（forwardRef 解环，参照 ConversationModule）→ 接 Controller → 门禁 → 断点提交。DI 接线在 apps/api，不进 workflow（子代理接不了真 DI/真代理）。

## 给下一个会话的精确接续提示语（可直接用）

> 继续 CodePilot Web 后端的 bmad sprint。当前 HEAD `096a8bf`，C2 的 c2-1~c2-6 已完成（SK 全 + C1 全在 master），623 测试全绿，litellm 网关（`https://litellm.jereh.cn`，token 在 apps/api/.env）双协议已验证连通、SDK 已跑通真实回合。先读 `docs/vibe/2026-08-01-bmad-c2-4-5-6-purecore-to-realproxy/` 全部文件了解上下文与铁律，跑 `npm run test`（用 /mingw64/bin/git）确认基线。然后做 c2-7：拆 epic-c2-7 → 实现 GenerateTitleService（非流式、不进 registry）+ 权限事件产出/决议中转 → 建 AgentRuntimeModule（NestJS DI，forwardRef 解 C1↔C2 环，把 StartStream/AbortStream/RuntimeRouter/ClaudeSdkAdapter useFactory 接进去，参照 ConversationModule 范式）→ 接 ChatController/PermissionController/RuntimeController → 门禁全绿 → git 断点提交。DI 接线连真代理、须我在场；每步幂等自检、核心零框架、import type+.js、token 不入库/回显。之后是 epic-accept（SSE/REST 三件套/断线补发/CLI/端到端 smoke）。

## 未解决 / 遗留

- **deferred-work.md** 本轮新增 3 条 c2-5 项，最要紧的是「超时 terminalReason.code 误标 USER_ABORTED」需 correct-course 改 c2-2 聚合根（加带归因码的 abort 重载）。
- **会话模型可能再抖**：workflow 子代理继承会话模型，`kiro/claude-opus-4.8` 本轮失效过一次，靠 resume 恢复。若再遇 400 Invalid model ID，resume 是解。
- **Native/Codex 适配器 deferred**：c2-6 只实现 CLAUDE_SDK；RuntimeRouter 路由位保留，将来加不改核心。
- **逐字增量流式未实现**：c2-6 EventMapper 只映射完整消息；SSE 逐 token 增量留待 epic-accept。
