// apps/api/src/shared-kernel/adapters/system-clock.ts
// Clock 端口的生产适配器（占位实现，供 DI 图装配，后续 epic 可替换）。
//
// 边界说明：本文件位于 apps/api 适配器层，允许直读系统时钟；
//           核心包铁律（禁直调系统时钟）只约束 packages/core，不约束此处。
import type { Clock } from '@codepilot/core';

/** 生产 Clock：返回系统真实时刻（epoch 毫秒）。 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
