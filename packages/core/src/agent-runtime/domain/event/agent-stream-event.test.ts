// agent-runtime/domain/event/agent-stream-event.test.ts
// C2 · AgentRuntime —— AgentStreamEvent 14 类判别联合 + 值对象测试。
// 覆盖：14 类各构造合法字面量、type 判别收窄、usage 无值留空（不填 0，AC-9）。
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../domain/error/error-code.js';
import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import { StreamPhaseKind, TerminalSubstate } from '../stream/stream-phase.js';
import type { StreamPhase } from '../stream/stream-phase.js';
import { TerminalReasonCode } from '../stream/terminal-reason.js';
import type {
  AgentStreamEvent,
  ContextUsage,
  PermissionRequest,
  RateLimitInfo,
  TokenUsage,
  ToolResultInfo,
  ToolUseInfo,
} from './agent-stream-event.js';

describe('AgentStreamEvent 14 类判别联合', () => {
  it('14 类各构造合法字面量且 type 唯一', () => {
    const classified: ClassifiedError = {
      code: ErrorCode.ABORTED,
      messageKey: 'sk.error.aborted',
      retryable: false,
    };
    const tool: ToolUseInfo = { id: 't1', name: 'read', input: { path: '/a' } };
    const toolResult: ToolResultInfo = {
      toolUseId: 't1',
      content: 'ok',
      isError: false,
    };
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 20 };
    const ctx: ContextUsage = { usedTokens: 100, maxTokens: 200000 };
    const permission: PermissionRequest = {
      id: 'p1',
      toolName: 'bash',
      input: { cmd: 'ls' },
    };
    const rateLimit: RateLimitInfo = { retryAfterMs: 1000 };
    const phase: StreamPhase = { kind: StreamPhaseKind.ACTIVE };

    const events: AgentStreamEvent[] = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', delta: '嗯' },
      { type: 'tool_use', tool },
      { type: 'tool_result', result: toolResult },
      { type: 'tool_output', data: 'stdout' },
      { type: 'status', text: '运行中' },
      { type: 'result', tokenUsage: usage, terminalReason: TerminalReasonCode.COMPLETED },
      { type: 'error', error: classified },
      { type: 'permission_request', request: permission },
      { type: 'permission_resolved', permissionRequestId: 'p1', status: 'allow' },
      { type: 'context_usage', usage: ctx },
      { type: 'rate_limit', info: rateLimit },
      { type: 'file_changed', paths: ['/a', '/b'] },
      { type: 'phase_changed', phase },
    ];

    // 14 类，type 互不重复
    expect(events).toHaveLength(14);
    const types = new Set(events.map((e) => e.type));
    expect(types.size).toBe(14);
  });

  it('type 判别可收窄到各分支字段', () => {
    const text: AgentStreamEvent = { type: 'text', text: '全文' };
    if (text.type === 'text') {
      expect(text.text).toBe('全文');
    }

    const thinking: AgentStreamEvent = { type: 'thinking', delta: '片段' };
    if (thinking.type === 'thinking') {
      expect(thinking.delta).toBe('片段');
    }

    const toolUse: AgentStreamEvent = {
      type: 'tool_use',
      tool: { id: 'x', name: 'grep', input: { pattern: 'foo' } },
    };
    if (toolUse.type === 'tool_use') {
      expect(toolUse.tool.name).toBe('grep');
      expect(toolUse.tool.input.pattern).toBe('foo');
    }

    const toolResult: AgentStreamEvent = {
      type: 'tool_result',
      result: { toolUseId: 'x', content: 'matched', isError: false },
    };
    if (toolResult.type === 'tool_result') {
      expect(toolResult.result.toolUseId).toBe('x');
      expect(toolResult.result.isError).toBe(false);
    }

    const resolved: AgentStreamEvent = {
      type: 'permission_resolved',
      permissionRequestId: 'p9',
      status: 'deny',
    };
    if (resolved.type === 'permission_resolved') {
      expect(resolved.status).toBe('deny');
      expect(resolved.permissionRequestId).toBe('p9');
    }

    const fileChanged: AgentStreamEvent = {
      type: 'file_changed',
      paths: ['/x/y.ts'],
    };
    if (fileChanged.type === 'file_changed') {
      expect(fileChanged.paths).toEqual(['/x/y.ts']);
    }
  });

  it('phase_changed 携带 StreamPhase（C2 内部产出）', () => {
    const event: AgentStreamEvent = {
      type: 'phase_changed',
      phase: { kind: StreamPhaseKind.TERMINAL, substate: TerminalSubstate.ABORTED },
    };
    if (event.type === 'phase_changed') {
      expect(event.phase.kind).toBe(StreamPhaseKind.TERMINAL);
    }
  });

  it('error 事件携带经 SK 归一的 ClassifiedError（含 ABORTED 独立类）', () => {
    const event: AgentStreamEvent = {
      type: 'error',
      error: {
        code: ErrorCode.ABORTED,
        messageKey: 'sk.error.aborted',
        retryable: false,
      },
    };
    if (event.type === 'error') {
      expect(event.error.code).toBe(ErrorCode.ABORTED);
    }
  });
});

describe('usage 反假数据（AC-9：无值留空，不填 0）', () => {
  it('Runtime 未上报 tokenUsage 时 result.tokenUsage 省略（非 0）', () => {
    const event: AgentStreamEvent = { type: 'result' };
    if (event.type === 'result') {
      // 字段缺省而非 0——UI 据此隐藏，不显假 0
      expect(event.tokenUsage).toBeUndefined();
      expect('tokenUsage' in event && event.tokenUsage !== undefined).toBe(false);
    }
  });

  it('上报 tokenUsage 时各计数如实填写，缓存/合计字段可缺省', () => {
    const usage: TokenUsage = { inputTokens: 5, outputTokens: 7 };
    const event: AgentStreamEvent = { type: 'result', tokenUsage: usage };
    if (event.type === 'result' && event.tokenUsage) {
      expect(event.tokenUsage.inputTokens).toBe(5);
      expect(event.tokenUsage.outputTokens).toBe(7);
      expect(event.tokenUsage.cacheReadInputTokens).toBeUndefined();
      expect(event.tokenUsage.totalTokens).toBeUndefined();
    }
  });

  it('ContextUsage 有值时如实填写（无值时上层不发 context_usage 事件）', () => {
    const usage: ContextUsage = { usedTokens: 1234, maxTokens: 200000 };
    const event: AgentStreamEvent = { type: 'context_usage', usage };
    if (event.type === 'context_usage') {
      expect(event.usage.usedTokens).toBe(1234);
      expect(event.usage.maxTokens).toBe(200000);
    }
  });
});
