// apps/api/src/app.module.ts
// 应用根 Module：聚合各领域边界的 Module（epic-c1-6 起）。
//
// DatabaseModule.forRoot() 为 global（DATABASE token 全局可注入），在根一次装配连接；
// 缺省用 CODEPILOT_DB_PATH 或 codepilot.db 文件（测试经 ConversationModule spec 单独用 :memory: 装配）。
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module.js';
import { ConversationModule } from './conversation/conversation.module.js';

@Module({
  imports: [
    DatabaseModule.forRoot(),
    SharedKernelModule,
    ConversationModule,
  ],
})
export class AppModule {}
