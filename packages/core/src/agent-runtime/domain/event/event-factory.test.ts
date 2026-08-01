// agent-runtime/domain/event/event-factory.test.ts
// C2 · AgentRuntime —— 14 类事件构造工厂 + 判别 type guard 测试（c2-3-1）。
// 覆盖：各工厂产出 type/字段正确、result 反假数据（无值不填 0，AC-9/c2-3-3）、
// phase_changed 由核心产出（c2-3-4）、type guard 正确收窄、防御性复制。
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../domain/error/error-code.js';
import type { ClassifiedError } from '../../../domain/error/classified-error.js';
import { StreamPhaseKind, TerminalSubstate } from '../stream/stream-phase.js';
import { TerminalReasonCode } from '../stream/terminal-reason.js';
import type {
  ContextUsage,
  PermissionRequest,
  RateLimitInfo,
  TokenUsage,
  ToolResultInfo,
  ToolUseInfo,
} from './agent-stream-event.js';
import {
  contextUsageEvent,
  errorEvent,
  fileChangedEvent,
  isContextUsageEvent,
  isErrorEvent,
  isFileChangedEvent,
  isPermissionRequestEvent,
  isPermissionResolvedEvent,
  isPhaseChangedEvent,
  isRateLimitEvent,
  isResultEvent,
  isStatusEvent,
  isTextEvent,
  isThinkingEvent,
  isToolOutputEvent,
  isToolResultEvent,
  isToolUseEvent,
  permissionRequestEvent,
  permissionResolvedEvent,
  phaseChangedEvent,
  rateLimitEvent,
  resultEvent,
  statusEvent,
  textEvent,
  thinkingEvent,
  toolOutputEvent,
  toolResultEvent,
  toolUseEvent,
} from './event-factory.js';

describe('构造工厂产出 type/字段正确', () => {
  it('textEvent', () => {
    const e = textEvent('全文');
    expect(e.type).toBe('text');
    expect(e.text).toBe('全文');
  });

  it('thinkingEvent', () => {
    const e = thinkingEvent('片段');
    expect(e.type).toBe('thinking');
    expect(e.delta).toBe('片段');
  });

  it('toolUseEvent', () => {
    const tool: ToolUseInfo = { id: 't1', name: 'read', input: { path: '/a' } };
    const e = toolUseEvent(tool);
    expect(e.type).toBe('tool_use');
    expect(e.tool).toBe(tool);
  });

  it('toolResultEvent', () => {
    const result: ToolResultInfo = { toolUseId: 't1', content: 'ok', isError: false };
    const e = toolResultEvent(result);
    expect(e.type).toBe('tool_result');
    expect(e.result).toBe(result);
  });

  it('toolOutputEvent', () => {
    const e = toolOutputEvent('stdout');
    expect(e.type).toBe('tool_output');
    expect(e.data).toBe('stdout');
  });

  it('statusEvent', () => {
    const e = statusEvent('运行中');
    expect(e.type).toBe('status');
    expect(e.text).toBe('运行中');
  });

  it('errorEvent', () => {
    const classified: ClassifiedError = {
      code: ErrorCode.ABORTED,
      messageKey: 'sk.error.aborted',
      retryable: false,
    };
    const e = errorEvent(classified);
    expect(e.type).toBe('error');
    expect(e.error).toBe(classified);
    expect(e.error.code).toBe(ErrorCode.ABORTED);
  });

  it('permissionRequestEvent', () => {
    const request: PermissionRequest = { id: 'p1', toolName: 'bash', input: { cmd: 'ls' } };
    const e = permissionRequestEvent(request);
    expect(e.type).toBe('permission_request');
    expect(e.request).toBe(request);
  });

  it('permissionResolvedEvent', () => {
    const e = permissionResolvedEvent('p9', 'deny');
    expect(e.type).toBe('permission_resolved');
    expect(e.permissionRequestId).toBe('p9');
    expect(e.status).toBe('deny');
  });

  it('contextUsageEvent', () => {
    const usage: ContextUsage = { usedTokens: 1234, maxTokens: 200000 };
    const e = contextUsageEvent(usage);
    expect(e.type).toBe('context_usage');
    expect(e.usage).toBe(usage);
  });

  it('rateLimitEvent', () => {
    const info: RateLimitInfo = { retryAfterMs: 1000 };
    const e = rateLimitEvent(info);
    expect(e.type).toBe('rate_limit');
    expect(e.info).toBe(info);
  });

  it('fileChangedEvent 承载路径且防御性复制不可变', () => {
    const src = ['/a', '/b'];
    const e = fileChangedEvent(src);
    expect(e.type).toBe('file_changed');
    expect(e.paths).toEqual(['/a', '/b']);
    // 防御性复制：外部改源数组不影响事件
    src.push('/c');
    expect(e.paths).toEqual(['/a', '/b']);
    // 冻结：不可变
    expect(Object.isFrozen(e.paths)).toBe(true);
  });

  it('phaseChangedEvent 由核心产出并原样承载 phase（c2-3-4）', () => {
    const e = phaseChangedEvent({
      kind: StreamPhaseKind.TERMINAL,
      substate: TerminalSubstate.ABORTED,
    });
    expect(e.type).toBe('phase_changed');
    expect(e.phase.kind).toBe(StreamPhaseKind.TERMINAL);
  });
});

describe('resultEvent 反假数据（AC-9 / c2-3-3：无值留空不填 0）', () => {
  it('无参数时 tokenUsage / terminalReason 均省略（键不存在，非 0/undefined 值）', () => {
    const e = resultEvent();
    expect(e.type).toBe('result');
    expect(e.tokenUsage).toBeUndefined();
    expect(e.terminalReason).toBeUndefined();
    // 键本身不应写入——区分「未记录」与「已知无值」
    expect('tokenUsage' in e).toBe(false);
    expect('terminalReason' in e).toBe(false);
  });

  it('传空对象时同样不写入任何键', () => {
    const e = resultEvent({});
    expect('tokenUsage' in e).toBe(false);
    expect('terminalReason' in e).toBe(false);
  });

  it('显式传 undefined 时不写入键（不产生 tokenUsage: undefined）', () => {
    const e = resultEvent({ tokenUsage: undefined, terminalReason: undefined });
    expect('tokenUsage' in e).toBe(false);
    expect('terminalReason' in e).toBe(false);
  });

  it('上报 tokenUsage / terminalReason 时如实写入', () => {
    const usage: TokenUsage = { inputTokens: 5, outputTokens: 7 };
    const e = resultEvent({ tokenUsage: usage, terminalReason: TerminalReasonCode.COMPLETED });
    expect(e.tokenUsage).toBe(usage);
    expect(e.terminalReason).toBe(TerminalReasonCode.COMPLETED);
  });

  it('仅上报 terminalReason 时 tokenUsage 仍省略', () => {
    const e = resultEvent({ terminalReason: TerminalReasonCode.USER_ABORTED });
    expect('tokenUsage' in e).toBe(false);
    expect(e.terminalReason).toBe(TerminalReasonCode.USER_ABORTED);
  });
});

describe('判别 type guard 正确收窄', () => {
  it('各 guard 对匹配事件返回 true 并收窄字段', () => {
    expect(isTextEvent(textEvent('x'))).toBe(true);
    expect(isThinkingEvent(thinkingEvent('x'))).toBe(true);
    expect(isToolUseEvent(toolUseEvent({ id: 'i', name: 'n', input: {} }))).toBe(true);
    expect(
      isToolResultEvent(toolResultEvent({ toolUseId: 'i', content: 'c', isError: false })),
    ).toBe(true);
    expect(isToolOutputEvent(toolOutputEvent('o'))).toBe(true);
    expect(isStatusEvent(statusEvent('s'))).toBe(true);
    expect(isResultEvent(resultEvent())).toBe(true);
    expect(
      isErrorEvent(
        errorEvent({ code: ErrorCode.ABORTED, messageKey: 'sk.error.aborted', retryable: false }),
      ),
    ).toBe(true);
    expect(
      isPermissionRequestEvent(permissionRequestEvent({ id: 'p', toolName: 't', input: {} })),
    ).toBe(true);
    expect(isPermissionResolvedEvent(permissionResolvedEvent('p', 'allow'))).toBe(true);
    expect(isContextUsageEvent(contextUsageEvent({ usedTokens: 1, maxTokens: 2 }))).toBe(true);
    expect(isRateLimitEvent(rateLimitEvent({}))).toBe(true);
    expect(isFileChangedEvent(fileChangedEvent(['/a']))).toBe(true);
    expect(isPhaseChangedEvent(phaseChangedEvent({ kind: StreamPhaseKind.ACTIVE }))).toBe(true);
  });

  it('guard 对非匹配事件返回 false', () => {
    expect(isTextEvent(thinkingEvent('x'))).toBe(false);
    expect(isResultEvent(textEvent('x'))).toBe(false);
    expect(isPhaseChangedEvent(statusEvent('x'))).toBe(false);
    expect(isToolUseEvent(toolResultEvent({ toolUseId: 'i', content: 'c', isError: false }))).toBe(
      false,
    );
  });

  it('guard 收窄后可安全访问分支字段', () => {
    const e = toolUseEvent({ id: 'x', name: 'grep', input: { pattern: 'foo' } });
    // 以 AgentStreamEvent 泛型形态传入，经 guard 收窄
    const anyEvent = e as import('./agent-stream-event.js').AgentStreamEvent;
    if (isToolUseEvent(anyEvent)) {
      expect(anyEvent.tool.name).toBe('grep');
      expect(anyEvent.tool.input.pattern).toBe('foo');
    } else {
      throw new Error('guard 应收窄为 tool_use');
    }
  });
});
