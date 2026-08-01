---
title: 架构 — C4 MediaGeneration 媒体生成
context: C4 · MediaGeneration
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C4 · MediaGeneration（媒体生成）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。
> 承接现有 CodePilot：`src/lib/image-generator.ts`、`src/lib/job-executor.ts`、`media_generations`/`media_tags`/`media_jobs`/`media_job_items`/`media_context_events` 表。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS MediaController (HTTP: 生成/Gallery/标签/收藏)
                     / BatchJobController (HTTP: Job CRUD/启动/暂停/取消/进度 SSE)
               ↓ 调用驱动端口
        [驱动端口] GenerateImageUseCase / ImportMediaUseCase
                   / RunBatchJobUseCase / ManageMediaUseCase / MediaContextEventUseCase
               ↓
        [应用核心] MediaGeneration 值对象 + 尺寸/family 领域规则（纯函数）
                   + MediaJob/MediaJobItem 聚合根（Job/JobItem 状态机 + 不变量）
                   + BatchExecutor 编排（并发/退避/终态判定，注入 Scheduler）
               ↓ 依赖倒置，只依赖接口
        [出站端口] ImageGeneratorPort（C4 自有，多 provider）
               +   MediaRepository（C4 自有，媒体/标签/Job/Item/事件持久化）
               +   MediaStoragePort（C4 自有，磁盘落盘/复制/删除）
               +   ImageProviderResolverPort（读 C7 解析结果，import type）
               +   SchedulerPort（可控延时，供退避/轮询可测）
               +   SK: IdGenerator / Clock / ErrorClassifier / RuntimeLog / TranslationPort
               ↓ 由适配器实现
        [被驱动适配器] GeminiImageAdapter / OpenAiImageAdapter（各实现 ImageGeneratorPort）
                       + SqliteMediaRepository + LocalMediaStorage
                       + C7 ProviderResolver 适配器 + SystemScheduler（经 DI 注入）
```

依赖方向永远指向核心。C4 核心**只依赖 SK 端口、C7 解析端口接口（import type）、以及 C4 自己的出站端口接口**，绝不 import `ai`/`@ai-sdk/*`/`fs`/`better-sqlite3`/子进程/框架。C4 是**被驱动方**：C2/C9 的 MCP 管线、设计 Agent 前端流程经 `GenerateImageUseCase` 调用 C4，C4 不感知也不反向依赖它们（无环）。批量任务的 AI 规划（planner，把文档拆成 items）是一次文本 AI 调用属 C2，产出的 items 传入 `RunBatchJobUseCase.createJob`——C4 不做 AI 规划。

## 2. 目录结构

```
packages/core/media-generation/
├── domain/
│   ├── generation/
│   │   ├── media-generation.ts       # MediaGeneration 值对象 + MediaGenerationId + MediaStatus
│   │   ├── image-family.ts           # ImageFamily 枚举 + detectFamily 纯函数
│   │   ├── image-size.ts             # GPT Image 2 尺寸规则（computeGptImage2Size/mapAspectToOpenAISize/parseRatio）
│   │   ├── generation-request.ts     # GenerateImageRequest 值对象（归一后请求）
│   │   └── raw-image.ts              # RawImage 值对象（mimeType + bytes，适配器产出的原始图）
│   ├── job/
│   │   ├── media-job.ts              # MediaJob 聚合根（Job 状态机 + 计数投影）
│   │   ├── job-status.ts             # MediaJobStatus 枚举 + canTransitionJob 谓词
│   │   ├── media-job-item.ts         # MediaJobItem 聚合根（Item 状态机 + 重试）
│   │   ├── item-status.ts            # MediaJobItemStatus 枚举 + canTransitionItem 谓词
│   │   ├── batch-config.ts           # BatchConfig 值对象（concurrency/maxRetries/retryDelayMs）
│   │   └── retry-policy.ts           # 退避与可重试判定纯函数（computeBackoff/isRetryable）
│   ├── tag/
│   │   └── media-tag.ts              # MediaTag 值对象
│   ├── context-event/
│   │   └── media-context-event.ts    # MediaContextEvent 值对象 + SyncMode
│   └── message-keys.ts               # C4 自身 i18n 键（c4.*）
├── ports/
│   ├── driving/
│   │   ├── generate-image-usecase.ts # GenerateImageUseCase 端口
│   │   ├── import-media-usecase.ts   # ImportMediaUseCase 端口
│   │   ├── run-batch-job-usecase.ts  # RunBatchJobUseCase 端口
│   │   ├── manage-media-usecase.ts   # ManageMediaUseCase 端口（Gallery/标签/收藏/删除）
│   │   └── media-context-event-usecase.ts # MediaContextEventUseCase 端口
│   └── driven/
│       ├── image-generator-port.ts   # ImageGeneratorPort 出站端口（多 provider 适配器实现）
│       ├── media-repository.ts       # MediaRepository 出站端口（持久化）
│       ├── media-storage-port.ts     # MediaStoragePort 出站端口（磁盘）
│       ├── image-provider-resolver-port.ts # C7 解析结果只读端口（import type 别名）
│       └── scheduler-port.ts         # SchedulerPort（delay/now-based，供退避可测）
├── usecases/
│   ├── generate-image.ts             # GenerateImageService
│   ├── import-media.ts               # ImportMediaService
│   ├── run-batch-job.ts              # RunBatchJobService（建/启/停/取消/查）
│   ├── batch-executor.ts             # BatchExecutor（并发消费 + 退避重试 + 终态判定）
│   ├── manage-media.ts               # ManageMediaService
│   └── media-context-event.ts        # MediaContextEventService
└── index.ts                          # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`GeminiImageAdapter`、`OpenAiImageAdapter`、`SqliteMediaRepository`、`LocalMediaStorage`、`SystemScheduler`、C7 ProviderResolver）位于 `apps/api` 适配器层，不在核心包内。C7 解析端口只是**类型引用**（`import type`），实现由 C7 Module 提供、经 DI 注入。本文件给签名，不给实现。

## 3. 领域模型 (Domain Model)

### 3.1 MediaGeneration — 媒体记录值对象

```ts
// domain/generation/media-generation.ts
export type MediaGenerationId = string;
export type MediaType = 'image' | 'audio' | 'video';
export type MediaStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface SavedImage {
  readonly mimeType: string;
  readonly localPath: string;        // 实测落盘路径（见 §0 breadcrumb）
}

export interface MediaGeneration {
  readonly id: MediaGenerationId;
  readonly type: MediaType;
  readonly status: MediaStatus;
  readonly provider: string;         // 实际运行的 provider 家族（非请求原值）
  readonly model: string;            // 实际上游 model id（解析后）
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly imageSize: string;
  readonly localPath: string;        // 首图路径；status!=completed 时为空
  readonly thumbnailPath: string;
  readonly sessionId?: string;       // C1 会话归属键（仅 id，不含 C1 实体）
  readonly messageId?: string;
  readonly tags: ReadonlyArray<string>;
  readonly metadata: MediaMetadata;
  readonly favorited: boolean;
  readonly error?: string;
  readonly createdAt: number;        // 来自 SK.Clock
  readonly completedAt?: number;
}

export interface MediaMetadata {
  readonly imageCount?: number;      // 实测落盘图数；无 → 不显
  readonly elapsedMs?: number;       // 实测耗时；无 → 隐藏，不显假 0
  readonly model?: string;
  readonly referenceImages?: ReadonlyArray<SavedImage>;
}
```

### 3.2 ImageFamily 与 family 推断（纯函数）

```ts
// domain/generation/image-family.ts
export enum ImageFamily { GEMINI = 'gemini', OPENAI = 'openai' }

/** gpt-image-* / chatgpt-image-* → openai；gemini* → gemini；未知 → undefined。 */
export function detectFamily(modelId: string | undefined): ImageFamily | undefined;
```

### 3.3 图片尺寸领域规则（GPT Image 2，纯函数，对齐现有 image-generator.ts）

```ts
// domain/generation/image-size.ts
export const GPT_IMAGE_2_MAX_EDGE = 3840;
export const GPT_IMAGE_2_MIN_PIXELS = 655_360;
export const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
export const GPT_IMAGE_2_EDGE_STEP = 16;

/** 解析 "w:h" 比例字符串；>3:1 或非法 → null（GPT Image 2 拒收超 3:1）。 */
export function parseRatio(aspectRatio: string): { w: number; h: number } | null;

/**
 * 计算尽量贴近请求比例+tier 的合法 GPT Image 2 尺寸。保证：
 *   每边 16 倍数 / 每边 ≤3840 / 总像素 ∈ [655360, 8294400]。无解 → null。
 */
export function computeGptImage2Size(
  ratio: { w: number; h: number },
  tier: string,                       // '1K' | '2K' | '4K'
): { width: number; height: number } | null;

/**
 * UI aspectRatio + imageSize → OpenAI size "WxH"。
 * legacy gpt-image-1* 折叠到三尺寸（1024²/1536x1024/1024x1536）；
 * 未知 model 按最新（gpt-image-2）处理，不吞 2K/4K。
 */
export function mapAspectToOpenAISize(
  aspectRatio: string,
  imageSize: string,
  modelId?: string,
): `${number}x${number}`;
```

> **边界纪律**：这些是**纯领域规则**，无 I/O、无 SDK 依赖，是 S1/AC-1 可单测的核心资产——从现有 `image-generator.ts` 里剥离出来（原本埋在生成函数同文件），核心包据此换 provider 不改规则。

### 3.4 GenerateImageRequest 与 RawImage

```ts
// domain/generation/generation-request.ts
export interface ReferenceImage { readonly mimeType: string; readonly data: string; } // base64

export interface GenerateImageRequest {
  readonly prompt: string;
  readonly model?: string;
  readonly providerId?: string;       // 显式 provider 行 id
  readonly aspectRatio: string;       // 归一后，默认 '1:1'
  readonly imageSize: string;         // 归一后，默认 '1K'
  readonly referenceImages: ReadonlyArray<ReferenceImage>;
  readonly referenceImagePaths: ReadonlyArray<string>;
  readonly sessionId?: string;
  readonly cwd?: string;              // 解析相对参考图路径
  readonly skipSave: boolean;         // true=不落盘/落库，回原始图（MCP 管线自持久化）
}

// domain/generation/raw-image.ts
export interface RawImage {           // 适配器产出的原始图（未落盘）
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}
```

### 3.5 MediaJobStatus / MediaJobItemStatus — 状态机（本上下文复杂点）

```ts
// domain/job/job-status.ts
export enum MediaJobStatus {
  DRAFT     = 'draft',      // 草稿（未规划）
  PLANNING  = 'planning',   // AI 规划中（规划本身属 C2，C4 仅记状态）
  PLANNED   = 'planned',    // 已规划出 items，待启动
  RUNNING   = 'running',    // 执行中
  PAUSED    = 'paused',     // 暂停（在跑项跑完，不拉新）
  COMPLETED = 'completed',  // 全部达终态且有完成项
  CANCELLED = 'cancelled',  // 用户取消
  FAILED    = 'failed',     // 全部失败、无完成项
}

/**
 * 合法迁移：
 *   draft→planning→planned；planned→running；running↔paused；
 *   running/paused→cancelled；running→completed/failed；paused→running（续跑）。
 * 任意 completed/cancelled/failed 终态 → * 一律非法（返回 false）。
 */
export function canTransitionJob(from: MediaJobStatus, to: MediaJobStatus): boolean;

// domain/job/item-status.ts
export enum MediaJobItemStatus {
  PENDING    = 'pending',
  PROCESSING = 'processing',
  COMPLETED  = 'completed',
  FAILED     = 'failed',      // 可能可重试（retry_count<maxRetries）或永久失败
  CANCELLED  = 'cancelled',
}

/**
 * 合法迁移：pending→processing；processing→completed/failed；
 *   failed→processing（重试）；pending/failed→cancelled。
 * completed/cancelled → * 非法。
 */
export function canTransitionItem(from: MediaJobItemStatus, to: MediaJobItemStatus): boolean;
```

### 3.6 MediaJob / MediaJobItem 聚合根

```ts
// domain/job/media-job.ts
export type MediaJobId = string;

export interface MediaJobSnapshot {
  readonly id: MediaJobId;
  readonly sessionId?: string;
  readonly status: MediaJobStatus;
  readonly docPaths: ReadonlyArray<string>;
  readonly stylePrompt: string;
  readonly batchConfig: BatchConfig;
  readonly totalItems: number;
  readonly completedItems: number;    // 由 recount 聚合，非估算
  readonly failedItems: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface MediaJob {
  snapshot(): MediaJobSnapshot;
  /** planned/paused → running；非法迁移抛 InvalidJobTransition（AC-9）。 */
  start(): void;
  /** running → paused（在跑项不误杀由执行器保证，FR-2.4）。 */
  pause(): void;
  /** running/paused → cancelled。 */
  cancel(): void;
  /** 全 item 终态时定终态：有完成项→completed，否则→failed（FR-2.6）。 */
  finalize(counters: JobCounters): void;
  /** 进程重启补偿：running→paused（FR-2.7）。 */
  reconcileOnBoot(): void;
}

export interface JobCounters { readonly total: number; readonly completed: number; readonly failed: number; }
```

```ts
// domain/job/media-job-item.ts
export type MediaJobItemId = string;

export interface MediaJobItemSnapshot {
  readonly id: MediaJobItemId;
  readonly jobId: MediaJobId;
  readonly idx: number;
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly imageSize: string;
  readonly model: string;
  readonly tags: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<string>;
  readonly status: MediaJobItemStatus;
  readonly retryCount: number;
  readonly resultMediaGenerationId?: string;
  readonly error?: string;
}

export interface MediaJobItem {
  snapshot(): MediaJobItemSnapshot;
  markProcessing(): void;                                   // pending/failed → processing
  markCompleted(mediaGenerationId: MediaGenerationId): void; // → completed + 关联结果
  /** processing → failed；记录 error + retryCount+1。是否还可重试由 retry-policy 判定。 */
  markFailed(error: string): void;
  cancel(): void;                                           // pending/failed → cancelled
}
```

### 3.7 BatchConfig 与 RetryPolicy（纯函数）

```ts
// domain/job/batch-config.ts
export interface BatchConfig {
  readonly concurrency: number;   // 默认 2
  readonly maxRetries: number;    // 默认 2
  readonly retryDelayMs: number;  // 默认 2000（指数退避基数）
}
export const DEFAULT_BATCH_CONFIG: BatchConfig;

// domain/job/retry-policy.ts
/** 4xx（400/401/403）不可重试；其余按 retryCount<maxRetries 可重试（FR-2.3/AC-4）。 */
export function isRetryable(statusCode: number | undefined, retryCount: number, maxRetries: number): boolean;
/** 指数退避：retryDelayMs * 3^(retryCount-1)。 */
export function computeBackoffMs(retryDelayMs: number, retryCount: number): number;
```

### 3.8 MediaTag / MediaContextEvent

```ts
// domain/tag/media-tag.ts
export interface MediaTag { readonly id: number; readonly name: string; readonly color: string; readonly createdAt: number; }

// domain/context-event/media-context-event.ts
export type SyncMode = 'manual' | 'auto_batch';
export interface MediaContextEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly jobId: MediaJobId;
  readonly payload: string;          // JSON（Job 产出摘要），C4 不解释语义只存取
  readonly syncMode: SyncMode;
  readonly syncedAt?: number;        // undefined = 未回灌（FR-4.3）
  readonly createdAt: number;
}
```

## 4. 驱动端口 (Driving Ports)

### 4.1 GenerateImageUseCase

```ts
// ports/driving/generate-image-usecase.ts
export interface GenerateImageResult {
  mediaGenerationId: MediaGenerationId;   // skipSave 时为空
  images: ReadonlyArray<SavedImage & { rawData?: Uint8Array }>;
  elapsedMs: number;
  model: string;                          // 实际 model（解析后，非请求原值）
  family: ImageFamily;                    // 实际运行 family
}

export interface GenerateImageUseCase {
  /**
   * 生成单张图片（FR-1）：
   *  1. 归一请求（默认比例/尺寸）→ GenerateImageRequest。
   *  2. 经 ImageProviderResolverPort 解析 provider（FR-1.2 优先级）→ 定 family + model。
   *  3. 经 ImageGeneratorPort.generate 拿 RawImage[]（FR-1.4）；elapsed 经 Clock 实测。
   *  4. skipSave=true → 直接回原始图，不落盘不落库（FR-1.5）。
   *  5. 否则经 MediaStoragePort 落盘 + 项目目录复制 + 参考图落盘；
   *     经 MediaRepository.insertGeneration 落库（provider/model 记实测值，§0）。
   *  6. 失败 → ErrorClassifier 归类 + 记 status='failed'，抛结构化错误（FR-1.6）。
   */
  generate(request: GenerateImageRequest): Promise<GenerateImageResult>;
}
```

### 4.2 ImportMediaUseCase

```ts
// ports/driving/import-media-usecase.ts
export interface ImportMediaInput {
  filePath: string;
  cwd?: string;
  title?: string; prompt?: string; source?: string;   // source → provider 字段（如 'dreamina'）
  model?: string; resolution?: string; aspectRatio?: string;
  tags?: ReadonlyArray<string>;
  sessionId?: string;
}
export interface ImportMediaUseCase {
  /** 把既有文件（CLI 生成结果）纳入素材库：复制到媒体目录 + 建 DB 记录，不调图片生成（FR-5.2）。 */
  import(input: ImportMediaInput): Promise<MediaGenerationId>;
}
```

### 4.3 RunBatchJobUseCase

```ts
// ports/driving/run-batch-job-usecase.ts
export interface CreateJobInput {
  sessionId?: string;
  items: ReadonlyArray<{
    prompt: string; aspectRatio?: string; imageSize?: string;
    model?: string; tags?: ReadonlyArray<string>; sourceRefs?: ReadonlyArray<string>;
  }>;
  batchConfig?: Partial<BatchConfig>;
  stylePrompt?: string;
  docPaths?: ReadonlyArray<string>;
}

export interface RunBatchJobUseCase {
  /** 建 Job(planned) + N 个 Item(pending)（FR-2.1）；items 由上层 AI 规划产出，C4 不做规划。 */
  createJob(input: CreateJobInput): Promise<MediaJobId>;
  /** 启动/续跑：planned/paused → running，BatchExecutor 并发消费（FR-2.2）。 */
  startJob(jobId: MediaJobId): Promise<void>;
  /** 暂停：running → paused，在跑项跑完不误杀（FR-2.4）。 */
  pauseJob(jobId: MediaJobId): void;
  /** 取消：中断在跑项 + pending/failed → cancelled + Job → cancelled（FR-2.5）。 */
  cancelJob(jobId: MediaJobId): void;
  /** 订阅进度事件（item_started/completed/failed/retry, job_completed/paused/cancelled）。 */
  subscribeProgress(jobId: MediaJobId, listener: (e: JobProgressEvent) => void): () => void;
  getJob(jobId: MediaJobId): Promise<MediaJobSnapshot | undefined>;
  listItems(jobId: MediaJobId): Promise<ReadonlyArray<MediaJobItemSnapshot>>;
}

export interface JobProgressEvent {
  type: 'item_started' | 'item_completed' | 'item_failed' | 'item_retry'
      | 'job_completed' | 'job_paused' | 'job_cancelled';
  jobId: MediaJobId; itemId?: MediaJobItemId; itemIdx?: number;
  progress: { total: number; completed: number; failed: number; processing: number };
  error?: string; retryCount?: number; mediaGenerationId?: MediaGenerationId; timestamp: number;
}
```

### 4.4 ManageMediaUseCase / MediaContextEventUseCase

```ts
// ports/driving/manage-media-usecase.ts
export interface ManageMediaUseCase {
  getById(id: MediaGenerationId): Promise<MediaGeneration | undefined>;
  listGallery(query: { limit: number; offset: number; status?: MediaStatus; sessionId?: string }): Promise<ReadonlyArray<MediaGeneration>>;
  toggleFavorite(id: MediaGenerationId, favorited: boolean): Promise<void>;
  remove(id: MediaGenerationId): Promise<boolean>;          // 连带删磁盘文件（NFR-6/AC-16）
  listTags(): Promise<ReadonlyArray<MediaTag>>;
  createTag(name: string, color: string): Promise<MediaTag>;
  setTags(id: MediaGenerationId, tags: ReadonlyArray<string>): Promise<void>;
}

// ports/driving/media-context-event-usecase.ts
export interface MediaContextEventUseCase {
  record(input: { sessionId: string; jobId: MediaJobId; payload: string; syncMode: SyncMode }): Promise<string>;
  listUnsynced(sessionId: string): Promise<ReadonlyArray<MediaContextEvent>>;  // synced_at=null（FR-4.3）
  markSynced(eventId: string): Promise<void>;              // 写实测 synced_at
}
```

## 5. 出站端口 (Driven Ports)

### 5.1 ImageGeneratorPort（C4 自有；多 provider 适配器实现）

```ts
// ports/driven/image-generator-port.ts
export interface ImageGenRequest {
  family: ImageFamily;
  model: string;                      // 已解析
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  referenceImagesBase64: ReadonlyArray<string>;
  abortSignal?: AbortSignalLike;
}
export interface ImageGeneratorPort {
  /** 发起一次原生图片生成，产出归一后的 RawImage[]。provider SDK 差异全在适配器内（FR-1.4/NFR-3）。 */
  generate(request: ImageGenRequest): Promise<ReadonlyArray<RawImage>>;
  /** 该适配器负责的 family（供路由器按 family 分发）。 */
  readonly family: ImageFamily;
}
```
- **实现位置**：`GeminiImageAdapter` / `OpenAiImageAdapter`（封装 `ai` + `@ai-sdk/google`/`@ai-sdk/openai`）。新增 provider = 新增一个适配器 + 路由注册（AC-3）。
- **对外提供**：契约 `C4 对外提供端口：ImageGeneratorPort`。

### 5.2 MediaRepository（C4 自有）

```ts
// ports/driven/media-repository.ts
export interface MediaRepository {
  // — 媒体记录 —
  insertGeneration(record: MediaGeneration): Promise<void>;
  getGeneration(id: MediaGenerationId): Promise<MediaGeneration | undefined>;
  listGallery(q: { limit: number; offset: number; status?: MediaStatus; sessionId?: string }): Promise<ReadonlyArray<MediaGeneration>>;
  updateGenerationStatus(id: MediaGenerationId, status: MediaStatus, error?: string): Promise<void>;
  setFavorite(id: MediaGenerationId, favorited: boolean): Promise<void>;
  setGenerationTags(id: MediaGenerationId, tags: ReadonlyArray<string>): Promise<void>;
  deleteGeneration(id: MediaGenerationId): Promise<{ localPath: string } | undefined>; // 回路径供删盘
  // — 标签 —
  listTags(): Promise<ReadonlyArray<MediaTag>>;
  upsertTag(name: string, color: string): Promise<MediaTag>;
  // — Job / Item —
  insertJob(job: MediaJobSnapshot): Promise<void>;
  getJob(id: MediaJobId): Promise<MediaJobSnapshot | undefined>;
  listJobsBySession(sessionId: string): Promise<ReadonlyArray<MediaJobSnapshot>>;
  updateJobStatus(id: MediaJobId, status: MediaJobStatus, completedAt?: number): Promise<void>;
  insertItems(items: ReadonlyArray<MediaJobItemSnapshot>): Promise<void>;
  listItems(jobId: MediaJobId): Promise<ReadonlyArray<MediaJobItemSnapshot>>;
  listPendingItems(jobId: MediaJobId, maxRetries: number): Promise<ReadonlyArray<MediaJobItemSnapshot>>;
  updateItem(id: MediaJobItemId, patch: Partial<Pick<MediaJobItemSnapshot,'status'|'retryCount'|'resultMediaGenerationId'|'error'>>): Promise<void>;
  cancelPendingItems(jobId: MediaJobId): Promise<void>;
  /** 按 item 实际状态聚合 Job 计数（FR-2.6，非估算，§0）。 */
  recountJobCounters(jobId: MediaJobId): Promise<JobCounters>;
  /** 进程重启补偿：running Job→paused、processing item→pending（FR-2.7/AC-8）。 */
  reconcileOnBoot(): Promise<void>;
  // — 上下文事件 —
  insertContextEvent(event: MediaContextEvent): Promise<void>;
  listUnsyncedEvents(sessionId: string): Promise<ReadonlyArray<MediaContextEvent>>;
  markEventSynced(eventId: string, syncedAt: number): Promise<void>;
}
```
- **实现位置**：`SqliteMediaRepository`（直写 5 张 media_* 表）。**对外提供**：契约 `C4 对外提供端口：MediaRepository`——供上层（Gallery UI / Bridge 回灌）读媒体与事件。

### 5.3 MediaStoragePort / SchedulerPort（C4 自有）

```ts
// ports/driven/media-storage-port.ts
export interface MediaStoragePort {
  /** 写原始图到 .codepilot-media/ canonical 目录，返回 SavedImage[]（NFR-6/7）。 */
  saveImages(images: ReadonlyArray<RawImage>): Promise<ReadonlyArray<SavedImage>>;
  /** 复制到项目 .codepilot-images/（sessionId 有 cwd 时）。best-effort，失败不阻断。 */
  copyToProject(saved: ReadonlyArray<SavedImage>, workingDir: string): Promise<void>;
  /** 落盘参考图（base64 → 文件），返回路径。 */
  saveReferenceImages(refs: ReadonlyArray<ReferenceImage>): Promise<ReadonlyArray<SavedImage>>;
  /** 导入既有文件到媒体目录（ImportMedia 用）。 */
  importFile(filePath: string, cwd?: string): Promise<SavedImage>;
  /** 删除 canonical 路径文件；越界路径拒删（AC-16）。 */
  deleteFile(localPath: string): Promise<void>;
}

// ports/driven/scheduler-port.ts
export interface SchedulerPort {
  now(): number;                                    // 委托 SK.Clock
  delay(ms: number, signal?: AbortSignalLike): Promise<void>;  // 退避/轮询可测（NFR-5/AC-4）
}
```

### 5.4 ImageProviderResolverPort（读 C7 解析结果，import type 别名）

```ts
// ports/driven/image-provider-resolver-port.ts
export interface ResolvedImageProvider {
  readonly providerRowId: string;
  readonly family: ImageFamily;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;             // 从 extra_env / 默认解析后的最终 model
}
export interface ImageProviderResolverPort {
  /**
   * 解析图片 provider（FR-1.2 优先级）：providerId 显式 > family 推断 > active 设置 > back-compat。
   * 实现读 C7 的 Provider 配置（api_providers 中 gemini-image/openai-image 行），C4 只读消费。
   */
  resolve(hint: { providerId?: string; family?: ImageFamily }): Promise<ResolvedImageProvider>;
}
```
- **契约来源**：C4「不含 Provider 配置管理」——图片 provider 配置归 C7。现有 `pickImageProvider` 直查 `api_providers` 属越界，重构后经此端口拿 C7 解析结果。C4 只 `import type`，实现由 C7/适配器提供。

## 6. 用例编排要点

- **6.1 GenerateImageService.generate** —— `startedAt←Clock.now()`；归一比例/尺寸；`resolver.resolve` 定 family+model；`generator.generate` 拿 `RawImage[]`；`elapsedMs = Clock.now()-startedAt`（实测）。`skipSave` → 组装 `rawData` 直接返回（`mediaGenerationId=''`）。否则 `storage.saveImages` + `copyToProject` + `saveReferenceImages`；`id←IdGenerator.next()`；`repo.insertGeneration`（`provider=family`、`model=解析值`、`metadata.elapsedMs/imageCount` 实测——§0/AC-10）。异常经 `ErrorClassifier.classify` → 记 failed + 抛。
- **6.2 BatchExecutor（对齐现有 job-executor.ts，结构化沉淀）** —— 取代 `globalThis` 单例 + `setTimeout` 轮询：
  ```ts
  // usecases/batch-executor.ts（编排要点，非完整实现）
  async function executeQueue(job: MediaJob, config: BatchConfig): Promise<void> {
    const active = new Set<Promise<void>>();
    while (job.snapshot().status === MediaJobStatus.RUNNING) {
      const pending = await repo.listPendingItems(jobId, config.maxRetries);
      if (pending.length === 0 && active.size === 0) break;      // 全部完成
      while (job.snapshot().status === RUNNING && active.size < config.concurrency) {
        const next = pickNext(pending);                          // pending 或可重试 failed
        if (!next) break;
        const p = processItem(job, next, config).finally(() => active.delete(p));
        active.add(p);
      }
      await scheduler.delay(POLL_MS);                            // 可控延时（NFR-5）
    }
    await finalizeJob(job);                                       // FR-2.6 终态判定 + recount
  }
  ```
  `processItem`：若 `retryCount>0` 先 `scheduler.delay(computeBackoffMs(...))`（AC-4）；`item.markProcessing()` + emit；`generateImageUseCase.generate(...)` → 成功 `item.markCompleted(mediaId)`；失败经 `isRetryable(statusCode, retryCount, maxRetries)` 决定重试或永久 failed（`item.markFailed`）。计数经 `repo.recountJobCounters`（§0）。
- **6.3 暂停不误杀（FR-2.4/AC-5）** —— `pauseJob` 只 `job.pause()`（→paused）；`executeQueue` 的 while 条件检测到非 RUNNING 停止拉新，但 `active` 集里在跑的 `processItem` 不 abort，跑完落 completed。
- **6.4 取消（FR-2.5/AC-6）** —— `cancelJob`：`job.cancel()` + abort 在跑项的 signal + `repo.cancelPendingItems`（pending/failed→cancelled），completed 项不动。
- **6.5 终态判定（FR-2.6/AC-7）** —— `finalizeJob`：`recountJobCounters` → 全 item 终态且 completed>0 → `job.finalize()` 定 completed，全 failed 且 completed=0 → failed；emit `job_completed`。
- **6.6 重启补偿（FR-2.7/AC-8）** —— app 启动时 `repo.reconcileOnBoot()`（running Job→paused、processing item→pending），对齐现有 db.ts 启动补偿事务。
- **6.7 上下文回灌（FR-4）** —— `MediaContextEventService.record` 建事件（`synced_at=null`）；`markSynced` 写实测时刻。C4 只存取事件，**不构造消息注入会话**（那属 Bridge/上层经 C1/C2）。
- 所有用户可见文案用 `c4.*` messageKey 经 `SK.TranslationPort`；错误文案 key 来自 `SK.ErrorClassifier`；关键路径经 `SK.RuntimeLog`（source=`c4.generate`/`c4.batch`）。

## 7. 被驱动适配器（apps/api，隔离 SDK/磁盘/DB）

> 核心零框架；下列适配器实现 C4 出站端口。核心 `domain`/`usecases` 代码**不出现** `ai`/`@ai-sdk/*`/`fs`/`better-sqlite3`（NFR-1/AC-14）。

### 7.1 GeminiImageAdapter / OpenAiImageAdapter（实现 ImageGeneratorPort）
- 封装 `ai` 的 `generateImage` + `@ai-sdk/google` / `@ai-sdk/openai`（对齐现有 `image-generator.ts` 的两分支）。
- OpenAI 分支用 `mapAspectToOpenAISize`（领域纯函数）算 size；参考图经 `prompt.images` 路由 /images/edits。Gemini 分支用 `providerOptions.google.imageConfig`。
- 各带 `family` 标识供 `ImageGeneratorRouter` 按 family 分发。**新增 provider 只加一个适配器**（NFR-3/AC-3）。

### 7.2 LocalMediaStorage（实现 MediaStoragePort）
- 落盘到 `~/.codepilot/.codepilot-media/`（canonical），文件名 `${timestamp}-${randomHex}${ext}`；`deleteFile` 校验路径在 canonical 目录内才删（NFR-6/AC-16）。
- `copyToProject` 复制到 session working dir 的 `.codepilot-images/`，best-effort。

### 7.3 SqliteMediaRepository（实现 MediaRepository）
- 直写 5 张表（`media_generations`/`media_tags`/`media_jobs`/`media_job_items`/`media_context_events`），承接现有 db.ts 的 media 相关函数。
- `recountJobCounters` = `SELECT COUNT(*) ... WHERE status='completed'/'failed'`（实际状态聚合，§0）。
- `reconcileOnBoot` = 现有启动补偿事务（running→paused、processing→pending）。

### 7.4 C7 ProviderResolver 适配器（实现 ImageProviderResolverPort）
- 经 C7 的 `ProviderRepository`（只读）拿 gemini-image/openai-image 行 + extra_env 解析 model，落地「C4 不管 Provider 配置」的边界。

## 8. 依赖注入接线 (NestJS 侧)

```
MediaGenerationModule (apps/api)
  imports: [SharedKernelModule,          // IdGenerator/Clock/ErrorClassifier/RuntimeLog/TranslationPort
            ProviderManagementModule]    // 注入 C7 解析（ImageProviderResolverPort 适配器）
  provides:
    GenerateImageUseCase    → GenerateImageService(ImageGeneratorRouter, ImageProviderResolverPort,
                                                   MediaStoragePort, MediaRepository,
                                                   IdGenerator, Clock, ErrorClassifier, RuntimeLog)
    ImportMediaUseCase      → ImportMediaService(MediaStoragePort, MediaRepository, IdGenerator, Clock)
    RunBatchJobUseCase      → RunBatchJobService(BatchExecutor, MediaRepository, IdGenerator, Clock)
                              // BatchExecutor(GenerateImageUseCase, MediaRepository, SchedulerPort, ErrorClassifier)
    ManageMediaUseCase      → ManageMediaService(MediaRepository, MediaStoragePort)
    MediaContextEventUseCase→ MediaContextEventService(MediaRepository, IdGenerator, Clock)
    ImageGeneratorPort      → ImageGeneratorRouter([GeminiImageAdapter, OpenAiImageAdapter])
                               // 按 ImageFamily 路由；新增 provider 追加适配器（AC-3）
    MediaRepository         → SqliteMediaRepository
    MediaStoragePort        → LocalMediaStorage
    SchedulerPort           → SystemScheduler
  exports:
    GenerateImageUseCase,   // 供 C2/C9 的 MCP 管线（codepilot_generate_image）+ 设计 Agent 前端流程调用
    ImportMediaUseCase,     // 供 codepilot_import_media
    RunBatchJobUseCase,
    ImageGeneratorPort,     // 契约对外提供
    MediaRepository         // 契约对外提供（Gallery/Bridge 回灌读取）
  controllers:
    MediaController     (POST /api/media/generate 单张; GET /api/media/gallery; 
                         GET/DELETE /api/media/:id; POST /api/media/:id/favorite; /api/media/tags*)
    BatchJobController  (POST /api/media/jobs 建; POST /jobs/:id/start|pause|cancel; 
                         GET /jobs/:id 进度; SSE /jobs/:id/progress)
  onApplicationBootstrap:
    MediaRepository.reconcileOnBoot()   // running→paused、processing→pending（FR-2.7）
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。**无跨上下文环**：C4 单向被 C2/C9 消费（经导出用例），单向消费 C7（经 ImageProviderResolverPort），不反向依赖任何上下文——无 forwardRef 需求。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `SK.IdGenerator` | C4 依赖 SK | context-boundaries.md：C4「依赖端口：SK.IdGenerator」 |
| `SK.Clock`/`ErrorClassifier`/`RuntimeLog`/`TranslationPort` | C4 依赖 SK（横切） | SK 对外端口清单（横切全上下文） |
| `GenerateImageUseCase` | C4 对外提供 | C4「对外提供端口：GenerateImageUseCase」（供 C2/C9 MCP + 设计 Agent） |
| `RunBatchJobUseCase` | C4 对外提供 | C4「对外提供端口：RunBatchJobUseCase」 |
| `ImageGeneratorPort` | C4 对外提供（自有多 provider） | C4「对外提供端口：ImageGeneratorPort」 |
| `MediaRepository` | C4 对外提供 | C4「对外提供端口：MediaRepository」（Gallery/Bridge 读取媒体与事件） |
| `ImageProviderResolverPort`（读 C7 配置） | C4 依赖 C7（只读） | C4「不含 Provider 配置管理」；C7「ProviderRepository 供消费」——图片 provider 配置归 C7 |

**边界纪律自检**：
- C4 未定义/未重写任何 SK 概念（IdGenerator/Clock/ErrorClassifier 只引用）；未定义 C7 的 Provider 配置概念，只经 `ImageProviderResolverPort` 读解析结果（不写 `api_providers`）。
- C4 核心**不含**会话/消息持久化（`chat_sessions`/`messages`，只持 sessionId/messageId 归属键）、文本 AI 流（无 `StreamSession`/`AgentStreamEvent`）、批量任务的 AI 规划（planner 属 C2，产出 items 传入 `createJob`）、MCP 工具调用编排（`codepilot_generate_image`/`MEDIA_RESULT_MARKER` 如何注入对话属 C2/C9，C4 只提供被调用的用例）。
- C4 核心不 import `ai` / `@ai-sdk/*` / `fs` / `path` / `os` / `crypto` / `better-sqlite3` / `@nestjs/*`；SDK/磁盘/DB/id 生成全在适配器或经端口（NFR-1/AC-14）。
- 图片尺寸/family 领域规则（`computeGptImage2Size`/`mapAspectToOpenAISize`/`detectFamily`）是纯函数留核心可测；provider SDK 调用锁在 `ImageGeneratorPort` 适配器后（AC-1/AC-3）。
- Job/JobItem 状态机迁移经 `canTransitionJob`/`canTransitionItem` 校验，非法迁移抛错（NFR-2/AC-9）。
- 元数据 `provider`/`model`/`elapsedMs` 记实测投影，不把请求参数/默认值当实测（§0/AC-10/AC-12）。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，无 dev server / 无真实 SDK-磁盘-网络）：
  - `mapAspectToOpenAISize`/`computeGptImage2Size`/`parseRatio` 表驱动全矩阵（AC-1）：各比例×各 tier 满足 16 倍数/≤3840/像素预算四约束；legacy 折叠三尺寸；未知 model 按最新。
  - `detectFamily` 前缀推断；provider 解析优先级（AC-2，假 resolver）。
  - `canTransitionJob`/`canTransitionItem` 合法/非法迁移全矩阵（AC-9）；聚合根迁移方法幂等性。
  - `isRetryable`/`computeBackoffMs` 退避策略（AC-4）：4xx 立即 failed、5xx 退避重试超限 failed、退避时长指数。
  - **BatchExecutor 核心反例 smoke**：假 `ImageGeneratorPort`（可控成功/失败/延时）+ 假 `SchedulerPort`（不真实等待）：
    - AC-5 暂停不误杀：pause 时在跑项跑完落 completed、不拉新项。
    - AC-6 取消：在跑项 abort、pending/failed→cancelled、completed 保留。
    - AC-7 终态判定：全终态有完成→completed、全失败→failed、计数=recount 聚合（非请求项数）。
    - AC-3 换 provider 反例：加一个假 family 适配器，执行器与用例零改动跑通。
  - `reconcileOnBoot`（AC-8，假 repo）：running→paused、processing→pending。
- 反假数据 smoke（AC-10/12）：构造「请求 model=A 适配器解析成 B」→ 落库 `model=B`/`family=B`；假 Clock 使 elapsed 可控 → 无成图时 metadata 不显假 imageCount/elapsed。
- 生成失败/skipSave（AC-11）：失败记 `status='failed'`+error 不返回可渲染 localPath；skipSave 不落盘不落库只回 rawData。
- 上下文事件（AC-13）：record 后 `synced_at=null` 计入 listUnsynced；markSynced 后有实测时刻。
- 磁盘安全（AC-16，假 storage）：deleteFile 越界路径拒删、canonical 路径正常删。
- 静态检查（AC-14/15）：`media-generation/` 核心包 `ai`/`@ai-sdk/*`/`fs`/`better-sqlite3`/`@nestjs/*`/`crypto` 0 命中；无 `chat_sessions`/`messages` 写、无 `StreamSession`/`AgentStreamEvent` import、无 `api_providers` 写。
