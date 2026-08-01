// ports/platform.ts
// SK 共享内核：Platform 端口——统一平台信息抽象（对齐 architecture.md §4.2、FR-2.2/FR-2.3）。
// 零框架 import。本文件只定义端口接口，不含任何适配器实现。
//
// 语义契约：
//   - 生产适配器 NodePlatform（在 apps/api 适配器层）读取 process.platform / process.arch，
//     映射为下列受限的 OsType / ArchType。
//   - Platform 只读且不可变：上层（领域/应用逻辑）不得通过它修改环境状态（FR-2.2）。
//   - 平台信息进程内稳定：同一进程内多次调用 info() 返回一致结果（FR-2.3）。

/** 操作系统类型，映射自 process.platform，未知值归一为 'unknown'。 */
export type OsType = 'darwin' | 'win32' | 'linux' | 'unknown';

/** CPU 架构类型，映射自 process.arch，未知值归一为 'unknown'。 */
export type ArchType = 'x64' | 'arm64' | 'unknown';

/** 只读平台信息快照：全字段 readonly，进程内稳定。 */
export interface PlatformInfo {
  /** 操作系统类型。 */
  readonly os: OsType;
  /** CPU 架构类型。 */
  readonly arch: ArchType;
  /** 运行时标识，核心包始终运行于 Node。 */
  readonly runtime: 'node';
}

/**
 * 平台信息端口：统一提供当前运行环境的只读描述。
 * 生产实现读取 process.platform / process.arch（在适配器层）；
 * 只读不可变，上层不得通过它修改环境状态（FR-2.2）；进程内稳定（FR-2.3）。
 */
export interface Platform {
  /** 返回只读平台信息，进程内稳定。 */
  info(): PlatformInfo;
}
