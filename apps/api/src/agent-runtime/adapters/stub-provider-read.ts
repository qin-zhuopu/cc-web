// apps/api/src/agent-runtime/adapters/stub-provider-read.ts
// C2 · StubProviderReadPort —— C7 ProviderReadPort 的最小只读占位实现（epic-c2-7 / c2-7-4）。
//
// 【为何存在】C7（ProviderManagement）核心包与 ProviderManagementModule 尚未落地，但 C2 的
//   StartStreamService / GenerateTitleService 构造需要一个 ProviderReadPort 实现才能装配 DI 图。
//   本 stub 写死单个 Claude/anthropic provider，使本机 CLAUDE_SDK 链路可端到端跑通。
//   C7 落地后，AgentRuntimeModule 改 import ProviderManagementModule 并绑其只读仓储，本 stub 退场。
//
// 【只读纪律】只实现 resolve（ProviderReadPort 仅有的只读方法）；不含任何写路径。
//   解析结果的 protocol='anthropic' → 经 resolveRuntimeKind 映射到 RuntimeKind.CLAUDE_SDK。
//
// 【反假数据】hasCredentials 反映真实凭据存在性——由构造注入（接线层据 .env 的 ANTHROPIC_AUTH_TOKEN
//   是否就位传入），无凭据时不显假 ready。model 从 .env 的 ANTHROPIC_MODEL 透传（可选）。
//
// 边界：本文件在 apps/api（框架层）。只 import type 核心端口/值对象类型，绝不污染 packages/core。

import type { ProviderReadPort, ResolvedProviderView } from '@codepilot/core';

/**
 * StubProviderReadPort —— 写死单个 Claude/anthropic provider 的只读端口占位实现。
 *
 * 无论传入何 providerId 都解析为同一 anthropic 视图（本期只跑 CLAUDE_SDK 单链路）。
 * authStyle 固定 'auth_token'（litellm 网关经 ANTHROPIC_AUTH_TOKEN 认证，对齐 .env 约定）。
 */
export class StubProviderReadPort implements ProviderReadPort {
  private readonly hasCredentials: boolean;
  private readonly model?: string;

  /**
   * @param hasCredentials 是否已具备可用凭据（接线层据 .env 的 ANTHROPIC_AUTH_TOKEN 是否就位传入，反假数据）。
   * @param model          解析出的模型（可选；从 .env 的 ANTHROPIC_MODEL 透传，未定则由 Runtime 取默认）。
   */
  constructor(hasCredentials: boolean, model?: string) {
    this.hasCredentials = hasCredentials;
    this.model = model;
  }

  /**
   * 解析 providerId → 只读视图。本 stub 忽略 providerId，恒返回单个 anthropic provider 视图。
   * source='env'：凭据/模型来自运行时环境（.env），供 UI source breadcrumb。
   */
  async resolve(_providerId: string): Promise<ResolvedProviderView> {
    return {
      protocol: 'anthropic',
      ...(this.model === undefined ? {} : { model: this.model }),
      authStyle: 'auth_token',
      hasCredentials: this.hasCredentials,
      source: 'env',
    };
  }
}
