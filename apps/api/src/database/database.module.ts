// apps/api/src/database/database.module.ts
// DatabaseModule：把 better-sqlite3 单例连接绑到 DATABASE token 并 exports，
// 供 ConversationModule 的仓储适配器注入（对齐 architecture §7）。
//
// 边界：本文件在 apps/api（适配器/框架层）。better-sqlite3 + @nestjs 依赖只落此层，
//       packages/core 绝不出现（import 守卫扫 packages/core/src，此处合规）。
//
// 连接路径：默认取环境变量 CODEPILOT_DB_PATH，缺省用进程工作目录下 codepilot.db。
//   测试经 forRoot(':memory:') 传内存库，避免落盘、彼此隔离。
import { Module, type DynamicModule } from '@nestjs/common';
import Database from 'better-sqlite3';
import { DATABASE } from './database.tokens.js';
import { initDatabase } from './init-db.js';

/** 缺省数据库文件路径（可经环境变量覆盖）。 */
const DEFAULT_DB_PATH = process.env.CODEPILOT_DB_PATH ?? 'codepilot.db';

@Module({})
export class DatabaseModule {
  /**
   * 装配 DatabaseModule。
   *
   * @param dbPath 连接路径；缺省用 DEFAULT_DB_PATH。测试传 ':memory:'。
   */
  static forRoot(dbPath: string = DEFAULT_DB_PATH): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE,
          // 建连接 → 设 PRAGMA + 建表（幂等）→ 绑定为单例。整个进程共享同一连接。
          useFactory: () => initDatabase(new Database(dbPath)),
        },
      ],
      exports: [DATABASE],
    };
  }
}
