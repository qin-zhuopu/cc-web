// apps/api/src/agent-runtime/adapters/stub-provider-repository.spec.ts
// accept-1 · StubProviderRepository 单测（SPEC CAP-1 success）——断言只读视图形状/协议正确、
// protocol→RuntimeKind.CLAUDE_SDK 映射（经核心纯映射 resolveRuntimeKind）、源码无密钥字面量。
//
// 纯单测：不接网络、不读真 .env；hasCredentials / model 由构造注入以隔离环境。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { RuntimeKind, resolveRuntimeKind } from '@codepilot/core';
import { StubProviderRepository, DEFAULT_STUB_MODEL } from './stub-provider-repository.js';

describe('StubProviderRepository', () => {
  it('resolve 恒返回单个 anthropic 协议的只读视图（忽略 providerId）', async () => {
    const repo = new StubProviderRepository(true, 'Jereh-Kimi-K2.6');
    const a = await repo.resolve('any-provider-id');
    const b = await repo.resolve('another-id');

    expect(a.protocol).toBe('anthropic');
    expect(a.authStyle).toBe('auth_token');
    expect(a.source).toBe('env');
    // 忽略 providerId：不同入参解析为同一 protocol 视图
    expect(b.protocol).toBe(a.protocol);
  });

  it('protocol=anthropic 经核心 resolveRuntimeKind 映射到 RuntimeKind.CLAUDE_SDK', async () => {
    const repo = new StubProviderRepository(true);
    const view = await repo.resolve('x');
    expect(resolveRuntimeKind(view)).toBe(RuntimeKind.CLAUDE_SDK);
  });

  it('model 从构造注入透传；未注入则回退 DEFAULT_STUB_MODEL（对齐 litellm 网关模型）', async () => {
    const injected = new StubProviderRepository(true, 'some-custom-model');
    expect((await injected.resolve('x')).model).toBe('some-custom-model');

    const fallback = new StubProviderRepository(true);
    expect((await fallback.resolve('x')).model).toBe(DEFAULT_STUB_MODEL);
    expect(DEFAULT_STUB_MODEL).toBe('Jereh-Kimi-K2.6');

    // 空串视为未定，回退默认
    const emptyModel = new StubProviderRepository(true, '');
    expect((await emptyModel.resolve('x')).model).toBe(DEFAULT_STUB_MODEL);
  });

  it('hasCredentials 反映构造注入的真实凭据存在性（反假数据）', async () => {
    expect((await new StubProviderRepository(true).resolve('x')).hasCredentials).toBe(true);
    expect((await new StubProviderRepository(false).resolve('x')).hasCredentials).toBe(false);
  });

  it('只读：不暴露任何写方法', () => {
    const repo = new StubProviderRepository(true) as unknown as Record<string, unknown>;
    for (const writeName of ['save', 'delete', 'setDefault', 'create', 'update', 'write']) {
      expect(typeof repo[writeName]).not.toBe('function');
    }
  });

  it('源码不含任何密钥字面量（无 sk- 开头 token）', () => {
    const srcPath = fileURLToPath(new URL('./stub-provider-repository.ts', import.meta.url));
    const src = readFileSync(srcPath, 'utf8');
    // 绝不硬编码 litellm 令牌：不出现 sk- 开头的密钥字面量
    expect(src).not.toMatch(/\bsk-[A-Za-z0-9_-]+/);
    // 凭据存在性来自构造注入（接线层据 env 归约），非源码常量
    expect(src).toContain('hasCredentials');
  });
});
