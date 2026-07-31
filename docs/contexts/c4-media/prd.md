---
title: 需求 — C4 MediaGeneration 媒体生成
context: C4 · MediaGeneration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 需求：C4 · MediaGeneration（媒体生成）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 语义契约（反假数据前置）

涉及用户可见的媒体元数据、批量任务统计、provider/model 归属、进度条时，必须先过本节。每个字段写清语义 + source breadcrumb + 缺失时降级策略。

| 用户可见字段 | 语义（用户看到会怎么理解） | source breadcrumb | 缺失/未知时 |
|---|---|---|---|
| `MediaGeneration.provider` / `family` | **实际运行**的图片 provider 家族（gemini / openai），不是用户请求的 | `image-generator-adapter.family`（适配器实际选中的 provider 家族） | 生成未成功 → 不显示「已用某 provider 生成」 |
| `MediaGeneration.model` | **实际上游 model id**（从请求 / provider extra_env / 默认解析后的最终值） | `resolvedImageProvider.model`（解析后，非请求原值） | 无 → 显示解析默认值并标注「默认」，不留空冒充 |
| `MediaGeneration.status` | 该生成记录生命周期：pending/processing/completed/failed | `db.media_generations.status` | 未 completed → 不显示 `localPath` 成图，显示对应状态 |
| `MediaGeneration.localPath` | 落盘成图的本机路径 | `image-saver.savedPath`（实测写盘路径） | 未落盘（skipSave / 失败）→ 空，UI 不渲染成图 |
| `MediaGeneration.metadata.elapsedMs` | 本次生成**实测耗时** | `clock.now() 差值`（生成起止实测） | 无 → 隐藏耗时，不显假 0 |
| `MediaGeneration.metadata.imageCount` | 实际落盘图片数 | `savedImages.length`（实测） | 无 → 不显示 |
| `MediaJob.total_items` | Job 计划项总数 | `db.media_jobs.total_items`（建 Job 时 items 数） | — |
| `MediaJob.completed_items` / `failed_items` | 实际完成 / 失败项数 | `MediaRepository.recountJobCounters`（按 item 实际状态聚合，非估算） | — |
| `JobProgress.processing` | 当前正在跑的项数 | 按 item.status='processing' 实时计数 | — |
| `MediaJobItem.retry_count` | 该项已重试次数 | `db.media_job_items.retry_count`（实测累加） | — |
| `MediaContextEvent.synced_at` | 该 Job 产出是否已回灌会话 + 回灌时刻 | `db.media_context_events.synced_at` | null → 未同步，UI 标「未回灌」 |

**反假数据红线：**
- 不把「请求参数」当「实测值」：`model`/`family` 必须是适配器实际选中/解析后的值，不是用户传入的 `params.model`。
- 不把「默认 provider」当「真实 provider」：`pickImageProvider` 的 fallback（back-compat 选 gemini）选中后，`family` 记实际选中值。
- 生成未成功不显假成图：`status != completed` 的记录不返回可渲染 `localPath`。
- Job 计数经 item 实际状态聚合（`recountJobCounters`），不允许前端估算或用请求项数当完成数。

## 1. 功能需求 (Functional Requirements)

### FR-1 单张图片生成（GenerateImageUseCase）
- **FR-1.1** 输入 prompt + 可选 model / providerId / aspectRatio / imageSize / referenceImages(base64) / referenceImagePaths / sessionId / cwd / skipSave，产出 `GenerateImageResult`（mediaGenerationId + 落盘图列表 + elapsedMs + 实际 model + 实际 family）。
- **FR-1.2** provider 解析：providerId 显式 > model 前缀推断 family > 用户设置的 active provider > back-compat 默认（gemini 优先）。解析经 `ImageProviderResolverPort`（读 C7 解析结果），**不在核心直查 `api_providers` 表**。
- **FR-1.3** 尺寸/比例领域规则纯函数化：`detectFamily`、`mapAspectToOpenAISize`（GPT Image 2 ratio-faithful 计算 + legacy 三尺寸折叠）、`computeGptImage2Size`（16 步长 / ≤3840 / 像素预算 [655360, 8294400]）全在 domain，可单测。
- **FR-1.4** 实际生成调用经 `ImageGeneratorPort.generate(request)`，适配器封装 `ai` SDK + provider 差异；核心只吃归一后的原始图数据（mimeType + bytes）。
- **FR-1.5** 落盘 + 项目目录复制 + 参考图落盘经 `MediaStoragePort`；DB 记录经 `MediaRepository.insertGeneration`。`skipSave=true` 时跳过落盘/落库，只回原始图数据（供 MCP 管线自行持久化）。
- **FR-1.6** 生成失败 → 经 `SK.ErrorClassifier` 归类（含 4xx 不可重试判定），记录 `status='failed'` + error，抛结构化错误。

### FR-2 批量任务生命周期（RunBatchJobUseCase）
- **FR-2.1** 建 Job：从一批规划好的 items（prompt/aspectRatio/imageSize/model/tags/sourceRefs）+ batchConfig（concurrency/maxRetries/retryDelayMs）+ 可选 stylePrompt/docPaths/sessionId 建 `MediaJob(status=planned)` + N 个 `MediaJobItem(status=pending)`。
- **FR-2.2** 启动 Job：`planned`/`paused` → `running`，按 `concurrency` 并发消费 pending/可重试 failed 项；每项经 `GenerateImageUseCase` 生成，成功 → item completed + 关联 `result_media_generation_id`，失败 → 退避重试或永久 failed。
- **FR-2.3** 失败重试：4xx（400/401/403）不可重试立即 failed；否则 `retry_count < maxRetries` 时按指数退避（`retryDelayMs * 3^(retry-1)`）重试，超限 failed。
- **FR-2.4** 暂停 Job：`running` → `paused`，**在跑项不误杀**（跑完），不再拉新项。
- **FR-2.5** 取消 Job：`running`/`paused` → `cancelled`，中断在跑项（abort signal）+ 所有 pending/failed 项置 `cancelled`。
- **FR-2.6** 终态判定：全部 item 达终态（completed/failed/cancelled）→ Job 定终态（有完成项 → completed，全失败 → failed）；经 `recountJobCounters` 聚合计数。
- **FR-2.7** 进程重启补偿：启动时把 `running` Job → `paused`、`processing` item → `pending`（可续跑），不留僵死 running。

### FR-3 媒体元数据与标签（MediaRepository）
- **FR-3.1** 媒体记录 CRUD：查单条 / 分页 Gallery 列表（按 created_at 倒序，可按 status/session 过滤）/ 删除（连带磁盘文件）/ 收藏（favorited toggle）。
- **FR-3.2** 标签：全局标签 CRUD（name 唯一 + color）；媒体记录打/去标签（media_generations.tags JSON 数组）。
- **FR-3.3** 元数据真实性：`provider`/`model`/`elapsedMs`/`imageCount` 落库前来自实测（见 §0）。

### FR-4 批量任务上下文回灌（MediaContextEvent）
- **FR-4.1** Job 产出可作为「上下文事件」回灌关联会话：建 `MediaContextEvent(sessionId, jobId, payload, sync_mode)`，`sync_mode` = `manual`（用户手动触发）/ `auto_batch`（批完自动）。
- **FR-4.2** 回灌语义：C4 只**记录**事件 + 标记 `synced_at`；事件如何真正注入会话上下文（构造消息喂 C1/C2）不属 C4——C4 提供事件读写用例，消费方（Bridge/上层）拉取并注入。
- **FR-4.3** `synced_at=null` = 未同步；UI 据此显示「未回灌」，不伪装已同步。

### FR-5 跨上下文供给
- **FR-5.1** `GenerateImageUseCase` 供 C2/C9 的 MCP 管线（`codepilot_generate_image`）与设计 Agent 前端流程调用；C4 不感知调用来源，只按 `skipSave` 决定是否自持久化。
- **FR-5.2** 媒体导入（`importFileToLibrary`，把 CLI 生成的既有文件纳入素材库）作为 `GenerateImageUseCase` 的姊妹用例 `ImportMediaUseCase`：复制文件到媒体目录 + 建 DB 记录（provider=来源标识如 `dreamina`），不调用图片生成。

## 2. 非功能需求 (Non-Functional Requirements)

- **NFR-1 零框架核心**：`packages/core/media-generation/` 不 import `ai` / `@ai-sdk/*` / `fs` / `path` / `os` / `crypto`（文件名/id 生成经端口）/ `better-sqlite3` / `@nestjs/*`。SDK/磁盘/DB 全在适配器。
- **NFR-2 状态机不变量集中**：Job/JobItem 的合法状态迁移由领域方法校验，非法迁移抛错，不散落字符串比较。
- **NFR-3 provider 可扩展**：新增图片 provider = 新增一个 `ImageGeneratorPort` 适配器 + 路由注册，核心用例/领域零改动。
- **NFR-4 provider 故障隔离**：单张生成失败/超时归结构化错误，不卡死批量执行器；一个 provider 病不污染其他 provider。
- **NFR-5 批量执行可测**：并发/退避/终态判定用假 `ImageGeneratorPort` + 假 Clock 可断言，不依赖真实网络与真实 `setTimeout` 等待（时间经 `SchedulerPort` 抽象或注入可控延时）。
- **NFR-6 磁盘安全**：媒体文件落盘路径限定在 `.codepilot-media/` canonical 目录；删除只删该目录内文件，不误删任意路径。
- **NFR-7 大数据不膨胀 DB**：base64 图片数据落盘后不入 DB（DB 只存 localPath）；参考图同样落盘存路径。
- **NFR-8 i18n**：用户可见文案用 `c4.*` messageKey，经 `SK.TranslationPort`；错误文案 key 来自 `SK.ErrorClassifier`。

## 3. 验收标准 (Acceptance Criteria)

- **AC-1**（FR-1.3）`mapAspectToOpenAISize` / `computeGptImage2Size` 表驱动单测：GPT Image 2 各比例（1:1/3:2/4:5/16:9/21:9）× 各 tier（1K/2K/4K）产出的每个 WxH 满足「16 倍数 + ≤3840 + 像素∈[655360,8294400]」四约束；legacy `gpt-image-1*` 折叠到三尺寸；未知 model 按最新处理不吞 2K/4K。
- **AC-2**（FR-1.2）provider 解析优先级单测：providerId 显式 > family 推断 > active 设置 > back-compat 默认；providerId 无效抛错、active 失效 fallback 不抛。
- **AC-3**（NFR-3，反例）新增一个假 `ImageGeneratorPort` 适配器（返回固定假图），`GenerateImageUseCase` 与批量执行器核心代码零改动即可跑通。
- **AC-4**（FR-2.3）退避重试单测：4xx 立即 failed 不重试；5xx/网络错 `retry_count<maxRetries` 退避重试、超限 failed；退避时长 = `retryDelayMs*3^(retry-1)`（用假 scheduler 断言，不真实等待）。
- **AC-5**（FR-2.4，反例）暂停 Job 时**在跑项不被中断**（跑完落 completed），只不拉新项；`paused` 后 pending 项保留可续跑。
- **AC-6**（FR-2.5）取消 Job：在跑项 abort、pending/failed → cancelled、Job → cancelled；已 completed 项保留不动。
- **AC-7**（FR-2.6）终态判定单测：全 item 终态且有 ≥1 completed → Job completed；全 failed 且 completed=0 → Job failed；计数经 recount 聚合 = item 实际状态计数（非请求项数）。
- **AC-8**（FR-2.7）进程重启补偿单测：running Job → paused、processing item → pending，无僵死 running。
- **AC-9**（状态机 NFR-2）Job/JobItem 非法迁移被拒单测：如 `completed` Job 不能回 `running`、`cancelled` item 不能回 `pending`。
- **AC-10**（§0 反假数据，反例）`model`/`family` 落库值 = 适配器实际选中/解析值，不等于请求原值；构造「请求 model=A 但适配器解析成 B」断言落库 B。
- **AC-11**（§0）生成失败记录 `status='failed'` + error 且不返回可渲染 `localPath`；`skipSave=true` 不落盘不落库只回原始图数据。
- **AC-12**（§0）Runtime 未上报耗时/图数 → metadata 对应字段空、UI 无假 0（假 Clock 使 elapsed 可控，断言无成图时不显 imageCount）。
- **AC-13**（FR-4.3）`MediaContextEvent.synced_at=null` 时列表返回未同步标记；标记 synced 后 synced_at 有实测时刻。
- **AC-14**（NFR-1）静态扫描：`media-generation/` 核心包 `ai`/`@ai-sdk/*`/`fs`/`better-sqlite3`/`@nestjs/*`/`crypto` 0 命中。
- **AC-15**（边界）核心不含会话/消息持久化（不写 chat_sessions/messages）、不含文本 AI 流（无 StreamSession/AgentStreamEvent import）、不含 Provider 配置写（不写 api_providers）；`SK.IdGenerator` 等只 import type。
- **AC-16**（NFR-6）媒体删除只删 `.codepilot-media/` 内 canonical 路径文件，构造越界路径断言拒删。
