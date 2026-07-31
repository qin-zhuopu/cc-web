---
title: 史诗与故事 — C4 MediaGeneration 媒体生成
context: C4 · MediaGeneration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C4 · MediaGeneration（媒体生成）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 史诗总览

| # | 史诗 | 目标 | 关联 FR | 关联 AC |
|---|------|------|---------|---------|
| E1 | 图片生成领域规则纯函数化 | 尺寸/family 规则从 I/O 剥离、可单测 | FR-1.3 | AC-1 |
| E2 | 单张生成用例与 provider 抽象 | GenerateImageUseCase + ImageGeneratorPort 多 provider | FR-1.1/1.2/1.4/1.5/1.6, FR-5 | AC-2/3/10/11 |
| E3 | 批量任务状态机 | Job/JobItem 聚合根 + 状态机不变量 | FR-2.1, NFR-2 | AC-9 |
| E4 | 批量执行器 | 并发/退避/暂停/取消/终态/重启补偿 | FR-2.2–2.7 | AC-4/5/6/7/8 |
| E5 | 媒体元数据、标签与 Gallery | MediaRepository + ManageMediaUseCase | FR-3 | AC-16 |
| E6 | 批量任务上下文回灌 | MediaContextEvent 读写 + 同步标记 | FR-4 | AC-13 |
| E7 | 出站适配器与 NestJS 接线 | 适配器实现 + DI + 边界守护 | NFR-1/3/4/6/7 | AC-14/15 |

---

## E1 · 图片生成领域规则纯函数化

- **S1.1**（FR-1.3/AC-1）实现 `parseRatio`：解析 "w:h"，>3:1 或非法返回 null。含单测。
- **S1.2**（FR-1.3/AC-1）实现 `computeGptImage2Size`：16 步长 / ≤3840 / 像素∈[655360,8294400]，各比例×tier 表驱动单测断言四约束。
- **S1.3**（FR-1.3/AC-1）实现 `mapAspectToOpenAISize`：GPT Image 2 ratio-faithful + legacy `gpt-image-1*` 折叠三尺寸 + 未知 model 按最新。含单测。
- **S1.4**（FR-1.3）实现 `detectFamily`：gpt-image/chatgpt-image→openai、gemini→gemini、未知→undefined。
- **S1.5** 定义 `MediaGeneration`/`MediaMetadata`/`RawImage`/`GenerateImageRequest` 值对象类型。

## E2 · 单张生成用例与 provider 抽象

- **S2.1**（FR-1.4/AC-3）定义 `ImageGeneratorPort`（generate + family）。
- **S2.2**（FR-1.2/AC-2）定义 `ImageProviderResolverPort` + 解析优先级用例逻辑（providerId>family>active>back-compat），假 resolver 单测。
- **S2.3**（FR-1.5）定义 `MediaStoragePort`（saveImages/copyToProject/saveReferenceImages/importFile/deleteFile）。
- **S2.4**（FR-1.1/1.5/1.6/AC-10/11）实现 `GenerateImageService.generate`：解析→生成→elapsed 实测→skipSave 分支→落盘落库（实测 provider/model）→失败归类。假端口单测。
- **S2.5**（FR-5.2）实现 `ImportMediaService.import`：复制文件+建记录（provider=source），不调生成。
- **S2.6**（AC-10/12）反假数据 smoke：请求 model=A 解析成 B → 落库 B；无成图不显假 metadata。

## E3 · 批量任务状态机

- **S3.1**（NFR-2/AC-9）定义 `MediaJobStatus` + `canTransitionJob` 谓词，非法迁移全矩阵单测。
- **S3.2**（NFR-2/AC-9）定义 `MediaJobItemStatus` + `canTransitionItem` 谓词，含单测。
- **S3.3**（FR-2.1）实现 `MediaJob` 聚合根（start/pause/cancel/finalize/reconcileOnBoot，迁移经谓词校验抛错）。
- **S3.4** 实现 `MediaJobItem` 聚合根（markProcessing/markCompleted/markFailed/cancel）。
- **S3.5** 定义 `BatchConfig`（+ DEFAULT）与 `retry-policy`（isRetryable/computeBackoffMs），含单测（AC-4）。

## E4 · 批量执行器

- **S4.1**（FR-2.2）实现 `BatchExecutor.executeQueue`：按 concurrency 并发消费 pending/可重试 failed，注入 `SchedulerPort`。
- **S4.2**（FR-2.3/AC-4）`processItem`：退避重试（4xx 不重试、指数退避），假 scheduler 断言不真实等待。
- **S4.3**（FR-2.4/AC-5）`pauseJob`：暂停不误杀在跑项，不拉新项。反例单测。
- **S4.4**（FR-2.5/AC-6）`cancelJob`：中断在跑项 + pending/failed→cancelled + completed 保留。
- **S4.5**（FR-2.6/AC-7）`finalizeJob`：全终态定 completed/failed，计数经 recountJobCounters 聚合。
- **S4.6**（FR-2.7/AC-8）`reconcileOnBoot`：running→paused、processing→pending。
- **S4.7** 进度事件流（item_*/job_* + subscribeProgress），SSE 转发。

## E5 · 媒体元数据、标签与 Gallery

- **S5.1**（FR-3.1）`MediaRepository` 媒体记录部分（insert/get/listGallery/updateStatus/setFavorite/delete）。
- **S5.2**（FR-3.2）标签部分（listTags/upsertTag/setGenerationTags）。
- **S5.3**（FR-3.1）实现 `ManageMediaService`（Gallery 分页/收藏/删除/标签）。
- **S5.4**（NFR-6/AC-16）删除连带删盘：`deleteFile` canonical 校验，越界拒删。反例单测。

## E6 · 批量任务上下文回灌

- **S6.1**（FR-4.1）`MediaRepository` 事件部分（insertContextEvent/listUnsyncedEvents/markEventSynced）。
- **S6.2**（FR-4.1/4.2/4.3/AC-13）实现 `MediaContextEventService`（record/listUnsynced/markSynced），synced_at=null 语义。

## E7 · 出站适配器与 NestJS 接线

- **S7.1**（NFR-3）`GeminiImageAdapter` + `OpenAiImageAdapter` 实现 `ImageGeneratorPort` + `ImageGeneratorRouter` 按 family 分发。
- **S7.2**（NFR-6/7）`LocalMediaStorage` 实现 `MediaStoragePort`（canonical 目录 + best-effort 项目复制）。
- **S7.3** `SqliteMediaRepository` 实现 `MediaRepository`（5 张 media_* 表 + recountJobCounters + reconcileOnBoot）。
- **S7.4** `SystemScheduler` 实现 `SchedulerPort`；C7 ProviderResolver 适配器实现 `ImageProviderResolverPort`。
- **S7.5** `MediaController` + `BatchJobController`（含 SSE 进度）。
- **S7.6** `MediaGenerationModule` DI 接线 + `onApplicationBootstrap` 调 reconcileOnBoot + exports 导出用例/端口。
- **S7.7**（NFR-1/AC-14/15）核心包禁用 import 静态扫描（`ai`/`@ai-sdk/*`/`fs`/`better-sqlite3`/`@nestjs/*`/`crypto` 0 命中）+ 无 chat_sessions/messages 写 + 无 StreamSession import + 无 api_providers 写。

---

## Story → AC 追溯矩阵

| AC | 覆盖 Story |
|----|-----------|
| AC-1 尺寸规则 | S1.1, S1.2, S1.3 |
| AC-2 provider 解析优先级 | S2.2 |
| AC-3 换 provider 零改动 | S2.1, S4.x（假适配器）, S7.1 |
| AC-4 退避重试 | S3.5, S4.2 |
| AC-5 暂停不误杀 | S4.3 |
| AC-6 取消 | S4.4 |
| AC-7 终态判定 | S4.5 |
| AC-8 重启补偿 | S3.3, S4.6, S7.3 |
| AC-9 状态机非法迁移 | S3.1, S3.2, S3.3 |
| AC-10 实测 provider/model | S2.4, S2.6 |
| AC-11 失败/skipSave | S2.4 |
| AC-12 无假 metadata | S2.6 |
| AC-13 上下文事件 synced_at | S6.2 |
| AC-14 核心零框架 import | S7.7 |
| AC-15 边界守护 | S7.7 |
| AC-16 磁盘删除安全 | S5.4, S7.2 |

## Sprint 排期建议

- **Sprint 1（领域内核 + 单张生成）**：E1 全部 + E2（S2.1–S2.4/S2.6）+ E3 全部。目标：单张生成用例可跑、尺寸规则与状态机可单测。
- **Sprint 2（批量执行器 + 元数据）**：E4 全部 + E5 全部 + E2 剩余（S2.5）。目标：批量任务并发/退避/暂停/取消/终态/重启全绿，Gallery/标签可用。
- **Sprint 3（回灌 + 适配器接线 + 守护）**：E6 全部 + E7 全部。目标：适配器落地、NestJS 接线、边界静态扫描守护，端到端真实 provider smoke（有凭据时）。
