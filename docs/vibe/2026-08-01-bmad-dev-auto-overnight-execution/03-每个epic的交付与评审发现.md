# 03 · 每个 epic 的交付与评审发现

12 个 epic 逐个记录：产出、对抗评审抓到的真缺陷、修复。**评审不是走过场**——每个 epic 都抓到过实质问题。

## SK · Shared Kernel（4 epic，全 done）

### sk-1（epic-sk-1，commit 681e37b→81b1dda）结构化错误分类
- **sk-1-1**：`ErrorCode` 枚举 16 类（NETWORK…UNKNOWN，逐字对齐 architecture §3.1）+ 不可变 `ClassifiedError` 值对象。附带立起 monorepo 地基（packages/core + apps/api + tsconfig + Vitest）+ **import 静态守卫** `scripts/check-core-imports.mjs`（禁 @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、Date.now、randomUUID，纳入 npm run test）。守卫加固 4 项：纯函数抽出可测、statSync 容错、空扫描拦截、行内注释剥离。
- **sk-1-2**：`ErrorClassifier` 端口 + 纯函数 `defaultErrorClassifier`。**对抗评审抓 6 个分类缺陷全修**：408/504→TIMEOUT、502→UNAVAILABLE（原漏重试）、spawn 语境优先 PROCESS、EPIPE→NETWORK、裸 'connection' 关键词过宽收紧、AbortError 含超时语义改判 TIMEOUT。
- **sk-1-3**：只读 `SK_MESSAGE_KEYS` + 把 sk-1-2 私有映射收敛为引用它（单一真相源）。

### sk-2（efc4e1f）确定性基础端口
Clock（now():number）/ IdGenerator（next():string）/ Platform（PlatformInfo 只读）三端口。逐字对齐 §4.2/4.6/4.7，零适配器实现。首次用 **workflow 并行**跑通。

### sk-3（6b0bbff）脱敏与运行时日志
Redactor（redactString/redact<T>，AC-3/AC-4）+ RuntimeLog 环形缓冲端口（AC-6/AC-7）+ LogEntry/LogLevel 值对象。评审 3 nitpick（测试替身局限）不阻断。

### sk-4（bcf0b12）i18n 端口 + DI 接线 + 守卫
TranslationPort（AC-5 缺失键返回键名不抛）+ **apps/api SharedKernelModule** 绑定全 7 端口 token（首次引入 NestJS，钉版本 @nestjs/common/core@10.4.15，仅 apps/api，核心包仍零框架）。**评审中等缺陷已修**：JsonTranslationTable 改为 `implements TranslationPort`（原缺编译期契约校验，注释与「核心已导出」矛盾）。

## C1 · Conversation（纯核心 5 epic，全 done）

### c1-1（6e1b6e9）会话/消息领域 + 端口骨架
ChatSession（10 会话本体字段全 readonly）+ 三枚举 + TitleOrigin/canOverrideTitle + Message + MessageRole + TokenUsage 投影 + StreamStatus/canTransition（**禁 phase**）+ C1_MESSAGE_KEYS + 4 驱动端口 + 2 被驱动端口 + TitleGeneratorPort（仅 import type）+ import 守卫扩展 phase 检测。
- **评审 HIGH 已修**：Message 补 `sessionId`（会话归属 FK，原漏致 MessageRepository 拿不到会话归属）。
- **评审 MEDIUM 已修**：删越界的 MessageRole `'system'`（架构只有 user|assistant）；架构文档时间戳 ISO string→number（对齐 Clock.now():number，消矛盾）。

### c1-2（aabb491）MessageContent 编解码
ContentBlock 5 类判别联合（text/thinking/tool_use/tool_result/code）+ encodeContent/decodeContent/textContent + toPlainText。
- **评审阻断缺陷已修**：`decodeContent` 对畸形 tool_result（media:42 / media:[null]）无防御 .map() 会抛 TypeError，违反「永不抛」核心契约（.map 在 try/catch 外）。加 Array.isArray + 元素判定，畸形整块降级为 text + 补 4 条盲区测试。

### c1-3（985d6e4）会话生命周期用例
ManageSessionService（create/getById/list/archive/unarchive/delete 级联/touch），构造注入 SessionRepository/MessageRepository/Clock/IdGenerator。
- **评审 F1 已修**：list 双重过滤（既传 query 给 listAll 又服务内过滤）→ 改服务层唯一权威、listAll 不传 query、适配器不得自行 filter/sort/limit（防 top-N 丢数据）。
- **F2 已修**：archive/unarchive 去掉超规格 touch（归档非活动，不该顶列表最前）。
- **F3 已修**：端口契约补「缺失即幂等 no-op」注释背书。测试对齐新规格（非迁就旧 bug）。

### c1-4（10e5f8c）标题来源状态机
SetSessionTitleService（setByUser origin=user / generateByAi 受 canOverrideTitle 约束 user 态不被覆盖 / 降级保留原标题记 warn / C1 不拼 prompt 只喂投影文本）。c1-4-4 用记录入参的假 TitleGenerator 反例断言 C1 不拼 prompt。
- **评审 low 已修**：空/纯空白标题守卫——AI 即便「成功」返回空标题也走降级不写脏值（AC-9 反假数据）+ 2 条测试。
- 3 nitpick 记 deferred：Clock 死依赖、canOverrideTitle 死分支、TitleOrigin 枚举/联合风格不一致。

### c1-5（80836fd）消息生命周期用例
AppendMessageService（append 同一 now touch 会话 AC-7 / updateStreamStatus 经 canTransition 守卫）+ GetSessionHistoryService（getHistory 升序分页 / getPromptView 剥离 render-only AC-9）+ tokenUsage 只存不算。
- **评审中等已修**：append 强制「非 assistant 恒 completed」不变式（§3.3），拦 user+streaming 非法组合防绕过生命周期边界 + 反例测试。
- 2 low 记 deferred：RuntimeLog 未注入、getPromptView taskRunId 剥离过宽。

## C2 · AgentRuntime（前 3 epic done）

### c2-1（65de89c）领域与端口骨架
StreamPhase 相位判别联合（active/settling/terminal）+ isActive/isTerminal + canTransitionPhase/reconcilePhase 纯函数 + TerminalReason 6 归因 + TurnArtifacts/buildFinalContent + 14 类 AgentStreamEvent + 值对象 + C2_MESSAGE_KEYS + RuntimeKind + 驱动/出站端口骨架。守卫扩展 child_process 拦截。桶层别名 RuntimeTokenUsage/RuntimeTitleGenerationInput 避免与 C1 同名冲突。
- **评审低已修**：TerminalReason.classified 改可选（对齐 AC-9，COMPLETED 无错误不造假 ClassifiedError）——改的是 architecture 文档 §3.3（代码正确、文档滞后）。

### c2-2（bb6d7b5）StreamSession 聚合根 + #578 回归
StreamSession 聚合根，构造注入 Clock、phase 纯内存态。四迁移方法（markSettling/complete/abort/fail）经 canTransitionPhase 守卫、幂等。**#578 招牌回归**：abort 无条件先行——interrupt 永挂（HangingInterruptRuntime）时 phase 仍同步翻 terminal(aborted)、canAccept()=true、不卡死。canAccept 门 + apply 累积 + 空回合 buildFinalContent 返回 null。
- **评审中等已修**：snapshot() 补 finalContent 投影（原漏输出致消费方恒读 undefined，下游 StartStreamService 落库会空落库踩 FR-2.5/2.6）+ 正向断言补测试盲区。

### c2-3（b4a8b3e）EventMapper 契约与事件工具
event-factory（13 类事件构造工厂 + type guard，不重定义 c2-1 联合）+ result-projection（token 无上报留空不填 0 AC-9）+ phase-changed-event（由 C2 核心产出，不经 mapper）+ ports/driven/event-mapper（EventMapper 契约 + 未知事件降级不崩：返回 null、不抛/不伪造/不改语义 AC-8）。
- **评审无阻断缺陷**（唯一一个一次过的 epic），3 文档 nitpick 记 deferred。

## 累计质量指标

- 测试数：sk-1-1 起 7 → 逐 epic 增长 → c2-3 达 **499 全绿**。
- 守卫：全程 0 命中，扫描文件数 5→85。
- 对抗评审共抓到 **8+ 个真缺陷**（含 3 个中等/阻断级），全部修复且测试对齐正确规格、不迁就 bug。
