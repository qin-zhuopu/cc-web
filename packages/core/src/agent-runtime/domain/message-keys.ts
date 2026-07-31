// agent-runtime/domain/message-keys.ts
// C2 AgentRuntime 领域边界：C2 自身产生的 i18n 消息键常量表。零框架 import，仅常量。
// C2 只贡献键、不含具体文案（locale 文案表由 apps/api 适配器层提供），渲染交 SK.TranslationPort。
//
// 只读性（仿 SK message-keys.ts / C1_MESSAGE_KEYS 范式，见 architecture §6 末段）：
//   - as const 给出字面量类型 + 只读，防止运行时篡改与键值漂移。
//   - satisfies Readonly<Record<string, string>> 约束值恒为字符串键。
//   - Object.freeze 兑现「运行时只读」：ESM strict 下对冻结属性赋值抛 TypeError
//     （as const 仅编译期只读，运行时对象仍可写，故必须冻结）。
//
// 命名空间：全部键以 c2. 开头，与 SK 的 sk.*、C1 的 c1.* 命名空间互不重叠。
//
// 边界纪律（架构 §6 末段 / §9）：
//   - C2 只贡献 c2.* 状态/中断等自有用户可见文案 key。
//   - 错误文案 key 一律来自 SK.ErrorClassifier 的 messageKey（sk.error.*），
//     C2 此处**不复制、不重定义**任何 SK 错误文案 key（含 ABORTED/TIMEOUT/PROCESS 等）；
//     终态归因经 ClassifiedError.code → SK_MESSAGE_KEYS 解析，见 terminal-reason 建模。

/**
 * C2 产生的 i18n 消息键常量：回合相位状态与中断流程的用户可见提示文案 key。
 * 全项目键真相源——C2 领域/用例代码与 i18n 适配器均引用本表。
 */
export const C2_MESSAGE_KEYS = Object.freeze({
  /** 回合正常完成的状态提示 */
  streamCompleted: 'c2.stream.completed',
  /** 回合被用户主动中断的状态提示（区别于「出错了」，对应 TerminalSubstate.ABORTED） */
  streamAborted: 'c2.stream.aborted',
  /** 回合出错终止的状态提示（具体错因文案另由 SK.ErrorClassifier.messageKey 提供） */
  streamErrored: 'c2.stream.errored',
  /** 回合进行中（active 相位）的状态提示 */
  streamActive: 'c2.stream.active',
  /** 收尾中（settling 相位）的状态提示：已请求中断/收到终止信号，产物收尾中 */
  streamSettling: 'c2.stream.settling',

  /** 用户点「停止」时的即时中断提示 */
  interruptRequested: 'c2.interrupt.requested',
  /** 优雅中断挂起、force-abort 安全网兜底强停时的提示 */
  interruptForced: 'c2.interrupt.forced',

  /** Runtime 不可用（探测失败，不显假 ready）时的提示 */
  runtimeUnavailable: 'c2.runtime.unavailable',
  /** Runtime 可用性未知时的提示 */
  runtimeUnknown: 'c2.runtime.unknown',
} as const satisfies Readonly<Record<string, string>>);
