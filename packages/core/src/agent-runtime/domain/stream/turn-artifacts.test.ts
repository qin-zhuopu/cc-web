// agent-runtime/domain/stream/turn-artifacts.test.ts
// C2 · AgentRuntime —— buildFinalContent 五路投影 + 空回合返回 null 单测。
// 对齐 architecture §3.4、PRD FR-2.6，覆盖 architecture §10 测试策略中的
// buildFinalContent 断言：text-only / thinking-only / tool-only / mixed / orphan-result 五种 + 全空 null。

import { describe, it, expect } from 'vitest';
import { buildFinalContent, type TurnArtifacts } from './turn-artifacts.js';
import type { ToolUseInfo, ToolResultInfo } from '../event/agent-stream-event.js';

const emptyArtifacts: TurnArtifacts = {
  text: '',
  thinking: '',
  toolUses: [],
  toolResults: [],
};

const toolUse: ToolUseInfo = {
  id: 'tu-1',
  name: 'read_file',
  input: { path: '/a.ts' },
};

const toolResult: ToolResultInfo = {
  toolUseId: 'tu-1',
  content: 'file contents',
  isError: false,
};

const orphanResult: ToolResultInfo = {
  toolUseId: 'tu-missing',
  content: 'orphan output',
  isError: true,
};

describe('buildFinalContent 五路投影', () => {
  it('路 1：纯文本回合 → 直接返回文本原文（不 JSON 化）', () => {
    const artifacts: TurnArtifacts = { ...emptyArtifacts, text: '你好世界' };
    expect(buildFinalContent(artifacts)).toBe('你好世界');
  });

  it('路 2：thinking-only 回合 → 组装 blocks[] 序列化', () => {
    const artifacts: TurnArtifacts = { ...emptyArtifacts, thinking: '让我想想' };
    const result = buildFinalContent(artifacts);
    expect(result).not.toBeNull();
    const blocks = JSON.parse(result as string);
    expect(blocks).toEqual([{ type: 'thinking', thinking: '让我想想' }]);
  });

  it('路 3：tool-only 回合 → tool_use 块序列化', () => {
    const artifacts: TurnArtifacts = { ...emptyArtifacts, toolUses: [toolUse] };
    const result = buildFinalContent(artifacts);
    expect(result).not.toBeNull();
    const blocks = JSON.parse(result as string);
    expect(blocks).toEqual([
      { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: '/a.ts' } },
    ]);
  });

  it('路 4：混合回合 → 有序 blocks[]（text → thinking → tool_use* → tool_result*）', () => {
    const artifacts: TurnArtifacts = {
      text: '正文',
      thinking: '思考',
      toolUses: [toolUse],
      toolResults: [toolResult],
    };
    const result = buildFinalContent(artifacts);
    expect(result).not.toBeNull();
    const blocks = JSON.parse(result as string);
    expect(blocks).toEqual([
      { type: 'text', text: '正文' },
      { type: 'thinking', thinking: '思考' },
      { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: '/a.ts' } },
      { type: 'tool_result', toolUseId: 'tu-1', content: 'file contents', isError: false },
    ]);
  });

  it('路 5：孤儿 tool_result（无匹配 tool_use）仍作为独立块保留', () => {
    const artifacts: TurnArtifacts = { ...emptyArtifacts, toolResults: [orphanResult] };
    const result = buildFinalContent(artifacts);
    expect(result).not.toBeNull();
    const blocks = JSON.parse(result as string);
    expect(blocks).toEqual([
      { type: 'tool_result', toolUseId: 'tu-missing', content: 'orphan output', isError: true },
    ]);
  });

  it('全空回合 → 返回 null（空回合不落库，FR-2.6）', () => {
    expect(buildFinalContent(emptyArtifacts)).toBeNull();
  });
});
