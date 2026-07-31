// agent-runtime/domain/stream/stream-phase.test.ts
import { describe, it, expect } from 'vitest';
import {
  StreamPhaseKind,
  TerminalSubstate,
  isActive,
  isTerminal,
  type StreamPhase,
  type StreamSessionId,
} from './stream-phase.js';

describe('StreamPhase 相位类型与判定', () => {
  const active: StreamPhase = { kind: StreamPhaseKind.ACTIVE };
  const settling: StreamPhase = { kind: StreamPhaseKind.SETTLING };
  const terminalCompleted: StreamPhase = {
    kind: StreamPhaseKind.TERMINAL,
    substate: TerminalSubstate.COMPLETED,
  };
  const terminalAborted: StreamPhase = {
    kind: StreamPhaseKind.TERMINAL,
    substate: TerminalSubstate.ABORTED,
  };
  const terminalErrored: StreamPhase = {
    kind: StreamPhaseKind.TERMINAL,
    substate: TerminalSubstate.ERRORED,
  };

  describe('构造各相位', () => {
    it('active / settling 无子态', () => {
      expect(active.kind).toBe(StreamPhaseKind.ACTIVE);
      expect(settling.kind).toBe(StreamPhaseKind.SETTLING);
    });

    it('terminal 带三种子态', () => {
      expect(terminalCompleted.substate).toBe(TerminalSubstate.COMPLETED);
      expect(terminalAborted.substate).toBe(TerminalSubstate.ABORTED);
      expect(terminalErrored.substate).toBe(TerminalSubstate.ERRORED);
    });

    it('枚举字面量值对齐 architecture §3.1', () => {
      expect(StreamPhaseKind.ACTIVE).toBe('active');
      expect(StreamPhaseKind.SETTLING).toBe('settling');
      expect(StreamPhaseKind.TERMINAL).toBe('terminal');
      expect(TerminalSubstate.COMPLETED).toBe('completed');
      expect(TerminalSubstate.ABORTED).toBe('aborted');
      expect(TerminalSubstate.ERRORED).toBe('errored');
    });
  });

  describe('isActive', () => {
    it('仅 active 为真', () => {
      expect(isActive(active)).toBe(true);
      expect(isActive(settling)).toBe(false);
      expect(isActive(terminalCompleted)).toBe(false);
      expect(isActive(terminalAborted)).toBe(false);
      expect(isActive(terminalErrored)).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('三种 terminal 子态均为真，active/settling 为假', () => {
      expect(isTerminal(terminalCompleted)).toBe(true);
      expect(isTerminal(terminalAborted)).toBe(true);
      expect(isTerminal(terminalErrored)).toBe(true);
      expect(isTerminal(active)).toBe(false);
      expect(isTerminal(settling)).toBe(false);
    });
  });

  describe('terminal 类型收窄', () => {
    it('isTerminal 为真的分支可安全访问 substate', () => {
      const phase: StreamPhase = terminalAborted;
      if (phase.kind === StreamPhaseKind.TERMINAL) {
        // 类型收窄后 substate 可直接访问，无需断言。
        expect(phase.substate).toBe(TerminalSubstate.ABORTED);
      } else {
        // 不应到达此分支。
        expect.unreachable('terminalAborted 应被收窄为 TERMINAL 分支');
      }
    });

    it('active/settling 分支不含 substate 字段', () => {
      const phase: StreamPhase = active;
      // 通过 kind 判别后收窄；此处仅断言运行期形状无 substate。
      expect('substate' in phase).toBe(false);
    });
  });

  describe('StreamSessionId 值对象', () => {
    it('以 string 别名建模，可承载回合标识', () => {
      const id: StreamSessionId = 'stream-session-1';
      expect(id).toBe('stream-session-1');
    });
  });
});
