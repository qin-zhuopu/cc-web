// conversation/domain/session/chat-session.test.ts
// C1 会话本体实体的类型层与枚举取值断言。
// 纯类型/枚举测试，不涉及运行时逻辑（实体本身无行为）。

import { describe, expect, it } from 'vitest';
import type { ChatSession, SessionId } from './chat-session.js';
import { SessionMode, SessionSource, SessionStatus } from './chat-session.js';
import type { TitleOrigin } from './title-origin.js';

describe('会话三枚举取值（对齐 architecture §3.2）', () => {
  it('SessionStatus 取值为 active / archived', () => {
    expect(SessionStatus.ACTIVE).toBe('active');
    expect(SessionStatus.ARCHIVED).toBe('archived');
    // 恰好两枚举成员，防止误增。
    expect(Object.values(SessionStatus).sort()).toEqual(['active', 'archived']);
  });

  it('SessionMode 取值为 code / plan / ask', () => {
    expect(SessionMode.CODE).toBe('code');
    expect(SessionMode.PLAN).toBe('plan');
    expect(SessionMode.ASK).toBe('ask');
    expect(Object.values(SessionMode).sort()).toEqual(['ask', 'code', 'plan']);
  });

  it('SessionSource 取值为 user / task', () => {
    expect(SessionSource.USER).toBe('user');
    expect(SessionSource.TASK).toBe('task');
    expect(Object.values(SessionSource).sort()).toEqual(['task', 'user']);
  });
});

describe('ChatSession 类型层断言', () => {
  it('构造仅含 10 个会话本体字段的合法字面量通过', () => {
    const titleOrigin: TitleOrigin = 'default';
    const session: ChatSession = {
      id: 's-1',
      title: 'New Chat',
      titleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo/demo',
      projectName: 'demo',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };

    // SessionId 是 string 别名：可直接赋 string。
    const id: SessionId = session.id;
    expect(id).toBe('s-1');
    // 运行时抽样断言字段值正确落位。
    expect(session.status).toBe('active');
    expect(session.createdAt).toBe(session.updatedAt);
  });

  it('缺失必填字段应被类型系统拒绝', () => {
    // @ts-expect-error 缺 projectName / createdAt / updatedAt 等必填字段。
    const bad: ChatSession = {
      id: 's-2',
      title: 'x',
      titleOrigin: 'ai',
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo',
    };
    expect(bad).toBeDefined();
  });

  it('混入运行时/Provider/Codex 字段应被类型系统拒绝（字段归属铁律）', () => {
    const good = {
      id: 's-3',
      title: 'x',
      titleOrigin: 'user' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo',
      projectName: 'demo',
      createdAt: 1,
      updatedAt: 1,
    };
    // @ts-expect-error 运行时字段 sdkSessionId 不属会话本体，禁止进入 ChatSession。
    const withRuntime: ChatSession = { ...good, sdkSessionId: 'sdk-x' };
    expect(withRuntime).toBeDefined();

    // @ts-expect-error 运行时字段 runtimeStatus 不属会话本体。
    const withRuntimeStatus: ChatSession = { ...good, runtimeStatus: 'active' };
    expect(withRuntimeStatus).toBeDefined();

    // @ts-expect-error Provider 字段 providerId 属 C7 消费投影，不进 ChatSession。
    const withProvider: ChatSession = { ...good, providerId: 'p-1' };
    expect(withProvider).toBeDefined();
  });

  it('字段类型错误应被类型系统拒绝', () => {
    const base = {
      id: 's-4',
      title: 'x',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo',
      projectName: 'demo',
      updatedAt: 1,
    };
    // @ts-expect-error createdAt 必须是 number（epoch 毫秒），不接受 string。
    const bad: ChatSession = { ...base, createdAt: '2026-07-31' };
    expect(bad).toBeDefined();
  });
});
