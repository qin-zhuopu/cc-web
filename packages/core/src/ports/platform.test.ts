// ports/platform.test.ts
// 端口只定义接口无实现，故用内联测试替身验证 Platform 的语义契约：
//   - fakePlatform：info() 返回固定 PlatformInfo，演示只读、进程内稳定语义。
// 这些替身仅存在于测试文件内，不进 src 生产代码。
import { describe, it, expect } from 'vitest';
import type { Platform, PlatformInfo } from './platform.js';

/** 测试替身：info() 恒返回构造时注入的固定平台信息。 */
class FakePlatform implements Platform {
  constructor(private readonly fixed: PlatformInfo) {}
  info(): PlatformInfo {
    return this.fixed;
  }
}

describe('Platform 端口语义契约 — AC-11', () => {
  it('返回值 os/arch/runtime 字段存在且 runtime === "node"', () => {
    const platform: Platform = new FakePlatform({
      os: 'linux',
      arch: 'x64',
      runtime: 'node',
    });
    const info = platform.info();
    expect(info.os).toBe('linux');
    expect(info.arch).toBe('x64');
    expect(info.runtime).toBe('node');
  });

  it('进程内稳定：多次调用 info() 返回一致结果', () => {
    const platform: Platform = new FakePlatform({
      os: 'darwin',
      arch: 'arm64',
      runtime: 'node',
    });
    const first = platform.info();
    const second = platform.info();
    expect(first).toEqual(second);
    expect(first.os).toBe(second.os);
    expect(first.arch).toBe(second.arch);
    expect(first.runtime).toBe(second.runtime);
  });

  it('PlatformInfo 字段为只读（类型层面禁止赋值）', () => {
    const platform: Platform = new FakePlatform({
      os: 'win32',
      arch: 'x64',
      runtime: 'node',
    });
    const info = platform.info();
    // @ts-expect-error os 为 readonly，禁止赋值
    info.os = 'linux';
    // @ts-expect-error arch 为 readonly，禁止赋值
    info.arch = 'arm64';
    // @ts-expect-error runtime 为 readonly，禁止赋值
    info.runtime = 'node';
  });

  it('未知环境归一为 "unknown"（OsType / ArchType 受限取值）', () => {
    const platform: Platform = new FakePlatform({
      os: 'unknown',
      arch: 'unknown',
      runtime: 'node',
    });
    const info = platform.info();
    expect(info.os).toBe('unknown');
    expect(info.arch).toBe('unknown');
    expect(info.runtime).toBe('node');
  });
});
