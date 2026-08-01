// apps/api/src/agent-runtime/agent-runtime.tokens.ts
// C2 AgentRuntime DI token（对齐 conversation/conversation.tokens.ts 与 shared-kernel/sk-tokens.ts 的 Symbol 约定）。
//
// 为何用 Symbol 常量作 token：核心包的端口/用例均为 TS interface，运行时被擦除，无法充当
// NestJS 注入 token。故此处为每个出站端口/驱动用例声明进程内唯一的 Symbol。
//
// 边界：本文件在 apps/api，仅常量声明，不含 @nestjs import。核心包绝不出现这些 token。

// —— 出站端口（driven，供 C3 复用 / 控制器注入）——
/** AgentRuntimePort 出站端口 token —— 绑 RuntimeRouter（本期只注册 CLAUDE_SDK 适配器）。 */
export const AGENT_RUNTIME_PORT = Symbol('C2.AgentRuntimePort');

/**
 * C7 只读 ProviderReadPort token —— 权威实现归 C7 ProviderManagementModule（尚未落地）。
 * 本期绑最小 stub（写死单个 Claude/anthropic provider），C7 落地后替换为其只读仓储。
 */
export const PROVIDER_READ_PORT = Symbol('C2.ProviderReadPort');

/**
 * ForceAbortScheduler token —— 绑 SetTimeoutForceAbortScheduler（force-abort 安全网延时调度，c2-7-3）。
 * 内部装配用（AbortStreamService 构造第 3 参），不对外 export。
 */
export const FORCE_ABORT_SCHEDULER = Symbol('C2.ForceAbortScheduler');

/**
 * StreamSessionRegistry token —— 绑活跃回合内存注册表（c2-4，非持久层）。
 * 内部装配用（StartStreamService / AbortStreamService 共享同一实例），不对外 export。
 */
export const STREAM_SESSION_REGISTRY = Symbol('C2.StreamSessionRegistry');

// —— 驱动用例（driving，供 C3 控制器 / C1 消费）——
/** StartStreamUseCase token —— 绑 StartStreamService（发起回合）。 */
export const START_STREAM_USECASE = Symbol('C2.StartStreamUseCase');
/** AbortStreamUseCase token —— 绑 AbortStreamService（中断回合）。 */
export const ABORT_STREAM_USECASE = Symbol('C2.AbortStreamUseCase');
/**
 * TitleGenerator token —— 绑 GenerateTitleService（标题生成，权威归属 C2）。
 * 供 C1 经 forwardRef 注入（C1 的 SetSessionTitleService 消费此实现，解 C1↔C2 环的另一侧）。
 */
export const TITLE_GENERATOR = Symbol('C2.TitleGenerator');

// —— 验收链路适配器（epic-accept，均为 apps/api 最外层驱动/出站适配器，非核心）——
/**
 * SessionSseHub token —— 绑按会话的内存 SSE 广播中枢（accept-2 / SPEC CAP-2）。
 * 一次回合的归一事件经此 fan-out 给所有挂在该会话 stream 上的连接；纯内存，进程重启即空。
 */
export const SESSION_SSE_HUB = Symbol('C2.SessionSseHub');
/**
 * FileEventLog token —— 绑每会话 append-only 文件事件日志（accept-3 / SPEC CAP-3）。
 * 一式三份的第二份：一行一事件含单调递增 seq（SSE id 来源），也是断线补发数据源。
 */
export const FILE_EVENT_LOG = Symbol('C2.FileEventLog');
