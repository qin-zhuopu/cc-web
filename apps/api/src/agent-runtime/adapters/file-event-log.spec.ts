// apps/api/src/agent-runtime/adapters/file-event-log.spec.ts
// FileEventLog 的行为规格（vitest；用 os.tmpdir() 临时目录，无需真实网络 / AI）—— epic-accept / accept-3，SPEC CAP-3。
// 覆盖：连续 append 的 seq 严格 +1；append-only 不覆盖既有行；readAfter(N) 只返 seq>N 且有序；
//   空 / 不存在日志 readAfter 返回空；坏行（脏 JSON）跳过不炸；每会话文件隔离；跨实例读末行恢复 seq。

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileEventLog } from './file-event-log.js';
import type { AgentStreamEvent } from '@codepilot/core';

// 构造一个最小合法 AgentStreamEvent（text 类型，非增量全文）。
function textEvent(text: string): AgentStreamEvent {
  return { type: 'text', text };
}

// 把 readAfter 的 AsyncIterable 收敛成数组，便于断言。
async function collect(iter: AsyncIterable<{ seq: number; event: AgentStreamEvent }>): Promise<
  Array<{ seq: number; event: AgentStreamEvent }>
> {
  const out: Array<{ seq: number; event: AgentStreamEvent }> = [];
  for await (const entry of iter) {
    out.push(entry);
  }
  return out;
}

describe('FileEventLog', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'cc-file-event-log-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('连续 append 分配的 seq 从 1 起严格 +1', async () => {
    const log = new FileEventLog(baseDir);
    const r1 = await log.append('s1', textEvent('a'));
    const r2 = await log.append('s1', textEvent('b'));
    const r3 = await log.append('s1', textEvent('c'));

    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r3.seq).toBe(3);
  });

  it('append-only：新 append 不覆盖既有行，一行一事件', async () => {
    const log = new FileEventLog(baseDir);
    await log.append('s1', textEvent('first'));
    await log.append('s1', textEvent('second'));

    const filePath = path.join(baseDir, `${encodeURIComponent('s1')}.log`);
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ seq: 1, event: { type: 'text', text: 'first' } });
    expect(JSON.parse(lines[1]!)).toEqual({ seq: 2, event: { type: 'text', text: 'second' } });
  });

  it('readAfter(N) 只返回 seq>N 的记录且有序', async () => {
    const log = new FileEventLog(baseDir);
    for (const t of ['a', 'b', 'c', 'd']) {
      await log.append('s1', textEvent(t));
    }

    const got = await collect(log.readAfter('s1', 2));
    expect(got.map((e) => e.seq)).toEqual([3, 4]);
    expect(got.map((e) => (e.event as { text: string }).text)).toEqual(['c', 'd']);
  });

  it('readAfter(0) 从头补发全部记录', async () => {
    const log = new FileEventLog(baseDir);
    await log.append('s1', textEvent('a'));
    await log.append('s1', textEvent('b'));

    const got = await collect(log.readAfter('s1', 0));
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('readAfter 超过末尾 seq 时返回空', async () => {
    const log = new FileEventLog(baseDir);
    await log.append('s1', textEvent('a'));

    const got = await collect(log.readAfter('s1', 99));
    expect(got).toEqual([]);
  });

  it('不存在的会话日志 readAfter 返回空、不抛', async () => {
    const log = new FileEventLog(baseDir);
    const got = await collect(log.readAfter('never', 0));
    expect(got).toEqual([]);
  });

  it('空日志文件 readAfter 返回空', async () => {
    const log = new FileEventLog(baseDir);
    const filePath = path.join(baseDir, `${encodeURIComponent('empty')}.log`);
    await mkdir(baseDir, { recursive: true });
    await writeFile(filePath, '', 'utf8');

    const got = await collect(log.readAfter('empty', 0));
    expect(got).toEqual([]);
  });

  it('坏行（脏 JSON / 空行 / 结构不符）跳过不炸，只返回合法记录', async () => {
    const log = new FileEventLog(baseDir);
    const filePath = path.join(baseDir, `${encodeURIComponent('dirty')}.log`);
    await mkdir(baseDir, { recursive: true });
    // 混入：合法行、脏 JSON、空行、缺 seq、缺 event、合法行。
    const content = [
      JSON.stringify({ seq: 1, event: { type: 'text', text: 'ok1' } }),
      '{ this is not valid json',
      '',
      JSON.stringify({ event: { type: 'text', text: 'no-seq' } }),
      JSON.stringify({ seq: 3 }),
      JSON.stringify({ seq: 5, event: { type: 'text', text: 'ok5' } }),
    ].join('\n');
    await writeFile(filePath, `${content}\n`, 'utf8');

    const got = await collect(log.readAfter('dirty', 0));
    expect(got.map((e) => e.seq)).toEqual([1, 5]);
  });

  it('不同 sessionId 文件隔离，seq 各自独立从 1 起', async () => {
    const log = new FileEventLog(baseDir);
    const a1 = await log.append('s1', textEvent('s1-a'));
    const b1 = await log.append('s2', textEvent('s2-a'));
    const a2 = await log.append('s1', textEvent('s1-b'));

    expect(a1.seq).toBe(1);
    expect(b1.seq).toBe(1);
    expect(a2.seq).toBe(2);

    const s1 = await collect(log.readAfter('s1', 0));
    const s2 = await collect(log.readAfter('s2', 0));
    expect(s1.map((e) => (e.event as { text: string }).text)).toEqual(['s1-a', 's1-b']);
    expect(s2.map((e) => (e.event as { text: string }).text)).toEqual(['s2-a']);
  });

  it('新实例读既有日志末行恢复最大 seq，续接 append 不回退不重复', async () => {
    const first = new FileEventLog(baseDir);
    await first.append('s1', textEvent('a'));
    await first.append('s1', textEvent('b'));

    // 模拟进程重启：新实例无内存计数，须读文件末尾恢复 seq。
    const second = new FileEventLog(baseDir);
    const next = await second.append('s1', textEvent('c'));
    expect(next.seq).toBe(3);

    const got = await collect(second.readAfter('s1', 0));
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('并发 append 经写链串行化：seq 无重复无缺口', async () => {
    const log = new FileEventLog(baseDir);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => log.append('s1', textEvent(`e${i}`))),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('含路径穿越字符的 sessionId 被安全编码，不逃逸基目录', async () => {
    const log = new FileEventLog(baseDir);
    const r = await log.append('../evil/../id', textEvent('x'));
    expect(r.seq).toBe(1);
    // 编码后仍落在基目录内单个文件，readAfter 能原样读回。
    const got = await collect(log.readAfter('../evil/../id', 0));
    expect(got.map((e) => e.seq)).toEqual([1]);
  });
});
