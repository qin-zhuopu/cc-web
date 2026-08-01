---
title: 需求文档 (PRD) — C8 Workspace 工作区
context: C8 · Workspace
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# PRD：C8 · Workspace（工作区）

> 产品简报见 [product-brief.md](./product-brief.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 0. 范围与语义契约（反假数据前置）

C8 存在若干"用户可见的文件视图状态与预览元数据"，按 CLAUDE.md「语义验收与反假数据」，先定义字段语义与来源，再谈功能。文件树/预览里最容易误导用户的是"行数""是否截断""大小"这几个数字——它们必须如实反映实测结果，不能拿估算冒充精确、不能把截断藏起来：

| 用户可见字段 | 语义（用户会怎么理解） | 真实来源 breadcrumb | 缺失/不确定来源时的降级 |
|---|---|---|---|
| 文件树节点 `size` | 这个文件多大 | `FileSystemPort.scan()` → `fs.stat().size` 实测 | stat 失败时该字段留空（`undefined`），不显假 0 |
| 文件树节点 `type` | 这是文件还是目录 | `Dirent.isDirectory()/isFile()` 实测 | 无法判定的条目（如特殊设备）跳过，不猜 |
| 预览 `content` | 文件的文本内容 | `FileSystemPort.readPreview()` 流式读取的实际字节 | 二进制/超限时不返回 content，返回结构化错误 |
| 预览 `line_count` | 这个文件有多少行 | 未截断=`readPreview` 扫描实测；截断=按字节估算 | 见下 `line_count_exact` |
| 预览 `line_count_exact` | 上面的行数是精确的还是估算的 | `!truncated`（未截断才精确） | 截断时必为 `false`，UI 需显示"约 N 行"而非"N 行" |
| 预览 `truncated` | 我看到的是完整文件还是被截断了 | `readPreview` 是否命中行数上限 | 命中上限必为 `true`，绝不隐藏截断 |
| 预览 `language` | 语法高亮用哪种语言 | `getFileLanguage(ext)` 按扩展名映射 | 未知扩展名归 `plaintext`，不猜语言 |
| 预览 `bytes_read` / `bytes_total` | 读了多少 / 总共多大 | `readPreview` 实读字节 / `fs.stat().size` | 均为实测，无估算 |
| 预览错误 `code` | 为什么打不开这个文件 | `FilePreviewError.code`（5 类实测判定） | 无法归类的底层异常归 `read_failed`，不静默返回空内容 |

**原则**：没有真实来源的字段一律隐藏 / 标 unsupported / 明确写"估算"。核心反假红线——**截断的文件必须 `truncated=true` 且 `line_count_exact=false`**，UI 对估算行数用"约"字样，禁止把估算行数当精确行数展示。

## 1. 功能需求 (Functional Requirements)

### FR-1 文件树浏览（`BrowseFilesUseCase.browseTree`）
- FR-1.1 给定 `baseDir`（可选起始目录，缺省用某个约定的工作根，如用户 home 或项目根），递归扫描产出 `FileTreeNode[]`，每个节点含 `name` / `path` / `type('file'|'directory')`；文件节点额外含 `size`（可选，stat 失败留空）与 `extension`（可选）；目录节点含 `children`。
- FR-1.2 **深度限制**：默认扫描深度 3 层（对齐现有 `scanDirectory(dir, depth=3)`），可由调用方传入；深度耗尽返回空 children，不无限递归。
- FR-1.3 **忽略规则**：跳过约定的忽略目录（`node_modules` / `.git` / `dist` / `.next` / `__pycache__` / `.cache` / `.turbo` / `coverage` / `.output` / `build`）；跳过隐藏文件/目录（`.` 开头），但 `.env*` 例外（保留可见，对齐现有实现）。
- FR-1.4 **排序**：目录优先于文件，同类按名称 `localeCompare` 升序。
- FR-1.5 扫描不可访问的目录（权限不足 / 不存在）时**优雅降级**：该目录返回空节点集，不抛出中断整棵树，不把内部异常泄漏给前端（异常经 `SK.ErrorClassifier` 归 `FILESYSTEM` 记日志）。
- FR-1.6 baseDir 若为文件系统根（`/`、`C:\`）应拒绝（`isRootPath`），防止把整个磁盘投影到浏览器。

### FR-2 文件预览（`BrowseFilesUseCase.previewFile`）
- FR-2.1 给定文件路径，返回 `FilePreview{ path, content, language, line_count, line_count_exact, truncated, bytes_read, bytes_total }`。
- FR-2.2 **大文件拦截（先于读取）**：`fs.stat().size` 超过 byte 上限（`BYTE_CEILING = 10MB`）时不打开流，直接返回 `file_too_large`，避免内存打爆。
- FR-2.3 **二进制探测（先于 UTF-8 解码）**：读首 4KB 采样，命中 NUL 字节或 >30% 非文本字节判为二进制，返回 `binary_not_previewable`，不返回乱码。
- FR-2.4 **按扩展名行数上限**：prose 类（md/mdx/txt=50000，log/csv/tsv=10000）给宽上限以完整显示长 Markdown 报告；代码类默认 1000 行；硬顶 `ABSOLUTE_LINE_CEILING=100000`；调用方可传 `userMaxLines`（取与扩展名上限的较小值）。
- FR-2.5 **流式按行截断读取**：只读到上限行数即停止流，不整文件载入内存；命中上限置 `truncated=true`。
- FR-2.6 **行数语义**：未截断时 `line_count` = 实际扫描行数、`line_count_exact=true`；截断时 `line_count` = 按字节估算（`ceil(bytes_total/60)` 与已扫描行数取大）、`line_count_exact=false`（反假数据红线）。
- FR-2.7 **语言识别**：按扩展名经 `getFileLanguage` 映射（TS/JS/Py/Go/... 见 `LANGUAGE_MAP`），未知归 `plaintext`。
- FR-2.8 路径不存在→`not_found`；路径非文件（是目录/设备）→`not_a_file`；采样/读取底层异常→`read_failed`。这 5 类（含 2.2/2.3）构成 `FilePreviewError` 的稳定错误码。

### FR-3 路径安全（`FileSystemPort` 边界的领域不变量）
- FR-3.1 **路径归一 + 围栏**：所有入参路径先 `path.resolve` 归一，再校验落在 baseDir 内（`isPathSafe`：`resolvedTarget` 以 `resolvedBase + sep` 开头或等于 base）；逃逸出 baseDir 的路径拒绝（`path_unsafe`）。
- FR-3.2 **拒绝文件系统根**：`isRootPath` 命中的路径拒绝（`root_path`）。
- FR-3.3 **符号链接逃逸防护**：对目标做 `realpath`，校验**真实目标**仍在 `realpath(baseDir)` 内；文本路径在 baseDir 内但符号链接真实目标在外的情况必须拒绝（`path_unsafe`）。base 侧也 realpath，避免"工作区本身是符号链接"时误伤合法读取。
- FR-3.4 **受保护目录拦截**：路径任一 segment 命中受保护目录集（`.git` / `node_modules` / `.next` / `dist` / `build` / `.turbo` / `.cache` / 系统目录 `Library`/`System`/`Windows`/`Program Files`/`System32`）或以 `.env` 开头时拒绝（`blocked_directory`）。
- FR-3.5 **跨平台一致**：路径安全在 win32 / darwin / linux 行为一致；Windows 保留设备名（`CON`/`PRN`/`NUL`/`COM1-9`/`LPT1-9`）在文件名校验中拒绝（`isValidFilename`，供未来写扩展复用）。
- FR-3.6 路径安全校验产出结构化 `FileSystemError`（承接现有 `FileIOErrorCode` 中与读相关的子集：`path_unsafe`/`root_path`/`symlink_detected`/`blocked_directory`/`not_found`/`not_a_file`），驱动适配器映射为 HTTP 状态码（400/403/404）。

### FR-4 适配器可替换（`FileSystemPort` 抽象）
- FR-4.1 C8 核心与用例只依赖 `FileSystemPort` 接口，不直接 import `fs`/`path`/`os`。
- FR-4.2 默认实现 `NodeFsAdapter`：本机 NestJS 进程直读本地文件系统（`fs/promises` + `createReadStream`），承接现有 `files.ts` 的全部 I/O 与路径安全实现。
- FR-4.3 架构预留 `RemoteFsAdapter`（未实现，仅接口占位说明）：未来若要访问远程/容器内文件系统，只新增一个适配器实现同一 `FileSystemPort`，C8 核心与 `BrowseFilesUseCase` 零改动。此为六边形"换适配器不动核心"的落地验证点。

## 2. 非功能需求 (Non-Functional Requirements)

- NFR-1 **边界纯净**：`packages/core/workspace/` 禁止 import `fs`/`path`/`os`/`readline` 的直接用法、`better-sqlite3`、`@nestjs/*`；全部文件 I/O 与路径运算经 `FileSystemPort` 注入。（路径安全的**策略判定**若需路径运算，以纯函数形态放核心并接收已归一字符串，真实 `resolve`/`realpath` 在适配器完成——见架构 §路径安全归属。）
- NFR-2 **安全（头号）**：无路径穿越、无符号链接逃逸、无根目录/受保护目录读取。任何离开 baseDir 的读取尝试必须被结构化错误拒绝，且不泄漏 baseDir 外任何文件内容或存在性信息之外的细节。TOCTOU 竞态的局限如实标注，不夸大保证。
- NFR-3 **性能 / 内存安全**：预览绝不整文件载入内存——大文件先 stat 拦截、二进制先采样拦截、文本流式按行读到上限即止。文件树扫描受深度上限约束，忽略大目录（node_modules 等）避免扫描爆炸。
- NFR-4 **脱敏**：日志中的绝对路径（含用户名段 `/Users/alice`、`C:\Users\alice`）经 `SK.Redactor` 脱敏后再写 `SK.RuntimeLog`（source=`c8.workspace`）；返回给前端的 `path` 字段为功能所必需（用户要按路径点开），不脱敏，但不额外泄漏 baseDir 外信息。
- NFR-5 **错误统一**：fs 底层异常经 `SK.ErrorClassifier` 归 `FILESYSTEM`；C8 自身的业务错误用稳定 `FileSystemError`/`FilePreviewError` code + i18n messageKey，UI 拿 code 而非裸 message。
- NFR-6 **i18n**：预览/浏览错误文案经 `SK.TranslationPort`，C8 只贡献自己的 message keys（`c8.*`）。
- NFR-7 **可测**：浏览与预览均可用假 `FileSystemPort`（内存文件树 / 内存文件内容 + 可编程的符号链接/大文件/二进制/权限拒绝场景）做纯单元测试，无需真实磁盘。路径安全策略纯函数可表驱动测试。

## 3. 验收标准 (Acceptance Criteria)

- AC-1（FR-1.1/1.4）给定含子目录与文件的 baseDir，`browseTree` 返回目录优先、名称升序的树，节点字段（name/path/type/size/extension/children）齐全。
- AC-2（FR-1.3）扫描含 `node_modules`/`.git`/隐藏文件的目录，结果不含忽略目录与普通隐藏文件，但含 `.env`（例外保留）。
- AC-3（FR-1.2）深度上限反例：depth=1 只返回一层，子目录 children 为空；depth=3 返回三层。
- AC-4（FR-1.5）扫描包含一个无权限子目录的树 → 该子目录降级为空、整棵树仍返回，不抛异常、不泄漏原始 fs 错误串。
- AC-5（FR-2.6）**反假数据核心反例**：预览一个超过行数上限的文件 → `truncated=true` 且 `line_count_exact=false`；预览一个小文件 → `truncated=false` 且 `line_count_exact=true` 且 `line_count` 等于真实行数。两条路径的 `line_count_exact` 必须不同。
- AC-6（FR-2.2）预览 > 10MB 的文件 → 返回 `file_too_large`，且**断言未进行流式读取**（stat 后即拒），meta 含 `bytes_total`/`byte_limit`。
- AC-7（FR-2.3）预览含 NUL 字节的二进制文件 → 返回 `binary_not_previewable`，不返回 content。
- AC-8（FR-2.7）预览 `.ts` → `language='typescript'`；预览无扩展名的 `LICENSE` / 未知扩展名 → `language='plaintext'`。
- AC-9（FR-3.1）**路径穿越反例**：baseDir=`/work`，请求 `/work/../etc/passwd`（或 `../../` 穿越）→ 归一后逃逸 baseDir → 拒绝 `path_unsafe`，不返回任何 baseDir 外内容。
- AC-10（FR-3.3）**符号链接逃逸反例**：baseDir 内有一个符号链接指向 baseDir 外的文件，请求该链接 → `realpath` 后真实目标在 baseDir 外 → 拒绝 `path_unsafe`；对照：baseDir 本身是符号链接时，其内合法文件读取**不**被误伤（仍成功）。
- AC-11（FR-3.2/3.4）请求文件系统根（`C:\` / `/`）→ 拒绝 `root_path`；请求路径经过 `.git` / `.env` / 系统目录 segment → 拒绝 `blocked_directory`。
- AC-12（NFR-1）对 `workspace/` 核心包做禁用 import 静态扫描（`fs`/`path`/`os`/`readline`/`better-sqlite3`/`@nestjs/*`），0 命中。
- AC-13（FR-4.3 / S6）用一个内存实现的假 `FileSystemPort` 跑通 `BrowseFilesUseCase` 的浏览与预览全部单测，**证明 C8 核心与用例完全不依赖 NodeFsAdapter**（换适配器不动核心）。
- AC-14（NFR-4）日志断言：预览/扫描写入 `SK.RuntimeLog` 的路径经 `SK.Redactor` 脱敏，用户名段不以明文出现。

## 4. 依赖与假设

- 依赖 SK 已交付：`Redactor` / `ErrorClassifier` / `RuntimeLog` / `TranslationPort` 端口稳定（见 SK architecture 第 4 节）作为**横切**注入使用；C8 对**业务上下文**依赖为无（契约 C8「依赖端口：无」）。
- 假设 baseDir 由上层（会话/项目配置或请求参数）给定并已通过更高层授权；C8 只在 baseDir 内做路径围栏，不承担"用户能访问哪些 baseDir"的授权决策（本期单机信任本机用户）。
- 假设本机 NestJS 进程拥有读取目标目录的操作系统权限（单机形态成立）；无权限时按 FR-1.5 优雅降级。
- 假设 `FileTreeNode` / `FilePreview` 领域类型由 C8 拥有并从 C8 桶文件导出；现有 `@/types` 的同名类型在重构后迁入 C8 domain。
