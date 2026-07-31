// agent-runtime/ports/driven/provider-read-port.ts
// C2 · AgentRuntime 出站端口：C7.ProviderRepository 的本地只读 import type 别名。
// 对齐 architecture §5.3。零框架 import；仅类型转出，无实现。
//
// 【依赖纪律 · 单向 import type · 务必分清】
// - 契约来源：引用图 C7.ProviderRepository → C2 消费；C7 architecture「ProviderRepository 供 C2 import 消费」。
// - C2 **只读**消费：解析 providerId → 协议 / endpoint / auth / model；**绝不写 Provider**
//   （写操作回 C7.ConfigureProviderUseCase）。
// - C2 只 import type 引用 C7 端口/值对象**类型**，绝不 import C7 运行实现，绝不反向被 C7 依赖。
//   实现由 C7 的 ProviderManagementModule 提供并经 NestJS DI 注入。
//
// 【C7 核心包尚未落地时的过渡说明】
// C7 尚未产出核心包（packages/core 内无 c7 目录），此处按 C7 architecture §3.3 / §5.1 的
// 权威签名给出**本地类型契约**（ResolvedProviderView / ProviderReadPort），刻画 C2 只读消费
// 所需的最小形状。待 C7 核心包落地后，此文件改为从 C7 包 import type 转出，保持 C2 侧引用点不变。

/**
 * ProviderProtocol —— C7 协议标识（对齐 C7 architecture §3.2 Protocol 枚举字面量）。
 * 本地以字符串字面量联合刻画只读消费所需形状，不 import C7 enum 运行值。
 */
export type ProviderProtocol =
  | 'anthropic'
  | 'openai-compatible'
  | 'xai'
  | 'openrouter'
  | 'bedrock'
  | 'vertex'
  | 'google'
  | 'gemini-image'
  | 'openai-image'
  | 'unknown';

/**
 * ResolvedProviderView —— C2 只读消费的解析结果视图（对齐 C7 architecture §3.3 ResolvedProvider）。
 *
 * 【为何是本地 View 而非直接 import C7.ResolvedProvider】C2 只需解析后的协议 / model /
 * 认证态用于路由与发起原生调用，不需要 C7 的 Provider 完整实体（含明文 apiKey 等）。
 * 此处刻画 C2 消费所需的最小只读投影；明文凭据的取用锁在适配器层，不进核心。
 *
 * - protocol：解析出的协议，决定 RuntimeKind 与原生调用形态。
 * - model：解析出的模型（可选；未定则由 options / Runtime 取默认）。
 * - authStyle：认证风格：api_key / auth_token / ambiguous。
 * - hasCredentials：是否已具备可用凭据（反假数据：无凭据不显假 ready）。
 * - source：解析来源标记，供 UI source breadcrumb。
 */
export interface ResolvedProviderView {
  readonly protocol: ProviderProtocol;
  readonly model?: string;
  readonly authStyle: 'api_key' | 'auth_token' | 'ambiguous';
  readonly hasCredentials: boolean;
  readonly source: 'provider' | 'env' | 'oauth' | 'none';
}

/**
 * ProviderReadPort —— C2 只读消费 C7 Provider 配置的最小端口契约（对齐 C7 architecture §5.1 只读子集）。
 *
 * 【只读纪律】仅暴露解析 / 读取，**不含任何写方法**（save/delete/setDefault/... 属 C7 写路径）。
 * 实现由 C7 ProviderManagementModule 的 SqliteProviderRepository 提供，经 DI 注入。
 */
export interface ProviderReadPort {
  /** 按 providerId 解析出 C2 消费所需的只读视图。 */
  resolve(providerId: string): Promise<ResolvedProviderView>;
}
