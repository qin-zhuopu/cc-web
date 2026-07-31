// agent-runtime/domain/stream/phase-transition.test.ts
// C2 · AgentRuntime —— phase-transition 纯函数单测（对齐 architecture §3.5 / AC-1）。
// 覆盖：canTransitionPhase 全迁移矩阵（3 起始相位 × 目标）+ reconcilePhase 各分支。

import { describe, expect, it } from 'vitest';
import { canTransitionPhase, reconcilePhase } from './phase-transition.js';
import type { StreamPhase } from './stream-phase.js';
import { StreamPhaseKind, TerminalSubstate } from './stream-phase.js';

// 相位构造夹具。terminal 取三种子态各一，确保「终态不可迁出」对每个子态都成立。
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

const allTerminals: ReadonlyArray<readonly [string, StreamPhase]> = [
  ['terminal(completed)', terminalCompleted],
  ['terminal(aborted)', terminalAborted],
  ['terminal(errored)', terminalErrored],
];

describe('canTransitionPhase —— 相位迁移全矩阵（AC-1）', () => {
  describe('合法迁移返回 true', () => {
    it('active → settling', () => {
      expect(canTransitionPhase(active, settling)).toBe(true);
    });

    it.each(allTerminals)('active → %s', (_label, to) => {
      expect(canTransitionPhase(active, to)).toBe(true);
    });

    it.each(allTerminals)('settling → %s', (_label, to) => {
      expect(canTransitionPhase(settling, to)).toBe(true);
    });
  });

  describe('非法迁移返回 false —— 不可回退到 active（任意 * → active）', () => {
    it('active → active（无自迁移）', () => {
      expect(canTransitionPhase(active, active)).toBe(false);
    });

    it('settling → active（不可回退）', () => {
      expect(canTransitionPhase(settling, active)).toBe(false);
    });

    it.each(allTerminals)('%s → active（不可回退）', (_label, from) => {
      expect(canTransitionPhase(from, active)).toBe(false);
    });
  });

  describe('非法迁移返回 false —— settling 侧其它非法', () => {
    it('settling → settling（无自迁移）', () => {
      expect(canTransitionPhase(settling, settling)).toBe(false);
    });
  });

  describe('非法迁移返回 false —— 终态不可迁出（任意 terminal → *）', () => {
    const targets: ReadonlyArray<readonly [string, StreamPhase]> = [
      ['active', active],
      ['settling', settling],
      ['terminal(completed)', terminalCompleted],
      ['terminal(aborted)', terminalAborted],
      ['terminal(errored)', terminalErrored],
    ];

    for (const [fromLabel, from] of allTerminals) {
      it.each(targets)(`${fromLabel} → %s`, (_toLabel, to) => {
        expect(canTransitionPhase(from, to)).toBe(false);
      });
    }
  });
});

describe('reconcilePhase —— 中断收敛各分支（§3.5）', () => {
  // current 相位不影响纠正目标（目标仅由 runtimeStatus 决定），此处统一取 active。
  const current = active;

  it("'running' → null（不纠正，force-abort 网兜底）", () => {
    expect(reconcilePhase('running', current)).toBeNull();
  });

  it('null（unknown）→ null（不纠正）', () => {
    expect(reconcilePhase(null, current)).toBeNull();
  });

  it("未知状态字符串 → null（不纠正）", () => {
    expect(reconcilePhase('whatever-unknown', current)).toBeNull();
  });

  it("'idle' → terminal(completed)", () => {
    expect(reconcilePhase('idle', current)).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.COMPLETED,
    });
  });

  it("'interrupted' → terminal(aborted)", () => {
    expect(reconcilePhase('interrupted', current)).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
  });

  it("'error' → terminal(errored)", () => {
    expect(reconcilePhase('error', current)).toEqual({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ERRORED,
    });
  });

  it('reconcile 结果若非 null 必为 terminal（供 isTerminal 收敛）', () => {
    for (const status of ['idle', 'interrupted', 'error']) {
      const next = reconcilePhase(status, current);
      expect(next?.kind).toBe(StreamPhaseKind.TERMINAL);
    }
  });
});
