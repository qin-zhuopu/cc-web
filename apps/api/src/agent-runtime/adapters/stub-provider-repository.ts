// apps/api/src/agent-runtime/adapters/stub-provider-repository.ts
// C7.ProviderRepository 最小 Claude stub —— 顶替尚未落地的 C7 ProviderManagement（epic-accept / accept-1，SPEC CAP-1）。
//
// 【为何存在】本期 C7（ProviderManagement）核心包与 ProviderManagementModule 均不做（sprint-plan §四）。
//   但 c2-7 接线的 StartStreamService / GenerateTitleService 构造依赖注入一个 C7.ProviderReadPort
//   只读端口，才能把 providerId 解析成 协议 / model / 认证态 并装配 DI 图。本 stub 写死单个
//   Claude/anthropic provider 配置（映射到 RuntimeKind.CLAUDE_SDK，model 对齐 litellm 网关
//   Jereh-Kimi-K2.6），使本机 CLAUDE_SDK 单链路可端到端跑通。C7 真正落地后，AgentRuntimeModule
//   改 import ProviderManagementModule 并绑其 SqliteProviderRepository，本 stub 退场；控制器/用例引用点不变。
//
// 【只读纪律】只实现 ProviderReadPort 仅有的只读方法 resolve；绝不含任何写路径
//   （save/delete/setDefault 属 C7 写侧）。恒返回单个 anthropic 视图（本期只跑 CLAUDE_SDK 单链路）。
//   protocol='anthropic' 交由核心 resolveRuntimeKind 纯映射到 RuntimeKind.CLAUDE_SDK。
//
// 【反假数据】hasCredentials 反映真实凭据存在性——由接线层据 .env 的 ANTHROPIC_AUTH_TOKEN 是否就位
//   传入（构造注入），无凭据时不显假 ready。authStyle 固定 'auth_token'（litellm 网关经
//   ANTHROPIC_AUTH_TOKEN 认证，对齐 .env 约定）；source='env'（凭据/模型取自运行时环境）。
//
// 【密钥纪律】本文件绝不硬编码任何密钥字面量（不含 sk- 开头的 token）。明文 token 只在 .env
//   （gitignored），其存在性由接线层归约为布尔 hasCredentials 传入，token 值本身绝不进本 stub。
//
// 边界：本文件在 apps/api（框架层）。只 import type 核心端口/值对象类型，绝不污染 packages/core。

import type { ProviderReadPort, ResolvedProviderView } from '@codepilot/core';

/**
 * DEFAULT_STUB_MODEL —— stub 默认解析出的模型（对齐 litellm 网关统一路由模型）。
 * 非密钥、可安全硬编码；未经构造注入 model 时回退到此默认。
 */
export const DEFAULT_STUB_MODEL = 'Jereh-Kimi-K2.6';

/**
 * StubProviderRepository —— 写死单个 Claude/anthropic provider 的 C7.ProviderReadPort 只读占位实现。
 *
 * 无论传入何 providerId 都解析为同一 anthropic 视图（本期只跑单链路，映射到 RuntimeKind.CLAUDE_SDK）。
 */
export class StubProviderRepository implements ProviderReadPort {
  private readonly hasCredentials: boolean;
  private readonly model: string;

  /**
   * @param hasCredentials 是否已具备可用凭据（接线层据 .env 的 ANTHROPIC_AUTH_TOKEN 是否就位传入，反假数据）。
   * @param model          解析出的模型（可选；从 .env 的 ANTHROPIC_MODEL 透传，未定则回退 DEFAULT_STUB_MODEL）。
   */
  constructor(hasCredentials: boolean, model?: string) {
    this.hasCredentials = hasCredentials;
    this.model = model !== undefined && model.length > 0 ? model : DEFAULT_STUB_MODEL;
  }

  /**
   * 解析 providerId → 只读视图。本 stub 忽略 providerId，恒返回单个 anthropic provider 视图。
   * protocol='anthropic' → 核心 resolveRuntimeKind 映射到 RuntimeKind.CLAUDE_SDK。
   */
  async resolve(_providerId: string): Promise<ResolvedProviderView> {
    return {
      protocol: 'anthropic',
      model: this.model,
      authStyle: 'auth_token',
      hasCredentials: this.hasCredentials,
      source: 'env',
    };
  }
}
