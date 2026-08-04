// apps/api/src/conversation/conversation.module.ts
// ConversationModule：C1 会话领域边界的 NestJS DI 接线（epic-c1-6 / c1-6-1，对齐 architecture §7）。
//
// 边界：本文件在 apps/api（框架层）。核心包零框架——用例 service 类从 @codepilot/core 值导入，
//   经此处 useFactory 手工注入其构造依赖（core 里没有 @Injectable 装饰器，DI 全在此接线）。
//
// 接线要点：
//   - imports SharedKernelModule（拿 Clock/IdGenerator/RuntimeLog）；DatabaseModule 为 global，
//     DATABASE token 全局可注入，无需在此重复 imports。
//   - 仓储：SqliteSessionRepository/SqliteMessageRepository 经 useFactory inject DATABASE。
//   - 4 个用例：按各自构造签名 useFactory inject 对应 token（构造参数顺序务必对齐 core 里的 constructor）。
//   - TitleGenerator：权威实现归 C2（GenerateTitleService）。经 forwardRef(() => AgentRuntimeModule)
//     import 拿 C2 exports 的 TITLE_GENERATOR，绑到 C1 的 TITLE_GENERATOR token（解 C1↔C2 环的一侧；
//     C2 侧 imports forwardRef(() => ConversationModule) 拿 C1 用例，两侧成对才能解环）。
//     StubTitleGenerator 已退场（C2 真实现落地）。
//   - exports：只导出 4 个用例 token 供 C2/C5 消费；【不 export 仓储写端口】——
//     消费方只能经用例读写会话/消息，不得绕过用例直写库（c1-6-4 消费方契约）。
import { Module, forwardRef } from '@nestjs/common';
import {
  ManageSessionService,
  SetSessionTitleService,
  AppendMessageService,
  GetSessionHistoryService,
} from '@codepilot/core';
import type {
  Clock,
  IdGenerator,
  RuntimeLog,
  SessionRepository,
  MessageRepository,
  GetSessionHistoryUseCase,
  TitleGeneratorPort,
} from '@codepilot/core';
import type BetterSqlite3 from 'better-sqlite3';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module.js';
import { CLOCK, ID_GENERATOR, RUNTIME_LOG } from '../shared-kernel/sk-tokens.js';
import { DATABASE } from '../database/database.tokens.js';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.js';
import { SqliteMessageRepository } from './adapters/sqlite-message-repository.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { TITLE_GENERATOR as C2_TITLE_GENERATOR } from '../agent-runtime/agent-runtime.tokens.js';
import { SessionController } from './controllers/session.controller.js';
import { MessageController } from './controllers/message.controller.js';
import {
  SESSION_REPOSITORY,
  MESSAGE_REPOSITORY,
  TITLE_GENERATOR,
  MANAGE_SESSION_USECASE,
  SET_SESSION_TITLE_USECASE,
  APPEND_MESSAGE_USECASE,
  GET_SESSION_HISTORY_USECASE,
} from './conversation.tokens.js';

@Module({
  imports: [SharedKernelModule, forwardRef(() => AgentRuntimeModule)],
  providers: [
    // —— 出站适配器 ——
    {
      provide: SESSION_REPOSITORY,
      useFactory: (db: BetterSqlite3.Database) => new SqliteSessionRepository(db),
      inject: [DATABASE],
    },
    {
      provide: MESSAGE_REPOSITORY,
      useFactory: (db: BetterSqlite3.Database) => new SqliteMessageRepository(db),
      inject: [DATABASE],
    },
    // TitleGenerator：权威实现归 C2（GenerateTitleService）。经 forwardRef import AgentRuntimeModule
    // 拿其 exports 的 C2_TITLE_GENERATOR，重绑到 C1 的 TITLE_GENERATOR token（SetSessionTitleService 消费此实现）。
    {
      provide: TITLE_GENERATOR,
      useFactory: (titleGenerator: TitleGeneratorPort) => titleGenerator,
      inject: [C2_TITLE_GENERATOR],
    },

    // —— 驱动用例（构造参数顺序严格对齐 core 里各 service 的 constructor）——
    // ManageSessionService(SessionRepository, MessageRepository, Clock, IdGenerator)
    {
      provide: MANAGE_SESSION_USECASE,
      useFactory: (
        sessions: SessionRepository,
        messages: MessageRepository,
        clock: Clock,
        ids: IdGenerator,
      ) => new ManageSessionService(sessions, messages, clock, ids),
      inject: [SESSION_REPOSITORY, MESSAGE_REPOSITORY, CLOCK, ID_GENERATOR],
    },
    // GetSessionHistoryService(MessageRepository)
    {
      provide: GET_SESSION_HISTORY_USECASE,
      useFactory: (messages: MessageRepository) =>
        new GetSessionHistoryService(messages),
      inject: [MESSAGE_REPOSITORY],
    },
    // AppendMessageService(MessageRepository, SessionRepository, Clock, IdGenerator) —— 注意 messages 在前
    {
      provide: APPEND_MESSAGE_USECASE,
      useFactory: (
        messages: MessageRepository,
        sessions: SessionRepository,
        clock: Clock,
        ids: IdGenerator,
      ) => new AppendMessageService(messages, sessions, clock, ids),
      inject: [MESSAGE_REPOSITORY, SESSION_REPOSITORY, CLOCK, ID_GENERATOR],
    },
    // SetSessionTitleService(SessionRepository, GetSessionHistoryUseCase, TitleGeneratorPort, Clock, RuntimeLog)
    {
      provide: SET_SESSION_TITLE_USECASE,
      useFactory: (
        sessions: SessionRepository,
        history: GetSessionHistoryUseCase,
        titleGenerator: TitleGeneratorPort,
        clock: Clock,
        runtimeLog: RuntimeLog,
      ) =>
        new SetSessionTitleService(
          sessions,
          history,
          titleGenerator,
          clock,
          runtimeLog,
        ),
      inject: [
        SESSION_REPOSITORY,
        GET_SESSION_HISTORY_USECASE,
        TITLE_GENERATOR,
        CLOCK,
        RUNTIME_LOG,
      ],
    },
  ],
  controllers: [SessionController, MessageController],
  // 只导出用例 token（供 C2/C5 经用例读写）；不导出仓储写端口（消费方契约，c1-6-4）。
  exports: [
    MANAGE_SESSION_USECASE,
    SET_SESSION_TITLE_USECASE,
    APPEND_MESSAGE_USECASE,
    GET_SESSION_HISTORY_USECASE,
  ],
})
export class ConversationModule {}
