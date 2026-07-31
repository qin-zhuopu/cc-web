# 限界上下文边界契约（防重叠）

> 每个子 agent 生成 BMad 文档前**必须先读本表**，只在自己边界内产出，跨边界的能力通过"依赖的端口"引用，不得重复定义。

## 契约格式说明
- **拥有**：该上下文独占的领域概念、数据、用例
- **不包含**：明确排除的、属于别处的东西（防越界）
- **依赖端口**：本上下文需要、但由别的上下文/适配器提供的接口（只引用不实现）
- **对外提供端口**：本上下文暴露给别人用的接口

---

## SK · Shared Kernel
- **拥有**：结构化错误类型（16 类）、平台检测、脱敏 Redactor、i18n 翻译端口、运行时日志环形缓冲、Clock、IdGenerator
- **不包含**：任何业务领域逻辑（不知道会话、消息、Provider 是什么）
- **依赖端口**：无（最底层）
- **对外提供端口**：`ErrorClassifier`、`Platform`、`Redactor`、`TranslationPort`、`RuntimeLog`、`Clock`、`IdGenerator`

## C1 · Conversation
- **拥有**：ChatSession/Message 实体、MessageContent 值对象、会话与消息生命周期用例
- **不包含**：AI 如何生成回复（属 C2）、标题如何被 AI 生成（调 C2 端口）、持久化实现细节
- **依赖端口**：SK.Clock/IdGenerator、C2.`TitleGenerator`（生成标题）
- **对外提供端口**：`AppendMessageUseCase`、`GetSessionHistoryUseCase` 等；出站 `SessionRepository`、`MessageRepository`

## C2 · AgentRuntime
- **拥有**：StreamSession 实体（含 phase 状态机 active→settling→terminal）、AgentStreamEvent、多 Runtime 抽象
- **不包含**：会话/消息如何持久化（属 C1）、子 agent 编排（属 C3）
- **依赖端口**：SK.ErrorClassifier
- **对外提供端口**：`StartStreamUseCase`、`AbortStreamUseCase`、`AgentRuntimePort`（供 C3 复用）、`TitleGenerator`（供 C1）

## C3 · SubagentOrchestration
- **拥有**：LogicalRun/Attempt 实体、RunPhase 状态机、SubagentEvent
- **不包含**：AI 调用本身（复用 C2.AgentRuntimePort）、权限 UI（复用 C5.PermissionBroker）
- **依赖端口**：C2.`AgentRuntimePort`、C5.`PermissionBrokerPort`
- **对外提供端口**：`SpawnSubagentUseCase`、`SubagentRunRepository`

## C4 · MediaGeneration
- **拥有**：图片生成请求、批量任务 Job/JobItem、媒体元数据与标签
- **不包含**：文本 AI 流（属 C2）
- **依赖端口**：SK.IdGenerator
- **对外提供端口**：`GenerateImageUseCase`、`RunBatchJobUseCase`、`ImageGeneratorPort`、`MediaRepository`

## C5 · Bridge
- **拥有**：入站路由、出站投递、权限经纪、消息分片
- **不包含**：渠道协议细节（属 C6）、会话逻辑（调 C1）、AI（调 C2）
- **依赖端口**：C6.`ChannelPluginPort`、C1 会话用例、C2 运行时
- **对外提供端口**：`RouteInboundMessageUseCase`、`PermissionBrokerPort`（供 C3）、`DeliveryPort`

## C6 · Channel
- **拥有**：ChannelPlugin 合约、渠道能力探测、渠道特定渲染
- **不包含**：路由/投递编排（属 C5）
- **依赖端口**：无核心依赖
- **对外提供端口**：`ChannelPluginPort<T>`、`ProbeChannelUseCase`

## C7 · ProviderManagement
- **拥有**：Provider 配置、5 探针诊断、Auth 解析
- **不包含**：AI 调用（属 C2，C2 消费 Provider 配置）
- **依赖端口**：SK.ErrorClassifier
- **对外提供端口**：`ConfigureProviderUseCase`、`DiagnoseUseCase`、`ProviderRepository`

## C8 · Workspace
- **拥有**：文件树浏览、文件预览
- **不包含**：文件如何被 AI 使用
- **依赖端口**：无
- **对外提供端口**：`BrowseFilesUseCase`、`FileSystemPort`

## C9 · PluginMCP
- **拥有**：MCP server 注册、Skill 加载
- **不包含**：MCP 工具被 AI 调用的编排（属 C2）
- **依赖端口**：SK
- **对外提供端口**：`RegisterMcpServerUseCase`、`McpServerPort`、`SkillLoaderPort`

## C10 · Task
- **拥有**：TodoWrite 任务项同步
- **不包含**：任务由谁产生（C2 SDK 事件）
- **依赖端口**：无
- **对外提供端口**：`SyncTasksUseCase`、`TaskRepository`

---

## 跨上下文端口引用图
```
SK  ← 所有上下文
C2.AgentRuntimePort  ← C3
C2.TitleGenerator    ← C1
C5.PermissionBrokerPort ← C3
C6.ChannelPluginPort ← C5
C1 会话用例 ← C5
C7.ProviderRepository → C2 消费
```
