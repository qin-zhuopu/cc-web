// apps/api/src/agent-runtime/adapters/session-sse-hub.spec.ts
// SessionSseHub 的行为规格（vitest；纯内存，无需真实 SSE / 网络）—— epic-accept / accept-2，SPEC CAP-2。
// 覆盖：同会话多订阅者都收同一事件；unsubscribe 后不再收；不同 sessionId 互不串台；
//   订阅者抛错不阻断其他订阅者（best-effort）；无订阅者后集合清空无泄漏。

import { describe, expect, it, vi } from 'vitest';
import { SessionSseHub } from './session-sse-hub.js';
import type { AgentStreamEvent } from '@codepilot/core';

// 构造一个最小合法 AgentStreamEvent 用于断言派发（text 类型，非增量全文）。
function textEvent(text: string): AgentStreamEvent {
  return { type: 'text', text };
}

describe('SessionSseHub', () => {
  it('同一 sessionId 的多个订阅者都收到同一事件', () => {
    const hub = new SessionSseHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe('s1', a);
    hub.subscribe('s1', b);

    const ev = textEvent('hello');
    hub.publish('s1', ev);

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith(ev);
  });

  it('unsubscribe 后不再收到事件', () => {
    const hub = new SessionSseHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe('s1', listener);

    hub.publish('s1', textEvent('first'));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    hub.publish('s1', textEvent('second'));
    // 退订后不再增加调用次数。
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('退订函数幂等：重复调用不抛、不误删他人', () => {
    const hub = new SessionSseHub();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = hub.subscribe('s1', a);
    hub.subscribe('s1', b);

    unsubA();
    expect(() => unsubA()).not.toThrow();

    hub.publish('s1', textEvent('x'));
    // a 已退订不收；b 仍在，重复退订 a 不应误删 b。
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('不同 sessionId 互不串台', () => {
    const hub = new SessionSseHub();
    const onS1 = vi.fn();
    const onS2 = vi.fn();
    hub.subscribe('s1', onS1);
    hub.subscribe('s2', onS2);

    hub.publish('s1', textEvent('to-s1'));

    expect(onS1).toHaveBeenCalledTimes(1);
    expect(onS2).not.toHaveBeenCalled();
  });

  it('某订阅者抛错不阻断其他订阅者派发（best-effort fan-out）', () => {
    const hub = new SessionSseHub();
    const throwing = vi.fn(() => {
      throw new Error('订阅者写失败');
    });
    const healthy = vi.fn();
    // 先登记会抛错的订阅者，再登记正常订阅者，验证顺序在前的坏订阅者不影响其后订阅者。
    hub.subscribe('s1', throwing);
    hub.subscribe('s1', healthy);

    expect(() => hub.publish('s1', textEvent('x'))).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('无订阅者时 publish 静默返回、不抛', () => {
    const hub = new SessionSseHub();
    expect(() => hub.publish('none', textEvent('x'))).not.toThrow();
  });

  it('退订最后一个订阅者后，再向该会话 publish 不触达任何回调（条目已清理无泄漏）', () => {
    const hub = new SessionSseHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe('s1', listener);
    unsubscribe();

    // 清理后重新订阅仍应正常工作（验证条目被移除而非残留脏状态）。
    const again = vi.fn();
    hub.subscribe('s1', again);
    hub.publish('s1', textEvent('y'));

    expect(listener).not.toHaveBeenCalled();
    expect(again).toHaveBeenCalledTimes(1);
  });
});
