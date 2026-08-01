// apps/api/src/shared-kernel/shared-kernel.module.ts
// SharedKernelModule：把 7 个 SK 端口 token 绑定到实现并 exports，供其余 Module 注入
// （对齐 architecture.md §5、AC-10）。
//
// 边界：本文件在 apps/api（SK 唯一带 NestJS 框架的部分）。packages/core 内绝不出现
//       @nestjs import（AC-10）——框架接线只落在此处。
//
// 绑定策略：
//   - ERROR_CLASSIFIER → useValue: defaultErrorClassifier（核心包已提供的纯函数，真实可用）。
//   - 其余 6 个端口 → useClass 绑定 apps/api 适配器层的占位实现，让 DI 图能装配、
//     能被后续 epic 平滑替换。RingBufferRuntimeLog 依赖 Clock + Redactor，用 useFactory 装配。
import { Module } from '@nestjs/common';
import { defaultErrorClassifier } from '@codepilot/core';
import type { Clock, Redactor } from '@codepilot/core';
import {
  CLOCK,
  ERROR_CLASSIFIER,
  ID_GENERATOR,
  PLATFORM,
  REDACTOR,
  RUNTIME_LOG,
  TRANSLATION_PORT,
} from './sk-tokens.js';
import { SystemClock } from './adapters/system-clock.js';
import { UuidGenerator } from './adapters/uuid-generator.js';
import { NodePlatform } from './adapters/node-platform.js';
import { RegexRedactor } from './adapters/regex-redactor.js';
import { RingBufferRuntimeLog } from './adapters/ring-buffer-runtime-log.js';
import { JsonTranslationTable } from './adapters/json-translation-table.js';

@Module({
  providers: [
    // ErrorClassifier：核心纯函数值，直接 useValue 绑定。
    { provide: ERROR_CLASSIFIER, useValue: defaultErrorClassifier },
    // 无依赖的占位适配器：useClass 绑定。
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidGenerator },
    { provide: PLATFORM, useClass: NodePlatform },
    { provide: REDACTOR, useClass: RegexRedactor },
    { provide: TRANSLATION_PORT, useClass: JsonTranslationTable },
    // RuntimeLog 依赖 Clock + Redactor，用 useFactory 从容器解析依赖后装配。
    {
      provide: RUNTIME_LOG,
      useFactory: (clock: Clock, redactor: Redactor) =>
        new RingBufferRuntimeLog(clock, redactor),
      inject: [CLOCK, REDACTOR],
    },
  ],
  exports: [
    ERROR_CLASSIFIER,
    CLOCK,
    ID_GENERATOR,
    PLATFORM,
    REDACTOR,
    RUNTIME_LOG,
    TRANSLATION_PORT,
  ],
})
export class SharedKernelModule {}
