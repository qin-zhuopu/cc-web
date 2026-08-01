---
title: 产品简报 — C4 MediaGeneration 媒体生成
context: C4 · MediaGeneration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C4 · MediaGeneration（媒体生成）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 主拆解基线见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 承接现有 CodePilot 落点：`src/lib/image-generator.ts`、`src/lib/job-executor.ts`、`media_generations`/`media_tags`/`media_jobs`/`media_job_items`/`media_context_events` 表。

## 1. 上下文定位

C4 是「图片/媒体生成」的限界上下文。它拥有**图片生成请求**、**批量任务 Job/JobItem 两级模型**、**媒体元数据与标签**三块领域概念，负责把「生成一张图」和「批量生成一批图」这两类能力沉淀成纯领域逻辑，把多 provider（Gemini / OpenAI-Image / 未来更多）差异、磁盘落盘、DB 持久化全部隔离在适配器后。

一句话边界：**C4 只管媒体怎么生成、批量任务怎么调度、结果元数据怎么存与查；不管文本 AI 流怎么跑（属 C2）。**

## 2. 要解决的问题（现有 CodePilot 的耦合痛点）

现有 `image-generator.ts` + `job-executor.ts` 把领域逻辑、SDK 调用、磁盘 I/O、DB 直写全部糅在一起，重构为本机 Web 应用时暴露 5 类结构性痛点：

- **P1 领域逻辑与 provider SDK / 磁盘 / DB 纠缠**：`generateSingleImage` 一个函数里同时做「选 provider → 拼 `ai` SDK 调用 → 写文件到 `.codepilot-media/` → 复制到项目目录 → `INSERT media_generations`」。尺寸映射（`computeGptImage2Size` / `mapAspectToOpenAISize`，GPT Image 2 的边长/像素/16 步长约束）这类**纯领域规则**被埋在 I/O 代码里，无法单测、无法换 provider 不改核心。
- **P2 多 provider 分叉散落**：Gemini 与 OpenAI-Image 两条分支靠 `detectFamily` 前缀推断 + if/else 硬编码在生成函数体内，新增一个图片 provider 要改核心函数。缺一个 `ImageGeneratorPort` 抽象把「一次图片生成调用」标准化。
- **P3 批量任务执行器状态机脆弱**：`job-executor.ts` 用 `globalThis` 单例 Map + `setTimeout` 轮询 + `AbortController` 手工管理并发/重试/暂停/取消，Job 状态（draft→planning→planned→running→paused→completed/cancelled/failed）与 JobItem 状态（pending→processing→completed/failed/cancelled）的合法迁移只靠散落的字符串比较，没有集中的状态机不变量，进程重启后 running 任务如何恢复也靠一段 `UPDATE ... SET status='paused'` 的启动补偿。
- **P4 上下文事件（media_context_events）语义模糊**：批量任务产出的图要「回灌」给会话上下文（sync_mode = manual / auto_batch），但这层 Job→Session 的事件同步没有清晰归属，容易和 C1 会话/C2 流式混淆。
- **P5 元数据真实性风险（反假数据）**：`media_generations` 的 `provider` / `model` / `elapsedMs` / `imageCount` / `referenceImages` 等字段，UI 上会当成「这张图实际用哪个模型、真花了多久」展示。若把请求参数当成实测值、把默认值当成真实 provider，就会误导用户。

## 3. 边界（拥有 / 不含 / 依赖 / 对外提供）

严格对齐 `context-boundaries.md` 的 C4 契约：

- **拥有**：图片生成请求（GenerateImageRequest + 尺寸/比例领域规则）、批量任务 Job/JobItem 两级模型 + 执行器状态机、媒体元数据（MediaGeneration）与标签（MediaTag）、上下文事件（MediaContextEvent，Job→Session 回灌）。
- **不含**：
  - 文本 AI 流（属 C2 AgentRuntime）——C4 不建模 StreamSession / AgentStreamEvent / phase。
  - 会话/消息本体（属 C1）——C4 只持 `sessionId` / `messageId` 归属键，不写 `chat_sessions` / `messages`。
  - Provider 配置管理（属 C7）——图片 provider 的 apiKey/baseURL/启用/排序归 C7；C4 只**读取已解析的图片 provider 视图**。**注**：现有 `pickImageProvider` 直接查 `api_providers` 表属越界，重构后经端口拿解析结果。
  - MCP 工具编排（属 C9/C2）——`codepilot_generate_image` / `codepilot_import_media` 如何被 AI 调用、`MEDIA_RESULT_MARKER` 如何注入对话属 C2/C9；C4 只提供被这些工具调用的**生成/导入用例**。
  - 媒体文件的浏览/预览（属 C8）——生成的图在 C8 眼里只是普通文件。
  - 批量任务的 AI 规划（planner，把文档拆成一批 prompt）——这是一次文本 AI 调用，属 C2；C4 只接收规划产出的 items 建 Job。
- **依赖端口**：`SK.IdGenerator`（生成 media/job/item/event id）。横切另用 `SK.Clock`（时间戳）、`SK.ErrorClassifier`（生成失败归类，判可重试）、`SK.RuntimeLog`、`SK.TranslationPort`（文案）。
- **对外提供端口**：`GenerateImageUseCase`、`RunBatchJobUseCase`、`ImageGeneratorPort`（出站，多 provider 适配器实现）、`MediaRepository`（出站，媒体/标签/Job/Item/事件持久化）。

## 4. 用户价值

- **换 provider 不改核心**：新增一个图片 provider 只写一个 `ImageGeneratorPort` 适配器 + 在路由器注册，尺寸约束/重试/落库全复用。
- **批量任务可靠可恢复**：Job/JobItem 状态机把「暂停不误杀在跑项」「取消清空 pending」「进程重启后 running→paused 恢复」「失败退避重试」变成集中的领域不变量，不再靠散落的字符串比较。
- **元数据可信**：`provider`/`model`/`elapsedMs` 等字段标注实测来源，不把请求参数当实测、不把默认值当真实 provider，Gallery / 素材库看到的数据是它以为的意思。

## 5. 成功标准

- **S1**：图片生成的领域规则（GPT Image 2 尺寸计算、family 推断、legacy 模型尺寸折叠）100% 纯函数、可单测，核心包不 import `ai` / `@ai-sdk/*` / `fs` / `better-sqlite3`。
- **S2**：Gemini 与 OpenAI-Image 经同一 `ImageGeneratorPort` 抽象，新增 provider 零核心改动（AC 反例：加一个假 provider 适配器，核心用例代码不变）。
- **S3**：Job/JobItem 状态迁移经领域方法校验，非法迁移被拒；暂停不误杀在跑项、取消置 pending→cancelled、重启补偿 running→paused 有对应单测。
- **S4**：批量执行器的并发/退避重试/终态判定（全 item 终态 → job completed/failed）逻辑纯函数化，用假 `ImageGeneratorPort` + 假 Clock 可断言，不依赖真实 SDK/网络/`setTimeout` 真实等待。
- **S5**：媒体元数据真实性——`model`/`family`/`elapsedMs` 为实测投影，UI 无假 0 / 无把默认 provider 当真实 provider；未生成成功的记录 `status != completed` 且不显假 `localPath`。
- **S6**：C4 核心零框架、不越界——不含会话/消息持久化、不含文本 AI 流、不含 Provider 配置写、不含 MCP 调用编排；`SK.IdGenerator` 等只 `import type` 引用不重写。
