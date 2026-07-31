---
title: 产品简报 — C8 Workspace 工作区
context: C8 · Workspace
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 产品简报：C8 · Workspace（工作区）

> 需求见 [prd.md](./prd.md)，架构见 [architecture.md](./architecture.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 分层铁律见 [../../architecture/hexagonal-decomposition.md](../../architecture/hexagonal-decomposition.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。

## 1. 一句话定位

C8 是 CodePilot Web 里负责**浏览本机文件树、安全预览文件内容**的限界上下文。它让单机用户在浏览器里像资源管理器一样展开目录、点开文件看代码/文本内容——但它**不关心文件如何被 AI 使用**（AI 读文件、把文件塞进上下文属于 C2 的职责，C8 只提供"给人看"的文件系统视图与预览）。

## 2. 解决什么问题

CodePilot 从 Electron 桌面端重构为"本机运行的 Web 应用"后，前端 SPA 跑在浏览器沙箱里，天然无法直接访问本地文件系统。但用户的核心工作流——查看项目目录结构、点开某个文件确认内容、预览 AI 刚生成的 Markdown 报告——都依赖本地文件访问。

**"本机 Web 应用"形态的关键优势正体现在这里**：因为 NestJS 后端就跑在用户本机的 localhost，它是一个拥有完整本地文件权限的 Node 进程，可以直接 `fs.readdir` / `fs.readFile` 读到用户的真实项目目录。C8 把这份"本机进程能力"通过 HTTP 端口暴露给浏览器 SPA，等价于给浏览器补上了一套受控的文件系统访问能力。这是"本机 Web 应用"相对"远程 SaaS"的核心差异：SaaS 后端在云端，读不到用户本地磁盘；C8 后端在本机，照读不误。

现有 Electron 版 `files.ts` 已经沉淀了这条链路的核心能力与安全约束，C8 的任务是把它从"散落的工具函数 + Next.js API 路由"重构进六边形架构，让文件系统访问收口到一个可测、可替换、路径安全可审计的出站端口后面。

痛点集中在：

- **浏览器读不到本地文件**：SPA 无 fs 能力，必须由本机后端代理，否则整个文件浏览/预览功能不成立。
- **路径穿越风险**：一旦后端暴露"按路径读文件"的 HTTP 接口，就等于开了一个文件读取入口。若不严格校验，`../../etc/passwd`、绝对路径逃逸、符号链接逃逸都能读到 baseDir 之外的敏感文件。这是 C8 头号非功能需求。
- **大文件 / 二进制文件拖垮预览**：直接读整个文件到内存再返回，会被超大文件或二进制文件（图片、可执行文件）打爆内存或产生乱码。
- **预览语义不清**：用户看到的"1234 行"到底是文件真实行数还是被截断后的估算？truncated 标志有没有如实传达？属于反假数据范畴。

## 3. 目标用户与价值

- **单机开发者用户**：在 SPA 的文件树面板里展开自己的项目目录，点开文件在侧栏预览内容，快速确认 AI 刚写入的文件、检查目录结构，不用切到外部编辑器。
- **接入 C8 的其他上下文**：C8 边界契约声明"依赖端口：无"，是相对独立的上下文。它对外提供 `BrowseFilesUseCase` 与出站 `FileSystemPort`；未来若有上下文需要"给人看的文件视图"，复用 C8 用例即可，无需自己再实现一套文件系统访问与路径安全。

价值主张：**把"本机文件系统"安全地投影到浏览器里，成为一份路径受控、大文件/二进制友好、预览语义诚实的只读文件视图。**

## 4. 上下文边界（严格遵守契约）

摘自 `context-boundaries.md` 的 C8 契约：

- **拥有**：
  - 文件树浏览（按 baseDir 递归扫描目录，产出带层级的 `FileTreeNode` 树，含忽略目录/隐藏文件规则、目录优先排序、深度限制、文件大小/扩展名元数据）。
  - 文件预览（按路径读文件内容，含二进制探测、大文件拦截、按扩展名的行数上限、流式截断读取、语言识别、truncated/行数精确性标志）。
  - 路径安全策略（防目录穿越、拒绝文件系统根、拒绝受保护目录、符号链接逃逸防护、合法文件名校验）——作为 C8 领域内的不变量。
- **不包含**：
  - **文件如何被 AI 使用** —— AI 读文件把内容塞进对话上下文、AI 工具的文件读写、@文件引用注入 prompt，全部属 C2（AgentRuntime）。C8 只面向"人在浏览器里看文件"，不面向"AI 消费文件"。
  - 会话/消息实体（属 C1）、MCP/Skill（属 C9）、媒体生成产物的业务语义（属 C4；C8 只当普通文件预览，不理解"这是一张生成图"）。
  - 文件写操作的业务编排：现有 `files.ts` 里的 write/mkdir/rename/delete 助手，其**路径安全校验**（`assertWritablePath` / `assertRealPathInBase` / `assertNoSymlinkInChain` / `isValidFilename`）作为 C8 拥有的安全策略进 `FileSystemPort`，但"何时写、写什么"的业务决策不在 C8 的浏览/预览核心用例里（见 PRD 非目标与可选写扩展说明）。
- **依赖端口（只引用，不重写）**：
  - 契约表声明 C8 **依赖端口：无**（相对独立，最简依赖）。
  - 横切能力（`SK.Redactor` 脱敏日志里的绝对路径用户名段、`SK.ErrorClassifier` 把 fs 异常归为 `FILESYSTEM`、`SK.RuntimeLog` / `SK.TranslationPort` 记日志与预览错误文案 i18n）在架构上作为可选横切注入使用；契约主线依赖仍为"无"，即 C8 不依赖任何**业务上下文**。
- **对外提供端口**：
  - `BrowseFilesUseCase` —— 浏览目录树 + 预览文件的驱动端口。
  - `FileSystemPort` —— 出站端口，抽象"如何真正读文件系统"，由 `NodeFsAdapter`（本机进程直读）实现，预留 `RemoteFsAdapter` 未来可能。

## 5. 与 CodePilot 现有实现的对应

| C8 概念 | 现有落点（`src/lib/files.ts`） |
|---|---|
| 文件树扫描 | `scanDirectory` / `scanDirectoryRecursive`（深度限制、`IGNORED_DIRS`、隐藏文件规则、目录优先排序、size/extension 元数据） |
| 文件预览 | `readFilePreview`（byte 上限 `BYTE_CEILING`、二进制探测 `looksBinary`、按扩展名行数上限 `EXTENSION_LINE_CAPS`、流式按行截断、truncated / line_count_exact 标志） |
| 语言识别 | `getFileLanguage` + `LANGUAGE_MAP` |
| 路径安全 | `isPathSafe` / `isRootPath` / `isBlockedPath` / `isValidFilename` / `assertWritablePath` / `assertRealPathInBase`（realpath 防符号链接逃逸）/ `assertNoSymlinkInChain` |
| 结构化错误 | `FilePreviewError`（`not_found` / `not_a_file` / `file_too_large` / `binary_not_previewable` / `read_failed`）、`FileIOError`（14 类 `FileIOErrorCode`） |
| 领域类型 | 现 `@/types` 的 `FileTreeNode` / `FilePreview` → 重构后进 C8 domain |

> 现有 `files.ts` 把"浏览/预览"（`scanDirectory` / `readFilePreview`）与"写路径安全助手"（`assert*`）放在同一文件。C8 核心用例只涵盖**浏览与预览**（契约「拥有：文件树浏览、文件预览」）；路径安全策略作为 C8 的领域不变量收进 `FileSystemPort` 与领域层的 `PathSafetyPolicy`，写操作本身不是 C8 浏览/预览核心用例的一部分（见 PRD §非目标）。此约定在架构文档里明确写出，避免把 C8 越界扩成"文件管理器全家桶"。

## 6. 成功标准（可度量）

- **S1 浏览闭环**：用户能在 SPA 里给定一个 baseDir，看到该目录下的文件树（目录优先、忽略 node_modules/.git 等、隐藏文件按规则过滤），全部经 `BrowseFilesUseCase.browseTree`，越出 baseDir 的路径被拒。
- **S2 预览诚实**：用户点开文件，预览返回内容 + 语言 + 行数 + `truncated` / `line_count_exact` 标志；被截断时 `truncated=true` 且行数标为估算，绝不把估算行数伪装成精确行数（反假数据）。
- **S3 路径安全无逃逸**：构造 `../` 穿越、绝对路径逃逸、符号链接指向 baseDir 外三类反例，`FileSystemPort` 全部以结构化错误拒绝，不返回 baseDir 外任何内容（安全反例 smoke 断言）。
- **S4 大文件/二进制防护**：超过 byte 上限的文件返回 `file_too_large` 不读内存；二进制文件返回 `binary_not_previewable` 不返回乱码（反例断言）。
- **S5 边界纯净**：C8 核心包不 import `fs` / `path` / `os` 的直接用法、不 import `better-sqlite3` / `@nestjs/*`；全部经 `FileSystemPort` 注入。不出现会话/消息/AI/MCP 概念。
- **S6 适配器可替换**：`FileSystemPort` 由 `NodeFsAdapter` 实现（本机直读）；架构预留 `RemoteFsAdapter`，未来若做远程访问，只换适配器不动 C8 核心与用例（试点验证六边形"换适配器不动核心"）。

## 7. 非目标（明确排除）

- 不做"AI 如何读文件、如何把文件塞进对话上下文"（C2）；C8 只提供给人看的浏览与预览。
- 不做文件写操作的业务编排（新建/重命名/移动/删除文件的用户流程与 UI 决策）。C8 只拥有这些操作所需的**路径安全策略**作为领域不变量，供未来可选的写扩展或其他上下文复用；写用例本身不在本期 C8 浏览/预览核心范围（若需另立需求，见 PRD §7 可选写扩展）。
- 不做文件内容搜索 / 全文索引 / grep（超出"浏览 + 预览"范畴，若需另立需求）。
- 不做文件监听 / inotify / 实时变更推送（本期为按需拉取的只读视图）。
- 不做多租户 / 远程认证 / 权限分级（单机单用户，文件权限由操作系统本身承担；C8 只在 baseDir 内做路径围栏）。
- 不替 SK 重新实现错误分类 / 脱敏 / 日志。

## 8. 关键风险与假设

- **假设**：后端 NestJS 进程与用户拥有相同的本地文件权限（单机形态成立）；baseDir 由上层（会话/项目配置）给定，C8 只负责在其内做安全围栏，不负责决定"用户能访问哪些 baseDir"这一更高层授权（本期默认信任本机用户，围栏用于防止路径穿越到 baseDir 之外，而非做租户隔离）。
- **风险（头号）**：路径穿越 / 符号链接逃逸。任何"按路径读"的 HTTP 入口都是攻击面。必须在 `FileSystemPort` 适配器边界做 `path.resolve` 归一 + `isPathSafe` 前缀校验 + `realpath` 真实目标校验（防符号链接把文本路径留在 baseDir 内、真实目标却在外），并对每类逃逸写反例 smoke。这是 NFR 重点，也是 CLAUDE.md 语义验收要覆盖的安全触发路径。
- **风险**：预览语义与 UI 脱节。"行数""是否截断"必须给 source breadcrumb（来自 `readFilePreview` 的 `line_count` / `line_count_exact` / `truncated` 实测），截断时行数标为估算，禁止假精确行数（反假数据条款，见 PRD §0）。
- **风险**：TOCTOU（检查与使用之间文件被换）。`realpath` 校验对"检查后被换符号链接"的竞态只能覆盖常见情况，无法完全消除；文档需如实标注该局限（对齐现有 `assertRealPathInBase` 注释），不夸大安全保证。
- **风险**：跨平台路径差异（Windows 盘符根 `C:\`、路径分隔符、保留设备名 `CON`/`NUL`、系统目录）。路径安全策略必须跨平台一致，复用现有 `isRootPath` / `WINDOWS_RESERVED` / `BLOCKED_SEGMENTS` 的跨平台约定。
