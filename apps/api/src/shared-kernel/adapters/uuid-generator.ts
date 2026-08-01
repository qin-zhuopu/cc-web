// apps/api/src/shared-kernel/adapters/uuid-generator.ts
// IdGenerator 端口的生产适配器（占位实现，供 DI 图装配，后续 epic 可替换）。
//
// 边界说明：本文件位于 apps/api 适配器层，允许直调 node:crypto randomUUID；
//           核心包铁律（禁 import uuid / 直调 randomUUID）只约束 packages/core。
import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '@codepilot/core';

/** 生产 IdGenerator：返回 UUID v4。 */
export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
