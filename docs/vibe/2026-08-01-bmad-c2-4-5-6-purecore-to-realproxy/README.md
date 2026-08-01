# 2026-08-01 · C2 纯核心收尾（c2-4/c2-5）+ 首次接真代理（c2-6）

> 本目录沉淀「从 c2-4 起把 C2 纯核心跑完、再把纯核心第一次接到真 litellm 代理（c2-6）」这一轮会话的完整过程、决策、踩坑与产出。
> 上一轮见 `../2026-08-01-bmad-dev-auto-overnight-execution/`（整夜跑到 c2-3 断点 `b4a8b3e`）。

## 这一轮做了什么（一句话）

接续整夜断点，用 workflow 无人值守跑完 **c2-4（StartStream）+ c2-5（AbortStream，#578 编排层切断）**两个纯核心 epic，再由人在场亲手把 **c2-6（ClaudeSdkRuntimeAdapter + EventMapper + RuntimeRouter）**接上真 litellm 代理并端到端验证跑通——纯核心第一次真正发起了一次真实 AI 调用。

## 交付快照（截至沉淀时刻）

- **HEAD**：`096a8bf`（C2-E6），工作区仅剩用户改的文档/配置未提交，c2 产物全部入库。
- **本轮新增 3 个 epic 断点**：
  - `087af84` c2-4 StartStream 用例编排（546 测试）
  - `220d711` c2-5 AbortStream + #578 编排层切断（584 测试）
  - `096a8bf` c2-6 ClaudeSdkRuntimeAdapter 接真代理（623 测试）
- **623 测试全绿**，import 守卫扫 93 文件 0 命中，核心包零框架未被 SDK 污染。
- **连真 litellm 代理集成验证通过**：真实回合 text/result 归一正确、usage 真实投影（16883/108，非假 0）。
- **C2 进度**：c2-1~c2-6 全部完成（SK 全 + C1 全由用户合并进 master）。
- **剩余**：c2-7（DI 接线/TitleGenerator/权限中转）+ epic-accept（SSE/REST/端到端 smoke）——需 NestJS DI 接线与端到端，接真代理，须人在场。

## 文件索引

- `01-起点与接续状态.md` —— 会话起点（接整夜断点）、基线核对、任务范围与硬边界定义。
- `02-c2-4-startstream交付与评审修复.md` —— c2-4 拆解/workflow/2 个 AC-11 真缺陷（TOCTOU + 泄漏）的发现与修复。
- `03-c2-5-abortstream与578编排层切断.md` —— c2-5 拆解/workflow/force-abort 调度抽象设计/#578 双层落地/3 条 deferred。
- `04-模型失效踩坑与resume恢复.md` —— wf-c2-5 中途会话模型失效（400）与 resumeFromRunId 恢复的处置。
- `05-c2-6接真代理-从人工验证到实现.md` —— 从 curl 验证网关双协议、装 SDK、摸清 SDK 类型、实现三件套、typecheck 修复、到连真代理集成验证的全过程。
- `06-架构决策与铁律沉淀.md` —— 本轮固化的关键设计决策（EventMapper 契约张力、流式输入模式、RuntimeKind 双枚举、TokenUsage 同名别名等）与铁律。
- `07-巡检cron机制与下一步.md` —— 巡检 cron 兜底机制复盘、剩余工作、给下一个会话的精确接续提示语。

## 关键提醒（给接续者）

1. **litellm 网关双协议均已验证**：OpenAI `/v1/chat/completions` 与 Anthropic 原生 `/v1/messages` 都连通（HTTP 200）。SDK 走 Anthropic 原生端点经 `ANTHROPIC_BASE_URL` 工作正常。token 在 `apps/api/.env`（`sk-ZhYDqRcQZUT_pK8eqxhy1g`，已验证连通、gitignored、绝不入库/回显）。
2. **SDK 已装**：`@anthropic-ai/claude-agent-sdk@0.3.220`（pin 确切版本，在 apps/api）。`Query.interrupt()` 仅流式输入模式可用——适配器已用流式输入构造 prompt。
3. **核心零框架铁律仍守**：SDK import 只在 apps/api，守卫只扫 packages/core 且 0 命中。适配器只 import type 核心端口 + 值 import 必要项。
4. **集成验证脚本可复用**：`apps/api/scripts/c2-6-integration-check.mts`（人在场手动跑 `npx tsx`，不进 npm run test 门禁），后续 c2-7/accept 验证可仿此。
5. **git 环境有坑**：Git-Bash 下裸 `git`/`find`/`timeout` 都异常，一律用 `/mingw64/bin/git` 全路径或 Glob；`timeout` 会撞 Windows `timeout.exe`。项目是独立 git 仓库。
6. **每 epic 一个干净断点**，精准暂存不混入用户的文档/配置改动。
