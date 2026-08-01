// apps/api/src/conversation/controllers/session.controller.ts
// C1 驱动适配器：会话 REST 控制器（epic-c1-6 / c1-6-2，对齐 architecture §7）。
//
// 【安全提醒】本控制器无鉴权/无访问控制。项目定位为「本机运行的单机应用」，可接受；
//   但绝不可将此 HTTP 端点暴露到公网——无认证的会话读写会被任意访问。
//
// 边界：控制器只注入【用例 token】，绝不注入仓储——消费方只能经用例读写（c1-6-4 契约）。
// 用例经 @Inject(Symbol token) 注入（interface 无运行时值，必须用 token）。
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type {
  ManageSessionUseCase,
  SetSessionTitleUseCase,
  ChatSession,
  SessionMode,
  SessionSource,
  SessionStatus,
} from '@codepilot/core';
import {
  MANAGE_SESSION_USECASE,
  SET_SESSION_TITLE_USECASE,
} from '../conversation.tokens.js';

/** 创建会话请求体（字段可选，缺省语义由用例填充）。 */
interface CreateSessionBody {
  title?: string;
  mode?: SessionMode;
  source?: SessionSource;
  workingDirectory?: string;
  projectName?: string;
}

/** PATCH 会话请求体：支持 rename（title）或状态切换（archive/unarchive）。 */
interface PatchSessionBody {
  title?: string;
  action?: 'archive' | 'unarchive';
}

@Controller('api/sessions')
export class SessionController {
  constructor(
    @Inject(MANAGE_SESSION_USECASE)
    private readonly manageSession: ManageSessionUseCase,
    @Inject(SET_SESSION_TITLE_USECASE)
    private readonly setTitle: SetSessionTitleUseCase,
  ) {}

  /** GET /api/sessions?status=active&limit=50 —— 列表（用例默认过滤 task、按 updatedAt 倒序）。 */
  @Get()
  async list(
    @Query('status') status?: SessionStatus,
    @Query('limit') limit?: string,
  ): Promise<ReadonlyArray<ChatSession>> {
    return this.manageSession.list({
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  }

  /** GET /api/sessions/:id —— 取单个会话；不存在 404。 */
  @Get(':id')
  async getById(@Param('id') id: string): Promise<ChatSession> {
    const session = await this.manageSession.getById(id);
    if (session === undefined) {
      throw new NotFoundException(`会话不存在（id=${id}）。`);
    }
    return session;
  }

  /** POST /api/sessions —— 创建会话。 */
  @Post()
  async create(@Body() body: CreateSessionBody): Promise<ChatSession> {
    return this.manageSession.create({
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.mode === undefined ? {} : { mode: body.mode }),
      ...(body.source === undefined ? {} : { source: body.source }),
      ...(body.workingDirectory === undefined
        ? {}
        : { workingDirectory: body.workingDirectory }),
      ...(body.projectName === undefined
        ? {}
        : { projectName: body.projectName }),
    });
  }

  /** PATCH /api/sessions/:id —— 重命名或归档/取消归档。 */
  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Body() body: PatchSessionBody,
  ): Promise<ChatSession | { ok: true }> {
    if (body.title !== undefined) {
      return this.manageSession.rename(id, body.title);
    }
    if (body.action === 'archive') {
      await this.manageSession.archive(id);
      return { ok: true };
    }
    if (body.action === 'unarchive') {
      await this.manageSession.unarchive(id);
      return { ok: true };
    }
    throw new NotFoundException('PATCH 需提供 title（重命名）或 action=archive|unarchive。');
  }

  /** POST /api/sessions/:id/title:generate —— 触发 AI 生成标题（本期 stub 降级，保留原标题）。 */
  @Post(':id/title:generate')
  async generateTitle(@Param('id') id: string): Promise<ChatSession> {
    return this.setTitle.generateByAi(id);
  }

  /** DELETE /api/sessions/:id —— 删除会话（级联删消息）。 */
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: true }> {
    await this.manageSession.delete(id);
    return { ok: true };
  }
}
