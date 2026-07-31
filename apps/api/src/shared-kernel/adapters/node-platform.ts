// apps/api/src/shared-kernel/adapters/node-platform.ts
// Platform 端口的生产适配器（占位实现，供 DI 图装配，后续 epic 可替换）。
//
// 读取 process.platform / process.arch，映射为受限的 OsType / ArchType；
// 进程内稳定：构造时快照一次，info() 恒返回同一只读对象（FR-2.3）。
import type { Platform, PlatformInfo, OsType, ArchType } from '@codepilot/core';

/** process.platform → OsType，未知归一为 'unknown'。 */
function mapOs(platform: string): OsType {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  return 'unknown';
}

/** process.arch → ArchType，未知归一为 'unknown'。 */
function mapArch(arch: string): ArchType {
  if (arch === 'x64' || arch === 'arm64') {
    return arch;
  }
  return 'unknown';
}

/** 生产 Platform：读取 process 平台信息，进程内稳定。 */
export class NodePlatform implements Platform {
  private readonly snapshot: PlatformInfo;

  constructor() {
    this.snapshot = Object.freeze({
      os: mapOs(process.platform),
      arch: mapArch(process.arch),
      runtime: 'node',
    });
  }

  info(): PlatformInfo {
    return this.snapshot;
  }
}
