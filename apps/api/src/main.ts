// apps/api/src/main.ts
// NestJS 应用入口（epic-c1-6 起）：装配 AppModule 并监听 HTTP。
//
// 【安全提醒】当前 API 无鉴权/无访问控制，仅限本机单机运行（项目定位为本地 Web 应用）。
//   默认只监听 127.0.0.1，避免无意暴露到局域网/公网。端口/主机可经环境变量覆盖。
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

/** 监听端口（可经 PORT 覆盖）。 */
const PORT = Number(process.env.PORT ?? 3001);
/** 监听主机：默认仅本机回环，勿改成 0.0.0.0 暴露公网（无鉴权）。 */
const HOST = process.env.HOST ?? '127.0.0.1';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(PORT, HOST);
  // eslint-disable-next-line no-console
  console.log(`codepilot-api 已启动：http://${HOST}:${PORT}（本机单机，无鉴权，勿暴露公网）`);
}

void bootstrap();
