// apps/api/src/agent-runtime/controllers/runtime.controller.ts
// C2 驱动适配器：Runtime 可用性查询 REST 控制器（epic-c2-7 / c2-7-5，对齐 SPEC CAP-4、PRD §0 反假数据、architecture §8 controllers）。
//
// 【职责】GET /api/runtime/availability → AgentRuntimePort.availability() 投影给客户端。
//
// 【薄层 + 反假数据铁律】控制器只做协议边界翻译（端口结果 ↔ HTTP JSON），不含业务判定。
//   availability() 的三态（ready / unavailable / unknown）由适配器/路由如实产出：
//   未注册 Runtime 显 unavailable 或 unknown，【绝不显假 ready】（PRD §0）。控制器忠实投影、不篡改、不臆造。
//
// 【安全提醒】本端点【无鉴权 / 无访问控制】。项目定位为「本机运行的单机应用」，可接受；
//   但绝不可暴露到公网。生产化前必须补访问控制。
//
// 边界：控制器在 apps/api（框架层），允许 import @nestjs/*；端口经 @Inject(Symbol token) 注入。
import { Controller, Get, Inject } from '@nestjs/common';
import type { AgentRuntimePort, RuntimeAvailability } from '@codepilot/core';
import { AGENT_RUNTIME_PORT } from '../agent-runtime.tokens.js';

@Controller('api/runtime')
export class RuntimeController {
  constructor(
    @Inject(AGENT_RUNTIME_PORT)
    private readonly runtime: AgentRuntimePort,
  ) {}

  /**
   * GET /api/runtime/availability —— 探测并投影 Runtime 可用性。
   *
   * 薄层：直接返回 AgentRuntimePort.availability() 的三态结果（ready/unavailable/unknown），
   *   忠实透传不伪造——未注册 Runtime 绝不显假 ready（反假数据，PRD §0）。
   */
  @Get('availability')
  async availability(): Promise<RuntimeAvailability> {
    return this.runtime.availability();
  }
}
