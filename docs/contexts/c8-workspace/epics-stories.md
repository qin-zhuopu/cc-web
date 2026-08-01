---
title: 史诗与故事 — C8 Workspace 工作区
context: C8 · Workspace
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 史诗与故事：C8 · Workspace（工作区）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)。
> 每个故事标注对应 PRD 的 FR / AC，便于追溯。

## 史诗总览

| 史诗 | 目标 | 关联 FR |
|---|---|---|
| E1 领域与端口骨架 | 落地 C8 核心包（domain + ports），零框架/零 fs | FR-1~4 的类型基础、NFR-1 |
| E2 路径安全策略 | 纯函数判定 + 适配器 realpath 收口，防穿越/符号链接逃逸 | FR-3 |
| E3 文件树浏览 | 递归扫描 + 忽略规则 + 排序 + 深度限制 + 降级 | FR-1 |
| E4 文件预览 | 大文件/二进制拦截 + 行数上限 + 流式截断 + 诚实行数 | FR-2 |
| E5 NodeFsAdapter 与适配器可替换 | 本机直读实现 + 假端口可替换验证 + RemoteFs 预留 | FR-4 |
| E6 NestJS 接线与错误映射 | Module/Controller + 错误码→HTTP + i18n + 脱敏日志 | DI、NFR-4~6 |

---

## E1 · 领域与端口骨架

- **S1.1** 定义 `FileTreeNode` / `FileNodeType` / `ScanOptions` 值对象（对齐现有 `@/types` FileTreeNode，size/extension/children 可选落实反假数据）。**AC**：类型往返不丢字段，stat 失败 size 留空而非 0。（FR-1.1）
- **S1.2** 定义 `FilePreview` 值对象与不变量 `line_count_exact === !truncated`。**AC**：类型层写明截断时行数为估算语义。（FR-2.1/2.6）
- **S1.3** 定义预览常量与纯函数：`BYTE_CEILING`/`EXTENSION_LINE_CAPS`/`ABSOLUTE_LINE_CEILING` + `getLineCap`/`looksBinary`/`getFileLanguage`（`looksBinary` 吃 `Uint8Array` 保持零 Node 依赖）。**AC**：三纯函数表驱动单测覆盖。（FR-2.3/2.4/2.7）
- **S1.4** 定义结构化错误 `FilePreviewError`(5 类) / `FileSystemError`(6 类读路径子集)，均带 `messageKey`(`c8.*`)。**AC**：错误无硬编码 message，只 code+messageKey。（NFR-5/6）
- **S1.5** 定义驱动端口 `BrowseFilesUseCase`（browseTree/previewFile）与出站端口 `FileSystemPort`（resolveSafe/readDir/stat/sampleHead/readLines/pathSep）。**AC**：核心 `index.ts` 只导出端口与领域类型。（FR-1/2/4）
- **S1.6** 建立禁用 import 静态扫描。**AC-12**：`workspace/` 对 `fs`/`path`/`os`/`readline`/`better-sqlite3`/`@nestjs/*` 0 命中。（NFR-1）

## E2 · 路径安全策略

- **S2.1** 实现路径安全纯函数：`isWithinBase`（前缀+sep 围栏）/`isRootPath`/`isBlockedPath`（BLOCKED_SEGMENTS + `.env` 前缀）/`isValidFilename`（Windows 保留名）。**AC-9/11**：穿越/根/受保护目录判定表驱动通过。（FR-3.1/3.2/3.4/3.5）
- **S2.2** 定义常量集 `IGNORED_DIRS`/`BLOCKED_SEGMENTS`/`WINDOWS_RESERVED`（对齐现有 files.ts）。**AC**：常量与现有实现一致。（FR-1.3/3.4/3.5）
- **S2.3** `FileSystemPort.resolveSafe` 契约：归一 + 围栏 + 根 + 受保护 + realpath 符号链接逃逸防护（base 与 target 双 realpath）。**AC-10**：符号链接真实目标在 baseDir 外 → 抛 `path_unsafe`；baseDir 本身是符号链接时其内合法读取不误伤。（FR-3.1/3.3）
- **S2.4** TOCTOU 局限文档化（对齐 `assertRealPathInBase` 注释），不夸大保证。**AC**：架构文档 §7 写明局限。（NFR-2）

## E3 · 文件树浏览

- **S3.1** 实现 `BrowseFilesService.browseTree` 递归骨架：`resolveSafe(baseDir)` 校验起点 → 逐层 `readDir` → 目录优先 + `localeCompare` 排序。**AC-1**：树字段齐全、排序正确。（FR-1.1/1.4）
- **S3.2** 忽略规则：跳过 `IGNORED_DIRS` 与隐藏文件，`.env*` 例外保留。**AC-2**：结果不含 node_modules/.git/普通隐藏文件，含 `.env`。（FR-1.3）
- **S3.3** 深度限制：`depth` 递减，`depth<=0` 返回空 children。**AC-3**：depth=1 只一层，depth=3 三层。（FR-1.2）
- **S3.4** 文件节点元数据：`stat` 取 `size`（失败留空）、算 `extension`。**AC-1**：size 来自实测。（FR-1.1）
- **S3.5** 优雅降级：不可访问子目录（`readDir` 返回 `[]`）→ children 空、不中断整树；底层异常经 `SK.ErrorClassifier` 归 `FILESYSTEM` 记日志。**AC-4**：含无权限子目录仍返回整树、不泄漏原始 fs 错误串。（FR-1.5）
- **S3.6** baseDir 为文件系统根时拒绝。**AC-11**：`C:\`/`/` → `root_path`。（FR-1.6/3.2）

## E4 · 文件预览

- **S4.1** `previewFile` 骨架：`resolveSafe(filePath)` → `stat`（不存在 `not_found`/非文件 `not_a_file`）。**AC**：路径安全违规抛 `FileSystemError`。（FR-2.8/3）
- **S4.2** 大文件拦截：`size > BYTE_CEILING` → `file_too_large`，**不进流式读取**，meta 带 bytes_total/byte_limit。**AC-6**：断言未读流。（FR-2.2）
- **S4.3** 二进制探测：`sampleHead(4KB)` → `looksBinary` → `binary_not_previewable`，不返回 content。**AC-7**：NUL 字节文件被拒。（FR-2.3）
- **S4.4** 语言与上限：`getFileLanguage(ext)` + `getLineCap(ext, userMax)`（prose 宽/代码 1000/硬顶 100000）。**AC-8**：`.ts`→typescript，未知/LICENSE→plaintext。（FR-2.4/2.7）
- **S4.5** 流式截断读取：`readLines(maxLines)` 读到上限即止；`content = lines.join('\n')`。**AC**：不整文件入内存。（FR-2.5/NFR-3）
- **S4.6** 诚实行数：`truncated=hitLimit`；截断时 `line_count` 估算、`line_count_exact=false`；未截断精确、`true`。**AC-5**：截断 vs 未截断的 `line_count_exact` 必不同（反假数据核心反例）。（FR-2.6）

## E5 · NodeFsAdapter 与适配器可替换

- **S5.1** 实现 `NodeFsAdapter.resolveSafe`：`path.resolve` + `isPathSafe`/`isRootPath`/`isBlockedPath` + `assertRealPathInBase`（承接现有 files.ts）。**AC-9/10/11**：全套路径安全经真实 realpath 生效。（FR-4.2/3）
- **S5.2** 实现 `readDir`/`stat`/`sampleHead`/`readLines`/`pathSep`（`fs/promises` + `createReadStream` + `readline`，对齐现有 `scanDirectory`/`readFilePreview` 流式逻辑）。（FR-4.2）
- **S5.3** 内存假 `FileSystemPort`（可编程符号链接/大文件/二进制/权限拒绝）供单测。**AC-13**：全部用例跑在假端口上绿，证明核心不依赖 NodeFsAdapter。（FR-4.1/NFR-7）
- **S5.4** `RemoteFsAdapter` 接口占位文档（不实现）：说明未来远程只换适配器、核心零改动。**AC**：架构 §5.1 写明预留。（FR-4.3）

## E6 · NestJS 接线与错误映射

- **S6.1** `WorkspaceModule`：imports SharedKernelModule，provides `BrowseFilesUseCase`→`BrowseFilesService`、`FileSystemPort`→`NodeFsAdapter`，exports `BrowseFilesUseCase`（FileSystemPort 不导出，无业务上下文消费）。（DI 章节）
- **S6.2** `WorkspaceController`：`GET /api/files/tree`（baseDir/depth）→ browseTree；`GET /api/files/preview`（baseDir/path/maxLines）→ previewFile。（DI 章节）
- **S6.3** 错误码→HTTP 映射：`FileSystemError`/`FilePreviewError.code` → 400/403/404/409/500；`messageKey` 经 `SK.TranslationPort` 渲染。**AC**：各 code 映射正确状态。（NFR-5/6）
- **S6.4** 日志脱敏：扫描/预览关键路径经 `SK.Redactor` 脱敏绝对路径用户名段后写 `SK.RuntimeLog`（source=`c8.workspace`）。**AC-14**：日志中用户名段不明文出现。（NFR-4）

---

## Story → AC 追溯矩阵

| AC | 覆盖故事 |
|---|---|
| AC-1 | S3.1, S3.4 |
| AC-2 | S3.2 |
| AC-3 | S3.3 |
| AC-4 | S3.5 |
| AC-5 | S4.6 |
| AC-6 | S4.2 |
| AC-7 | S1.3, S4.3 |
| AC-8 | S1.3, S4.4 |
| AC-9 | S2.1, S5.1 |
| AC-10 | S2.3, S5.1 |
| AC-11 | S2.1, S3.6, S5.1 |
| AC-12 | S1.6 |
| AC-13 | S5.3 |
| AC-14 | S6.4 |

## 建议排期（Sprint）

- **Sprint 1（骨架 + 安全）**：E1 全部、E2 全部。产出零框架 C8 核心 + 路径安全纯函数 + 端口接口 + 静态扫描门禁。
- **Sprint 2（浏览 + 预览）**：E3 全部、E4 全部。产出 browseTree/previewFile 用例，反假数据（AC-5）与安全反例（AC-9/10/11）单测通过（用假端口）。
- **Sprint 3（适配器 + 接线）**：E5 全部、E6 全部。产出 NodeFsAdapter + 内存假端口可替换验证（AC-13）+ NestJS Module/Controller + 错误映射 + 脱敏日志 + RemoteFs 预留文档。

## 定义完成 (DoD)

- 对应 FR/AC 单测与安全反例 smoke 全绿（`npm run test` 层，用内存假 `FileSystemPort`，无需真实磁盘）。
- 禁用 import 静态扫描 0 命中（AC-12）。
- 反假数据红线断言通过：截断文件 `truncated=true` & `line_count_exact=false`（AC-5）。
- 三类路径逃逸反例（穿越/符号链接/根+受保护目录）全部被结构化错误拒绝（AC-9/10/11）。
- 适配器可替换验证通过：核心用例跑在内存假端口上全绿（AC-13）；`RemoteFsAdapter` 预留文档到位。
- 边界纪律：C8 不出现"文件如何被 AI 使用"/会话/MCP 概念；不 import fs/path/os。
