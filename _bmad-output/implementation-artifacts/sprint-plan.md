---
title: CodePilot Web 后端 Phase 4 分批实施计划
project: codepilot-web
scope: SK · Shared Kernel / C1 · Conversation / C2 · AgentRuntime + 验收链路
created: 2026-07-31
status: 已与用户确认范围，待开工
---

# CodePilot Web 后端 Phase 4 分批实施计划

> 本文件是"给人看"的分批计划；机器追踪进度见同目录 `sprint-status.yaml`。
> 架构基线见 `docs/architecture/`，各上下文详细文档见 `docs/contexts/<ctx>/`。
> 就绪度报告（结论 READY）见 `_bmad-output/planning-artifacts/implementation-readiness-report-2026-07-31.md`。

## 一、本期要交付的功能（人话版）

做完之后，你有一个**无 UI 的本机 AI 对话后端**，能力如下：

1. **新建对话** —— 带完整参数和第一句话，服务端建会话、开始流式回复。
2. **流式对话** —— Claude 的回复实时一段段推回：思考过程 / 正文 / 工具调用 / 工具结果 / 状态 / 用量，全都有。
3. **随时能停** —— 中途叫停立刻停下、输入立刻恢复可用，不卡死（根治老毛病）。
4. **列历史会话 + 列活跃会话**。
5. **接着聊** —— 不管新老会话，靠 Claude SDK 的 resume 机制接回上下文继续问。
6. **自动起标题** —— AI 按内容起名；你手改后 AI 不再覆盖。

**验收方式（替代前端）：** 一个只监听的 CLI + curl 发消息，端到端跑通。

## 二、接口形态（SSE 为中心，已确认）

| 用途 | 接口 | 说明 |
|---|---|---|
| 新建会话 | `POST /api/sessions/stream` | body 带**完整 query options**（工作目录/模型/mode/thinking/context1m/skills 等）+ 第一句话。首个 SSE 事件回推新 session id，随后流式跑第一轮。 |
| 挂载已有会话 | `GET /api/sessions/:id/stream` | 给 id 就挂上，一直收 SSE。断线后带 `Last-Event-ID` 重连即补发。 |
| 发消息 | `POST /api/sessions/:id/turn` | curl 发，立即返回，触发新一轮；事件广播给所有挂在该会话 stream 上的连接。注：用 `/turn` 非 `/messages`——`/messages` 被 C1 MessageController 占用（落消息表），二者语义不同故分离。 |
| 列会话 | `GET /api/sessions`（历史）/ 活跃列表 | 会话管理用例投影。 |

**一式三份（每个流式事件的三个落点）：**
1. **SSE 实时推** —— 带单调递增 `seq`（即 SSE `id:` 字段），供断线重连做游标。
2. **文件事件日志** —— 每会话一个 append-only 日志，一行一事件（含 seq）。这是"流水账"，也是补发数据源。
3. **SQLite 最终落库** —— 一轮结束后把最终 assistant 消息存进会话历史（走 C1 存消息用例）。

**断线补发：** 客户端带 `Last-Event-ID: N` 重连 → NestJS 从文件日志读 seq>N 的行逐条补发 → 接上实时流。

## 三、关键实现决策（参考 CodePilot 桌面版沉淀）

- **resume 续接**：每轮结束 Claude SDK 回一个 `session_id`；下轮 `query({ resume: 那个id })` 接回上下文。resume 失败（工作目录没了/id 失效）→ 清 id、退回开新对话，不卡死。此 id 属**运行时（C2）**，锁在 `ClaudeSdkRuntimeAdapter` 内，**不进 C1 会话本体模型**（对齐架构 §3.1 字段归属纪律）。
- **一式三份 vs 参考项目**：参考项目边流边把半成品塞 SQLite 做检查点（需 lockId 防旧回合覆盖）。本期改为**文件日志负责实时缓冲与补发，SQLite 只存干净最终结果**，两者分离，更干净。
- **phase 状态机**：中断不卡死用架构文档的 phase 不变量（active→settling→terminal，force-abort 无条件先行）实现，比参考项目的 lockId 机制更结构化。
- **广播、文件日志、seq 编号、补发、CLI**：全部落在最外层驱动/出站适配器，核心（会话/运行时）零框架、零文件、零 SQL，符合六边形铁律。

## 四、本期范围边界

**做：** SK 全套 / C1 全套 / C2 核心 + 用例 + ClaudeSdkRuntimeAdapter / 验收链路（三件套接口 + 一式三份 + 补发 + CLI）。

**本期延后（deferred，接口保留，将来加不改核心）：**
- C2 的 **Native 运行时适配器**（story c2-6-2）。
- C2 的 **Codex 运行时适配器**及其进程隔离/fail-fast/EventMapper（c2-6-3~6-5、6-7）。
- SK 的 **C7 试点消费验证**（sk-4-4，因 C7 本期不做）。

**本期用 stub 顶替：**
- **C7.ProviderRepository** —— apps/api 里一个最小只读 stub，返回写死的单个 Claude provider 配置。核心只 `import type`，接口保留。

**完全不做：** 前端 UI、C3~C10 其余上下文。

## 五、分批计划（9 个冲刺，按依赖单调推进）

> 依赖顺序硬约束：SK → C1 → C2 → 验收链路。每批做完都有可验证产出。

### S1 · 地基 + SK 错误与确定性端口
- monorepo 脚手架（pnpm workspace、packages/core、apps/api、tsconfig、测试运行器、lint）。
- **import 静态守卫提前落地**（禁 `@anthropic-ai/*`/`better-sqlite3`/`@nestjs/*`/`Date.now`/`randomUUID` 进核心包），第一天接入 `npm run test`。
- SK E1：16 类错误码 + 分类器 + i18n 键（sk-1-1~1-3）。
- SK E2：Clock / IdGenerator / Platform 端口（sk-2-1~2-3）。
- **产出**：核心包骨架立起，边界门禁生效，全项目地基就位。

### S2 · SK 收尾
- SK E3：Redactor + RuntimeLog 环形缓冲 + 写入自动脱敏（sk-3-1~3-3）。
- SK E4：TranslationPort + SharedKernelModule DI 接线（sk-4-1、4-2、4-3）。
- **产出**：SK 全部端口可注入，脱敏/日志/翻译到位。（sk-4-4 试点延后）

### S3 · C1 骨架 + 消息内容值对象
- C1 E1：会话/消息领域 + 端口骨架 + 禁 phase + import 守卫（c1-1-1~1-7）。
- C1 E2：MessageContent 5 类内容块 + 编解码往返 + 脏输入降级（c1-2-1~2-5）。
- **产出**：C1 零框架核心骨架 + 内容编解码，单测绿。

### S4 · C1 会话/标题/消息用例
- C1 E3：会话生命周期（create/list/archive/delete/touch，c1-3-x）。
- C1 E4：标题来源状态机 + 调 TitleGenerator（用假实现）+ 降级（c1-4-x）。
- C1 E5：消息追加/streamStatus 推进/历史与 prompt 投影（c1-5-x）。
- **产出**：会话与消息生命周期用例全通，反例 smoke 绿。

### S5 · C1 NestJS 接线
- C1 E6：ConversationModule（forwardRef 占位）+ Session/Message Controllers + SQLite 适配器 + 消费契约（c1-6-x）。
- **产出**：会话管理经 REST 可用（新建/列历史/列活跃/改名/存消息），SQLite 落库跑通。**此处第一个可用里程碑：能新建和列会话。**

### S6 · C2 骨架 + phase 状态机 + 事件模型
- C2 E1：领域 + 端口骨架 + import 守卫（c2-1-x）。
- C2 E2：StreamSession 聚合根 + phase 不变量 + canAccept + **#578 abort 反例回归**（c2-2-x）。
- C2 E3：14 类 AgentStreamEvent + EventMapper 契约 + 未知事件降级（c2-3-x）。
- **产出**：运行时核心 + 中断不卡死的结构化保证，用假 Runtime+假 Clock 复现并切断 #578。

### S7 · C2 发起 + 中断用例
- C2 E4：StartStream（选 Runtime/历史投影/事件消费/落 C1，c2-4-x）。
- C2 E5：AbortStream（force-abort 先行/reconcile/关句柄/超时归因，c2-5-x）。
- **产出**：发起与中断用例全通（假出站端口），终态映射回 C1。

### S8 · C2 Claude 适配器 + 接线
- C2 E6：**仅** ClaudeSdkRuntimeAdapter + ClaudeSdkEventMapper（含 resume 续接、句柄/lockId 归属、组合中断）+ RuntimeRouter（c2-6-1、6-6）。**Native/Codex 延后。**
- C2 E7：TitleGenerator + 权限事件中转 + AgentRuntimeModule 接线（两侧 forwardRef 解 C1↔C2 环）+ 终态→C1 StreamStatus 映射（c2-7-x）。
- **产出**：真接 Claude SDK，能流式跑一轮、能停、能 resume 续接。**第二个可用里程碑：能真的跟 AI 流式对话。**

### S9 · 验收链路（替代前端，端到端打通）
- accept-1：C7.ProviderRepository 最小 Claude stub。
- accept-2：按会话的 SSE 广播中枢。
- accept-3：文件事件日志适配器（append-only + seq）。
- accept-4：`POST /api/sessions/stream` 新建（带 options+首句，首事件回推 id）。
- accept-5：`GET /api/sessions/:id/stream` 挂载已有会话。
- accept-6：`POST /api/sessions/:id/turn` 发消息触发一轮 + 广播（独立路径，避免与 C1 `:id/messages` 撞）。
- accept-7：`Last-Event-ID` 断线补发（从文件日志回放 seq 之后事件）。
- accept-8：CLI 监听客户端（`listen --new` / `listen --session <id>`）。
- accept-9：端到端 smoke —— 新建→流式→curl 发消息→断线重挂补发，全链路验证。
- **产出**：**最终验收**。终端 A 跑 CLI 拿 id → 终端 B curl 发消息 → 终端 A 实时滚出全部事件 → 断线重连补发不丢 → 关掉重开接着聊。

## 六、里程碑速览

| 冲刺 | 里程碑 |
|---|---|
| S1–S2 | 地基 + 公共内核完成，边界门禁生效 |
| S3–S5 | 会话管理可用（新建/列会话/存消息，REST + SQLite） |
| S6–S8 | 运行时接通 Claude，能流式对话 + 能停 + 能续接 |
| S9 | 端到端验收链路打通（CLI + curl + 一式三份 + 补发） |

## 七、完成定义（DoD）

- 各上下文单测与反例 smoke 全绿（`npm run test` 层，核心用假出站端口 + 假 Clock/IdGenerator，无需真实 SDK/DB/网络）。
- 核心包禁用 import 静态扫描 0 命中。
- **#578 abort 反例回归通过**：interrupt 永不 resolve 时 phase 仍翻 terminal(aborted)、canAccept()=true。
- phase 不落库、不与 C1 持久 StreamStatus 混用。
- C1↔C2 环经 forwardRef 解，核心包只单向 import type。
- S9 端到端 smoke 通过：新建/流式/发消息/断线补发/续接全链路可复现。
