// agent-runtime/domain/event/phase-changed-event.test.ts
// C2 · AgentRuntime —— phase_changed 事件（C2 核心产出）构造工厂 + type guard 测试（c2-3-4）。
// 覆盖：构造 type 为 phase_changed、字段反映迁移后相位、原样承载不改写、type guard 正确收窄。
import { describe, expect, it } from 'vitest';

import { StreamPhaseKind, TerminalSubstate } from '../stream/stream-phase.js';
import type { StreamPhase } from '../stream/stream-phase.js';
import type { AgentStreamEvent } from './agent-stream-event.js';
import { isPhaseChangedEvent, phaseChangedEvent } from './phase-changed-event.js';

describe('phaseChangedEvent 构造（C2 核心产出，c2-3-4）', () => {
  it('type 为 phase_changed', () => {
    const e = phaseChangedEvent({ kind: StreamPhaseKind.ACTIVE });
    expect(e.type).toBe('phase_changed');
  });

  it('字段反映 active 相位', () => {
    const e = phaseChangedEvent({ kind: StreamPhaseKind.ACTIVE });
    expect(e.phase.kind).toBe(StreamPhaseKind.ACTIVE);
  });

  it('字段反映 settling 相位', () => {
    const e = phaseChangedEvent({ kind: StreamPhaseKind.SETTLING });
    expect(e.phase.kind).toBe(StreamPhaseKind.SETTLING);
  });

  it('字段反映 terminal 相位并保留终结子态', () => {
    const e = phaseChangedEvent({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(e.phase.kind).toBe(StreamPhaseKind.TERMINAL);
    if (e.phase.kind === StreamPhaseKind.TERMINAL) {
      expect(e.phase.substate).toBe(TerminalSubstate.ABORTED);
    } else {
      throw new Error('phase 应为 terminal');
    }
  });

  it('原样承载传入的 phase 值对象（同一引用，不复制不改写）', () => {
    const phase: StreamPhase = { kind: StreamPhaseKind.SETTLING };
    const e = phaseChangedEvent(phase);
    expect(e.phase).toBe(phase);
  });

  it('相位变化时构造不同事件，字段各自反映其相位（模拟核心相位迁移广播）', () => {
    const settling = phaseChangedEvent({ kind: StreamPhaseKind.SETTLING });
    const terminal = phaseChangedEvent({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
    expect(settling.phase.kind).toBe(StreamPhaseKind.SETTLING);
    expect(terminal.phase.kind).toBe(StreamPhaseKind.TERMINAL);
  });
});

describe('isPhaseChangedEvent 判别收窄', () => {
  it('对 phase_changed 事件返回 true 并可安全访问 phase', () => {
    const anyEvent: AgentStreamEvent = phaseChangedEvent({ kind: StreamPhaseKind.ACTIVE });
    if (isPhaseChangedEvent(anyEvent)) {
      expect(anyEvent.phase.kind).toBe(StreamPhaseKind.ACTIVE);
    } else {
      throw new Error('guard 应收窄为 phase_changed');
    }
  });

  it('对非 phase_changed 事件返回 false', () => {
    const other: AgentStreamEvent = { type: 'text', text: 'x' };
    expect(isPhaseChangedEvent(other)).toBe(false);
  });
});
