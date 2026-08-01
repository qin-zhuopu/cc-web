// agent-runtime/usecases/stream-session-registry.test.ts
// C2 · AgentRuntime —— StreamSessionRegistry 内存注册表单测（对齐 SPEC CAP-1 / AC-15，故事 c2-4-1）。
// 覆盖：register 后 get 取得、getActiveBySession 只回 active 回合（terminal 的不回）、
// delete 后 get 为 undefined。纯内存索引，无落库、无 Clock 依赖（活跃判断经实时 phase）。

import { describe, it, expect } from 'vitest';
import type { Clock } from '../../ports/clock.js';
import type { ClassifiedError } from '../../domain/error/classified-error.js';
import { ErrorCode } from '../../domain/error/error-code.js';
import { StreamSession, type StreamSessionInit } from '../domain/stream/stream-session.js';
import { StreamPhaseKind, isActive } from '../domain/stream/stream-phase.js';
import { RuntimeKind } from '../domain/runtime/runtime-kind.js';
import { StreamSessionRegistry } from './stream-session-registry.js';

/** FrozenClock —— 恒返回注入固定时刻的假 Clock（确定性测试）。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

/** 归 ABORTED 的分类结果替身（供 session.abort 翻终态）。 */
const ABORTED_ERROR: ClassifiedError = {
  code: ErrorCode.ABORTED,
  messageKey: 'sk.error.aborted',
  retryable: false,
};

function makeSession(init: Partial<StreamSessionInit> = {}): StreamSession {
  const full: StreamSessionInit = {
    id: init.id ?? 'stream-1',
    sessionId: init.sessionId ?? 'c1-session-1',
    runtimeKind: init.runtimeKind ?? RuntimeKind.CLAUDE_SDK,
  };
  return new StreamSession(full, new FrozenClock(1_000));
}

describe('StreamSessionRegistry 内存注册表（c2-4-1）', () => {
  it('register 后 get 能按 streamId 取回同一 StreamSession', () => {
    const registry = new StreamSessionRegistry();
    const session = makeSession({ id: 'stream-A' });

    registry.register(session);

    expect(registry.get('stream-A')).toBe(session);
  });

  it('未登记的 streamId：get 返回 undefined', () => {
    const registry = new StreamSessionRegistry();
    expect(registry.get('never-registered')).toBeUndefined();
  });

  it('getActiveBySession 返回该 C1 会话当前 active 的回合', () => {
    const registry = new StreamSessionRegistry();
    const session = makeSession({ id: 'stream-A', sessionId: 'c1-1' });
    registry.register(session);

    const found = registry.getActiveBySession('c1-1');
    expect(found).toBe(session);
    expect(isActive(found!.snapshot().phase)).toBe(true);
  });

  it('getActiveBySession 只回 active 回合：terminal(aborted) 的回合不返回', () => {
    const registry = new StreamSessionRegistry();
    const session = makeSession({ id: 'stream-A', sessionId: 'c1-1' });
    registry.register(session);

    // 翻终态后不再 active——即便仍留在 Map（get 仍可取），getActiveBySession 也不回。
    session.abort(ABORTED_ERROR);
    expect(session.snapshot().phase).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: 'aborted',
    });

    expect(registry.getActiveBySession('c1-1')).toBeUndefined();
    // 但 get 仍能按 id 取回（terminal 回合未被 delete 前仍在索引内）。
    expect(registry.get('stream-A')).toBe(session);
  });

  it('getActiveBySession 按 sessionId 隔离：只回本会话的 active 回合', () => {
    const registry = new StreamSessionRegistry();
    const s1 = makeSession({ id: 'stream-A', sessionId: 'c1-1' });
    const s2 = makeSession({ id: 'stream-B', sessionId: 'c1-2' });
    registry.register(s1);
    registry.register(s2);

    expect(registry.getActiveBySession('c1-1')).toBe(s1);
    expect(registry.getActiveBySession('c1-2')).toBe(s2);
    expect(registry.getActiveBySession('c1-3')).toBeUndefined();
  });

  it('delete 后 get 返回 undefined', () => {
    const registry = new StreamSessionRegistry();
    const session = makeSession({ id: 'stream-A' });
    registry.register(session);
    expect(registry.get('stream-A')).toBe(session);

    registry.delete('stream-A');
    expect(registry.get('stream-A')).toBeUndefined();
  });

  it('delete 不存在的 streamId：静默 no-op（不抛）', () => {
    const registry = new StreamSessionRegistry();
    expect(() => registry.delete('nope')).not.toThrow();
  });
});
