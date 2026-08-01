---
title: 架构 — C8 Workspace 工作区
context: C8 · Workspace
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C8 · Workspace（工作区）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律与目录结构见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 依赖的 SK 端口签名风格见 [../shared-kernel/architecture.md](../shared-kernel/architecture.md)。

## 1. 上下文定位与依赖方向

```
        [驱动适配器] NestJS WorkspaceController (HTTP: GET /api/files/tree, GET /api/files/preview)
               ↓ 调用驱动端口
        [驱动端口] BrowseFilesUseCase
               ↓
        [应用核心] Domain Model + Use Cases（纯逻辑，零框架，零 fs/path/os）
               ↓ 依赖倒置，只依赖接口
        [出站端口] FileSystemPort
               +   （横切）SK: Redactor / ErrorClassifier / RuntimeLog / TranslationPort
               ↓ 由适配器实现
        [被驱动适配器] NodeFsAdapter（本机进程直读 fs/promises + createReadStream + path 安全）
                       └─ 预留 RemoteFsAdapter（未来远程，同一 FileSystemPort，核心零改动）
```

依赖方向永远指向核心。C8 核心**只依赖 `FileSystemPort` 接口与横切 SK 端口**，绝不 import `fs`/`path`/`os`/`readline`/框架/DB。按边界契约，C8 对**业务上下文**依赖为"无"——它不消费任何 C1–C10 的端口，是最独立的上下文之一。C8 也不被其他上下文依赖其内部（"文件如何被 AI 使用"属 C2，与 C8 无端口耦合）。

**本机 Web 应用的关键点**：`FileSystemPort` 的默认实现 `NodeFsAdapter` 之所以能直读用户本地磁盘，正因为 NestJS 后端跑在用户本机 localhost，是拥有完整本地文件权限的 Node 进程。这是"本机 Web 应用"相对"远程 SaaS"的结构性优势——同一份 `BrowseFilesUseCase`，本机形态注入 `NodeFsAdapter` 直读磁盘；未来远程形态只需注入 `RemoteFsAdapter`，核心与用例不动。

## 2. 目录结构

```
packages/core/workspace/
├── domain/
│   ├── tree/
│   │   ├── file-tree-node.ts        # FileTreeNode 值对象（文件/目录节点）
│   │   └── scan-options.ts          # ScanOptions 值对象（depth / 忽略规则快照）
│   ├── preview/
│   │   ├── file-preview.ts          # FilePreview 值对象（预览结果）
│   │   ├── preview-limits.ts        # 行数上限 / byte 上限 / 二进制采样常量 + getLineCap 纯函数
│   │   └── language-map.ts          # LANGUAGE_MAP + getFileLanguage 纯函数
│   ├── safety/
│   │   ├── path-safety-policy.ts    # 路径安全纯函数（对已归一字符串判定，不做 I/O）
│   │   ├── ignored-dirs.ts          # IGNORED_DIRS / BLOCKED_SEGMENTS / WINDOWS_RESERVED 常量
│   │   └── filename-rules.ts        # isValidFilename 纯函数
│   ├── error/
│   │   ├── file-system-error.ts     # FileSystemError + FileSystemErrorCode（路径安全/存在性）
│   │   └── file-preview-error.ts    # FilePreviewError + FilePreviewErrorCode（预览专属 5 类）
│   └── message-keys.ts              # C8 自身 i18n 键（c8.*）
├── ports/
│   ├── driving/
│   │   └── browse-files-usecase.ts  # BrowseFilesUseCase 驱动端口
│   └── driven/
│       └── file-system-port.ts      # FileSystemPort 出站端口（唯一 I/O 出口）
├── usecases/
│   └── browse-files.ts              # BrowseFilesService（实现 driving 端口，编排 FileSystemPort + 领域纯函数）
└── index.ts                         # 桶文件：仅导出端口与领域类型
```

> 具体适配器（`NodeFsAdapter`）位于 `apps/api` 适配器层，不在核心包内。本文件给签名，不给实现。领域层的路径安全**只放纯判定函数**（输入已归一的字符串，输出通过/拒绝）；真正的 `path.resolve` / `fs.realpath` I/O 归 `NodeFsAdapter`——见 §7 路径安全归属。

## 3. 领域模型 (Domain Model)

### 3.1 FileTreeNode — 文件树节点值对象

```ts
// domain/tree/file-tree-node.ts
export type FileNodeType = 'file' | 'directory';

export interface FileTreeNode {
  readonly name: string;                        // basename
  readonly path: string;                        // 已归一的绝对路径（供 UI 按路径点开）
  readonly type: FileNodeType;
  readonly size?: number;                        // 仅文件；来自 stat().size 实测，失败留空（不填 0）
  readonly extension?: string;                   // 仅文件；不含前导点，无扩展名留空
  readonly children?: ReadonlyArray<FileTreeNode>; // 仅目录；深度耗尽或空目录为 []
}
```

> 字段对齐现有 `@/types` 的 `FileTreeNode`。`size`/`extension`/`children` 用可选而非默认值，落实反假数据："stat 失败留空"而非"填 0"。

### 3.2 ScanOptions — 扫描选项值对象

```ts
// domain/tree/scan-options.ts
export interface ScanOptions {
  readonly depth: number;                        // 递归深度上限，默认 3
  readonly includeDotEnv: boolean;               // .env* 是否保留（默认 true，对齐现有）
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { depth: 3, includeDotEnv: true };
```

### 3.3 FilePreview — 预览结果值对象

```ts
// domain/preview/file-preview.ts
export interface FilePreview {
  readonly path: string;                         // 已归一绝对路径
  readonly content: string;                      // 截断后的文本内容（≤ maxLines 行）
  readonly language: string;                     // getFileLanguage 结果，未知='plaintext'
  readonly line_count: number;                   // 未截断=精确扫描数；截断=按字节估算
  readonly line_count_exact: boolean;            // ≡ !truncated（反假数据红线）
  readonly truncated: boolean;                   // 是否命中行数上限
  readonly bytes_read: number;                   // content 的实际 UTF-8 字节数
  readonly bytes_total: number;                  // stat().size 实测
}
```

> 字段对齐现有 `readFilePreview` 返回体。**不变量**：`line_count_exact === !truncated`，且 `truncated === true` 时 `line_count` 语义为估算——UI 据此显示"约 N 行"。这是 C8 反假数据的核心契约。

### 3.4 预览上限与语言映射（领域纯函数）

```ts
// domain/preview/preview-limits.ts
export const BYTE_CEILING = 10 * 1024 * 1024;    // 10 MB 单文件硬顶
export const BINARY_DETECTION_SAMPLE = 4096;      // 二进制探测采样字节数
export const DEFAULT_LINE_CAP = 1000;
export const ABSOLUTE_LINE_CEILING = 100000;
export const EXTENSION_LINE_CAPS: Readonly<Record<string, number>> = {
  md: 50000, mdx: 50000, txt: 50000, log: 10000, csv: 10000, tsv: 10000,
};

/** 结合扩展名上限、用户上限、绝对硬顶取最小；无扩展名走 DEFAULT_LINE_CAP。纯函数。 */
export function getLineCap(ext: string, userMax?: number): number;

/** 二进制探测启发式（NUL 或 >30% 非文本字节）。输入采样 buffer 的字节视图，纯函数。 */
export function looksBinary(sample: Uint8Array): boolean;

// domain/preview/language-map.ts
export const LANGUAGE_MAP: Readonly<Record<string, string>>;   // ts→typescript, py→python, ...
/** 按扩展名映射语法高亮语言；未知归 'plaintext'。纯函数。 */
export function getFileLanguage(ext: string): string;
```

> `looksBinary` 接收 `Uint8Array`（而非 Node `Buffer`）以保持核心零 Node 依赖；采样字节由 `FileSystemPort.sampleHead` 提供。`getLineCap`/`getFileLanguage`/`looksBinary` 全为纯函数，可表驱动单测（NFR-7）。

### 3.5 路径安全策略（领域纯判定 + 常量）

```ts
// domain/safety/ignored-dirs.ts
export const IGNORED_DIRS: ReadonlySet<string>;        // 扫描忽略：node_modules/.git/dist/.next/...
export const BLOCKED_SEGMENTS: ReadonlySet<string>;    // 受保护：.git/node_modules/系统目录/...
export const WINDOWS_RESERVED: ReadonlySet<string>;    // CON/PRN/NUL/COM1-9/LPT1-9

// domain/safety/path-safety-policy.ts
// 说明：以下函数只对【已归一的字符串】做判定，不做 path.resolve / fs.realpath（那属适配器）。
//       归一 + realpath 由 NodeFsAdapter 完成后，把结果字符串喂进这些纯函数判定。

/** resolvedTarget 是否落在 resolvedBase 围栏内（前缀 + sep 或相等）。纯函数。 */
export function isWithinBase(resolvedBase: string, resolvedTarget: string, sep: string): boolean;

/** 已归一路径是否为文件系统根（等于其 parse().root）。判定入参由适配器算好 root 传入。纯函数。 */
export function isRootPath(resolved: string, root: string): boolean;

/** 已归一路径任一 segment 命中 BLOCKED_SEGMENTS 或以 '.env' 开头。纯函数。 */
export function isBlockedPath(resolved: string, sep: string): boolean;

// domain/safety/filename-rules.ts
/** 文件名合法性（非空、无 NUL、无分隔符、非 Windows 保留名）。纯函数，供未来写扩展复用。 */
export function isValidFilename(name: string): boolean;
```

### 3.6 结构化错误

```ts
// domain/error/file-preview-error.ts
export type FilePreviewErrorCode =
  | 'not_found' | 'not_a_file' | 'file_too_large'
  | 'binary_not_previewable' | 'read_failed';

export class FilePreviewError extends Error {
  constructor(
    public readonly code: FilePreviewErrorCode,
    public readonly messageKey: string,           // c8.* i18n 键，经 SK.TranslationPort 渲染
    public readonly meta?: Readonly<Record<string, unknown>>,  // 如 { bytes_total, byte_limit }
  );
}

// domain/error/file-system-error.ts
export type FileSystemErrorCode =
  | 'path_unsafe' | 'root_path' | 'symlink_detected'
  | 'blocked_directory' | 'not_found' | 'not_a_file';

export class FileSystemError extends Error {
  constructor(
    public readonly code: FileSystemErrorCode,
    public readonly messageKey: string,
    public readonly meta?: Readonly<Record<string, unknown>>,
  );
}
```

> 承接现有 `FilePreviewError`（5 类）与 `FileIOError`（14 类）中与**读/浏览/路径安全**相关的子集。写专属 code（`already_exists`/`dir_not_empty`/`parent_not_exists`/`trash_unavailable`/`write_failed` 等）不在本期 C8 浏览/预览范围（见 PRD §7 可选写扩展），故 `FileSystemErrorCode` 只保留读路径需要的 6 类。`messageKey` 而非硬编码 message，落实 i18n（NFR-6）。

## 4. 驱动端口 (Driving Ports)

### 4.1 BrowseFilesUseCase

```ts
// ports/driving/browse-files-usecase.ts
export interface BrowseTreeInput {
  baseDir: string;                               // 起始目录（上层给定，已授权）
  options?: Partial<ScanOptions>;                // depth / includeDotEnv 覆盖
}

export interface PreviewFileInput {
  baseDir: string;                               // 围栏基准
  filePath: string;                              // 目标文件路径（可相对 baseDir，适配器归一）
  maxLines?: number;                             // 用户请求上限，与扩展名上限取小
}

export interface BrowseFilesUseCase {
  /**
   * 浏览目录树。越出 baseDir / 根目录 → 抛 FileSystemError。
   * 不可访问的子目录优雅降级为空 children（FR-1.5），不中断整棵树。
   */
  browseTree(input: BrowseTreeInput): Promise<ReadonlyArray<FileTreeNode>>;

  /**
   * 预览单个文件。路径安全违规 → FileSystemError；大文件/二进制/非文件/不存在 → FilePreviewError。
   * 命中行数上限 → truncated=true & line_count_exact=false（反假数据红线）。
   */
  previewFile(input: PreviewFileInput): Promise<FilePreview>;
}
```

> C8 只暴露这一个驱动端口（契约「对外提供：BrowseFilesUseCase」）。两个方法覆盖"浏览"与"预览"两大能力。

## 5. 出站端口 (Driven Ports)

### 5.1 FileSystemPort — 唯一 I/O 出口 & 适配器可替换点

```ts
// ports/driven/file-system-port.ts

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface StatInfo {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** 流式按行读取的结果（读到上限即止）。 */
export interface LineReadResult {
  readonly lines: ReadonlyArray<string>;         // 收集到的行（≤ maxLines）
  readonly scannedLineCount: number;             // 实际扫描到的行数
  readonly hitLimit: boolean;                    // 是否因命中 maxLines 提前停止
}

export interface FileSystemPort {
  /**
   * 把用户输入路径归一为绝对路径，并做全套路径安全校验（围栏 + 根 + 受保护目录 +
   * realpath 符号链接逃逸防护）。安全 → 返回真实归一路径；违规 → 抛 FileSystemError。
   * 这是路径安全 I/O（path.resolve/realpath）的收口点，核心只拿校验后的安全路径。
   */
  resolveSafe(baseDir: string, targetPath: string): Promise<string>;

  /** 读一层目录项（已按类型判定）；目录不可访问 → 返回 []（供 FR-1.5 降级）。 */
  readDir(safeDirPath: string): Promise<ReadonlyArray<DirEntry>>;

  /** stat 单个路径；失败 → 返回 undefined（供 size 留空）。 */
  stat(safePath: string): Promise<StatInfo | undefined>;

  /** 读文件首 N 字节做二进制探测；返回字节视图供 looksBinary 判定。 */
  sampleHead(safeFilePath: string, sampleSize: number): Promise<Uint8Array>;

  /** 流式按行读到 maxLines 即止，不整文件入内存。 */
  readLines(safeFilePath: string, maxLines: number): Promise<LineReadResult>;

  /** 提供适配器所在平台的路径分隔符（供领域纯函数判定）。 */
  pathSep(): string;
}
```

- **实现位置**：适配器 `NodeFsAdapter`（`apps/api`），承接现有 `files.ts`：
  - `resolveSafe` = `path.resolve` 归一 + `isPathSafe`/`isRootPath`/`isBlockedPath` + `assertRealPathInBase`（base 与 target 双 realpath，防符号链接逃逸、不误伤 base 本身是符号链接的情况）。
  - `readDir` = `fs.readdir(withFileTypes)` + Dirent 类型判定（含 `isSymbolicLink`）。
  - `stat` = `fs.stat`。`sampleHead` = `fs.open` + `fd.read` 首 4KB。`readLines` = `createReadStream` + `readline` 按行读到上限（对齐现有流式截断逻辑）。
- **RemoteFsAdapter（预留，未实现）**：同一接口的远程实现——`resolveSafe`/`readDir`/`stat`/`readLines` 走远程协议。C8 核心与 `BrowseFilesService` 零改动即可切换（FR-4.3，六边形"换适配器不动核心"验证点）。
- **AC-13 落地**：单测用内存实现的假 `FileSystemPort`（可编程符号链接/大文件/二进制/权限拒绝场景）跑通全部用例，证明核心不依赖 `NodeFsAdapter`。

## 6. 用例编排要点（`BrowseFilesService`）

```ts
// usecases/browse-files.ts
export class BrowseFilesService implements BrowseFilesUseCase {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly log: RuntimeLog,          // SK 横切
    private readonly errors: ErrorClassifier,  // SK 横切
    // Redactor / TranslationPort 由适配器/控制器边界使用，或按需注入
  ) {}
  // ...
}
```

- **`browseTree`**：
  1. `fs.resolveSafe(baseDir, baseDir)` 校验 baseDir 自身（拒根 / 拒逃逸）。
  2. 递归：每层 `fs.readDir(safeDir)` → 过滤（`IGNORED_DIRS`、隐藏文件规则含 `.env` 例外）→ 目录优先 + `localeCompare` 排序 → 目录递归（`depth-1`，`depth<=0` 停）、文件 `fs.stat` 取 `size` + 算 `extension`。
  3. 子目录 `readDir` 返回 `[]`（不可访问）→ 该节点 `children:[]` 降级，不抛（FR-1.5）；底层异常经 `errors.classify` 归 `FILESYSTEM` 记 `log`（脱敏后）。
- **`previewFile`**：
  1. `safePath = fs.resolveSafe(baseDir, filePath)`（路径安全，违规抛 `FileSystemError`）。
  2. `stat = fs.stat(safePath)`；不存在→`not_found`，非文件→`not_a_file`，`size > BYTE_CEILING`→`file_too_large`（**不进流式读取**，AC-6）。
  3. `sample = fs.sampleHead(safePath, min(4096,size))`；`looksBinary(sample)`→`binary_not_previewable`（AC-7）。
  4. `ext` → `language = getFileLanguage(ext)`；`maxLines = getLineCap(ext, userMaxLines)`。
  5. `{lines, scannedLineCount, hitLimit} = fs.readLines(safePath, maxLines)`；`content = lines.join('\n')`。
  6. 行数语义：`truncated = hitLimit`；`line_count = hitLimit ? max(scannedLineCount, ceil(bytes_total/60)) : scannedLineCount`；`line_count_exact = !hitLimit`（反假数据红线，AC-5）。
- **所有对外错误**用 `code` + `messageKey`（`c8.*`），渲染交 `SK.TranslationPort`；fs 底层异常统一 `SK.ErrorClassifier.classify` → `FILESYSTEM`；离核心的日志路径经 `SK.Redactor` 脱敏用户名段（NFR-4）。

## 7. 路径安全归属：领域纯函数 vs 适配器 I/O（关键设计决策）

路径安全既涉及**纯字符串判定**（前缀围栏、根判定、segment 黑名单），又涉及**真实 I/O**（`path.resolve` 归一、`fs.realpath` 解符号链接）。为守住"核心零 fs/path 依赖"（NFR-1）：

- **判定逻辑（纯函数）留核心**：`isWithinBase` / `isRootPath` / `isBlockedPath` / `isValidFilename` / `looksBinary` / `getLineCap` / `getFileLanguage`。它们只吃**已归一的字符串/字节视图**，不碰 `fs`/`path`/`os`。可表驱动单测。
- **归一与 realpath（I/O）进适配器**：`NodeFsAdapter.resolveSafe` 内做 `path.resolve`、`fs.realpath(base)`、`fs.lstat`（判目标是否符号链接）、`fs.realpath(target)`，再把结果字符串喂给上面的纯函数判定，任何不通过即抛 `FileSystemError`。
- 好处：**符号链接逃逸这类必须 I/O 才能查的攻击**由适配器负责，而**判定规则**在核心可测、可跨适配器复用（`RemoteFsAdapter` 复用同一批纯函数）。
- **TOCTOU 局限如实标注**：`realpath` 校验对"检查后攻击者换掉某段符号链接"的竞态只能覆盖常见情况，不能完全消除（对齐现有 `assertRealPathInBase` 注释）。文档不夸大保证。

## 8. 依赖注入接线 (NestJS 侧)

```
WorkspaceModule (apps/api)
  imports: [SharedKernelModule]      // 注入 Redactor / ErrorClassifier / RuntimeLog / TranslationPort
  provides:
    BrowseFilesUseCase  → BrowseFilesService(FileSystemPort, RuntimeLog, ErrorClassifier)
    FileSystemPort      → NodeFsAdapter()   // 本机进程直读；未来可替换为 RemoteFsAdapter
  exports:
    BrowseFilesUseCase                 // 契约对外提供端口
    // FileSystemPort 是 C8 出站实现细节，默认不 export（无业务上下文消费它）
  controllers:
    WorkspaceController
      GET  /api/files/tree?baseDir=&depth=      → browseTree
      GET  /api/files/preview?baseDir=&path=&maxLines=  → previewFile
      // 控制器负责：把 FileSystemError/FilePreviewError.code 映射 HTTP 400/403/404/409/500，
      //            用 SK.TranslationPort 渲染 messageKey，用 SK.Redactor 脱敏日志。
```

NestJS DI 充当接线盒，核心包零框架依赖，符合分层铁律。`FileSystemPort` 不导出——C8 契约对外只有 `BrowseFilesUseCase`，`FileSystemPort` 是"C8 自己需要、由适配器实现"的出站端口，无其他业务上下文消费（区别于 C7 的 `ProviderRepository` 需 export 供 C2）。

## 9. 跨上下文契约核对

| 端口 | 方向 | 契约来源（边界表） |
|---|---|---|
| `BrowseFilesUseCase` | C8 对外提供 | context-boundaries.md：C8「对外提供端口：BrowseFilesUseCase」 |
| `FileSystemPort` | C8 对外提供（出站，本上下文自用） | C8「对外提供端口：FileSystemPort」——由 NodeFsAdapter 实现 |
| （业务上下文依赖） | 无 | C8「依赖端口：无」——不消费任何 C1–C10 端口 |
| `SK.Redactor/ErrorClassifier/RuntimeLog/TranslationPort` | C8 依赖 SK（横切） | SK 对外端口清单（横切全上下文；非业务依赖，不违反"依赖端口：无"主线） |

**边界纪律自检**：
- C8 不含"文件如何被 AI 使用"：无 prompt 注入、无 @文件引用、无 AI 工具文件读写——那属 C2。C8 只产"给人看"的树与预览。
- C8 不含会话/消息（C1）、MCP/Skill（C9）、媒体生成业务语义（C4；生成图在 C8 眼里只是普通文件，超 byte 上限或二进制则按 `file_too_large`/`binary_not_previewable` 处理，不理解"这是生成图"）。
- C8 不 import `fs`/`path`/`os`/`readline`：全部 I/O 与路径归一/realpath 锁在 `NodeFsAdapter` 后（AC-12 静态扫描）。
- C8 对**业务上下文**零依赖，无循环依赖风险（最独立上下文之一）。
- 写操作不在 C8 浏览/预览核心：只保留路径安全策略（`isValidFilename` 等）作为可复用不变量，写用例本身留待可选扩展（PRD §7）。

## 10. 测试策略（对应 PRD AC）

- 纯单元（`npm run test` 层，用假 `FileSystemPort`）：
  - 路径安全纯函数表驱动：`isWithinBase`（穿越/合法）、`isRootPath`、`isBlockedPath`（.git/.env/系统目录）、`isValidFilename`（Windows 保留名）（AC-9/10/11）。
  - `getLineCap`/`getFileLanguage`/`looksBinary` 表驱动（AC-8/AC-7 判定层）。
  - `browseTree`：忽略规则、`.env` 例外、目录优先排序、深度上限、无权限子目录降级（AC-1~4）。
  - `previewFile`：截断 vs 未截断的 `line_count_exact` 差异（AC-5 反假数据核心）、大文件 stat 后即拒不读流（AC-6）、二进制拒绝（AC-7）。
- 反例 smoke（安全触发路径）：
  - 路径穿越 `../etc/passwd`（AC-9）；符号链接逃逸 + baseDir 本身是符号链接不误伤（AC-10）；根/受保护目录拒绝（AC-11）。用假 `FileSystemPort` 编程 realpath 行为断言 `resolveSafe` 抛 `path_unsafe`。
- 适配器可替换（AC-13）：同一批用例单测跑在内存假 `FileSystemPort` 上全绿，证明核心不依赖 `NodeFsAdapter`。
- 静态检查（AC-12）：对 `workspace/` 核心包做禁用 import 扫描（`fs`/`path`/`os`/`readline`/`better-sqlite3`/`@nestjs/*`）0 命中。
- 脱敏反例（AC-14）：断言写入 `SK.RuntimeLog` 的绝对路径经 `SK.Redactor`，用户名段不以明文出现。
- 集成 smoke（`NodeFsAdapter` 真实磁盘，可选）：在临时目录造符号链接/大文件/二进制，端到端验证 controller 返回的 code 与 HTTP 状态映射。
