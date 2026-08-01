// apps/api/src/agent-runtime/controllers/permission.controller.ts
// C2 驱动适配器：权限决议中转 REST 控制器（epic-c2-7 / c2-7-2，对齐 SPEC CAP-2、PRD FR-7.2/7.3、architecture §6.6）。
//
// 【职责】接收上层（经 C5 经纪）对某次权限请求的决议 → 忠实转发给对应回合的 Runtime 适配器
//   （经注入的 AgentRuntimePort，本期即 RuntimeRouter）。权限【请求】产出侧（permission_request 事件）
//   由 EventMapper 归一，属 c2-3，不在此控制器。
//
// 【C2 绝无经纪逻辑（FR-7.3）】本控制器与转发路径【只忠实透传】permissionRequestId/status/updatedInput/denyMessage——
//   绝不含自动批准、超时自动拒绝、任何裁决逻辑，那全部归 C5。C2 不篡改、不裁决。
//
// 【安全提醒】本控制器无鉴权/无访问控制。项目定位为「本机运行的单机应用」，可接受；
//   但绝不可将此 HTTP 端点暴露到公网——无认证的权限决议端点会被任意伪造决议。生产化前必须补访问控制。
//
// 边界：控制器只做协议边界翻译（HTTP body ↔ 端口入参），不含业务判定；经 @Inject(Symbol token) 注入端口。
import { Body, Controller, Inject, Post } from '@nestjs/common';
import type { AgentRuntimePort, PermissionDecision } from '@codepilot/core';
import { AGENT_RUNTIME_PORT } from '../agent-runtime.tokens.js';

/**
 * 权限决议请求体——上层（经 C5 经纪）对某次权限请求的裁决结果。
 * 与核心 PermissionDecision 形状对齐；streamId 定位在途回合（对应 TurnRef.streamId）。
 * 所有字段忠实透传，C2 不篡改。
 */
interface ResolvePermissionBody {
  /** 目标回合标识（TurnRef.streamId），用于定位对应适配器。 */
  streamId: string;
  /** 权限请求标识（对齐 PermissionRequest.id）。 */
  permissionRequestId: string;
  /** 决议结果：allow（本次批准）/ allow_session（本会话批准同类）/ deny（拒绝）。 */
  status: 'allow' | 'allow_session' | 'deny';
  /** 可选，批准时上层下发的修订工具入参，原样透传。 */
  updatedInput?: Record<string, unknown>;
  /** 可选，拒绝时回传的说明文案，原样透传。 */
  denyMessage?: string;
}

@Controller('api/chat')
export class PermissionController {
  constructor(
    @Inject(AGENT_RUNTIME_PORT)
    private readonly runtime: AgentRuntimePort,
  ) {}

  /**
   * POST /api/chat/permission —— 转发一条权限决议给对应回合的 Runtime。
   *
   * C2 只中转：把 body 忠实映射成 PermissionDecision，经 AgentRuntimePort.resolvePermission
   *   委派到对应适配器（按 streamId 定位）。绝不裁决、绝不篡改。
   */
  @Post('permission')
  async resolve(@Body() body: ResolvePermissionBody): Promise<{ ok: true }> {
    // 忠实透传：只挑可选字段存在时才带上，不预填假默认（反假数据）。
    const decision: PermissionDecision = {
      permissionRequestId: body.permissionRequestId,
      status: body.status,
      ...(body.updatedInput === undefined ? {} : { updatedInput: body.updatedInput }),
      ...(body.denyMessage === undefined ? {} : { denyMessage: body.denyMessage }),
    };
    await this.runtime.resolvePermission({ streamId: body.streamId }, decision);
    return { ok: true };
  }
}
