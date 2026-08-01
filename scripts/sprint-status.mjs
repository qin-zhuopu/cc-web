#!/usr/bin/env node
// sprint-status.mjs — 解析 sprint-status.yaml，输出可读进度报告
// 用法: node scripts/sprint-status.mjs [path/to/sprint-status.yaml]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STATUS_ICON = {
  done: '✅',
  'in-progress': '🔄',
  review: '👀',
  'ready-for-dev': '📦',
  backlog: '⬜',
  deferred: '⏸️',
  optional: '🔘',
};

const STATUS_COLOR = {
  done: '\x1b[32m',
  'in-progress': '\x1b[33m',
  review: '\x1b[36m',
  'ready-for-dev': '\x1b[34m',
  backlog: '\x1b[90m',
  deferred: '\x1b[35m',
  optional: '\x1b[90m',
  reset: '\x1b[0m',
};

function color(status, text) {
  const c = STATUS_COLOR[status] || '';
  const r = STATUS_COLOR.reset;
  return `${c}${text}${r}`;
}

function parseSprintYaml(text) {
  const lines = text.split(/\r?\n/);
  const epics = [];
  let currentEpic = null;
  let inDevStatus = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // 跳过空行和纯注释行，但保留注释中的分组标题
    if (!inDevStatus) {
      if (/^development_status\s*:/.test(line)) inDevStatus = true;
      continue;
    }

    // 分组标题注释：# ===================== SK · ... =====================
    const groupMatch = line.match(/#\s*=+\s*(.+?)\s*=/);
    if (groupMatch) {
      if (currentEpic) epics.push(currentEpic);
      currentEpic = null; // 分组标题不创建 epic，只作为视觉分隔
      continue;
    }

    if (line.startsWith('#') || line === '') continue;

    const match = line.match(/^(\s*)([\w-]+)\s*:\s*(.+)$/);
    if (!match) continue;

    const indent = match[1].length;
    const key = match[2];
    const value = match[3].trim();

    if (key.startsWith('epic-')) {
      if (currentEpic) epics.push(currentEpic);
      currentEpic = {
        id: key,
        status: value,
        stories: [],
        group: inferGroup(key),
      };
    } else if (currentEpic && indent >= 2) {
      currentEpic.stories.push({ id: key, status: value });
    }
  }

  if (currentEpic) epics.push(currentEpic);
  return epics;
}

function inferGroup(epicId) {
  if (epicId.startsWith('epic-sk-')) return 'SK · Shared Kernel';
  if (epicId.startsWith('epic-c1-')) return 'C1 · Conversation';
  if (epicId.startsWith('epic-c2-')) return 'C2 · AgentRuntime';
  if (epicId.startsWith('epic-accept')) return 'Accept · 验收链路';
  return 'Other';
}

function report(epics) {
  const groups = {};
  for (const epic of epics) {
    if (!groups[epic.group]) groups[epic.group] = [];
    groups[epic.group].push(epic);
  }

  let totalStories = 0;
  let doneStories = 0;
  const isDone = s => s === 'done' || s === 'review';
  const isNotStarted = s => s === 'backlog';

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Sprint 进度报告');
  console.log(`${'='.repeat(60)}\n`);

  for (const [groupName, groupEpics] of Object.entries(groups)) {
    console.log(`\n📦 ${groupName}`);
    console.log('-'.repeat(50));

    for (const epic of groupEpics) {
      const epicIcon = STATUS_ICON[epic.status] || '❓';
      // 过滤掉 retrospective（不叫 story，且状态多为 optional）
      const realStories = epic.stories.filter(s => !s.id.endsWith('-retrospective'));
      const epicDone = isDone(epic.status);
      const epicBacklog = isNotStarted(epic.status);
      const total = realStories.length;
      const completed = realStories.filter(s => isDone(s.status)).length;
      const backlogCount = realStories.filter(s => isNotStarted(s.status)).length;
      const deferredCount = realStories.filter(s => s.status === 'deferred').length;

      totalStories += total;
      doneStories += completed;

      const progressBar = makeBar(completed, total, 20);
      const epicLabel = epic.id.replace('epic-', '');
      console.log(`\n  ${epicIcon} ${epicLabel}  ${color(epic.status, `(${epic.status})`)}`);

      if (total > 0) {
        console.log(`      进度: ${progressBar}  ${completed}/${total}`);
        if (backlogCount > 0) console.log(`      🔴 backlog: ${backlogCount}`);
        if (deferredCount > 0) console.log(`      ⏸️ deferred: ${deferredCount}`);

        for (const story of realStories) {
          const icon = STATUS_ICON[story.status] || '❓';
          const pad = '          ';
          console.log(`${pad}${icon} ${story.id.padEnd(42)} ${color(story.status, story.status)}`);
        }
      } else {
        console.log(`      (无故事)`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  汇总');
  console.log('-'.repeat(50));
  const overallBar = makeBar(doneStories, totalStories, 30);
  console.log(`  全局进度: ${overallBar}  ${doneStories}/${totalStories}`);
  console.log(`  完成度: ${totalStories ? ((doneStories / totalStories) * 100).toFixed(1) : 0}%`);

  // Epic 级统计
  const totalEpics = epics.filter(e => !e.id.includes('-retrospective')).length;
  const doneEpics = epics.filter(e => isDone(e.status) && !e.id.includes('-retrospective')).length;
  console.log(`  Epic 完成: ${doneEpics}/${totalEpics}`);

  // 未开始的 backlog
  const backlogStories = epics
    .flatMap(e => e.stories)
    .filter(s => s.status === 'backlog' && !s.id.endsWith('-retrospective')).length;
  const deferredStories = epics
    .flatMap(e => e.stories)
    .filter(s => s.status === 'deferred' && !s.id.endsWith('-retrospective')).length;
  console.log(`  待启动(backlog): ${backlogStories} 个故事`);
  console.log(`  已延后(deferred): ${deferredStories} 个故事`);

  // 下一批建议
  showNextActions(epics);

  console.log(`${'='.repeat(60)}\n`);
}

function makeBar(done, total, width) {
  if (total === 0) return `[${'-'.repeat(width)}]`;
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'-'.repeat(empty)}]`;
}

function showNextActions(epics) {
  console.log('\n  🎯 建议下一步:');
  console.log('  -'.repeat(25));

  // 找第一个 backlog 的 epic
  const backlogEpic = epics.find(e => e.status === 'backlog' && !e.id.includes('-retrospective'));
  if (backlogEpic) {
    const nextStory = backlogEpic.stories.find(s => s.status === 'backlog');
    if (nextStory) {
      console.log(`  • 下一个待开工 Epic: ${backlogEpic.id.replace('epic-', '')}`);
      console.log(`    入口故事: ${nextStory.id}`);
    }
  }

  // 找 review 中的
  const reviewStories = epics
    .flatMap(e => e.stories)
    .filter(s => s.status === 'review');
  if (reviewStories.length > 0) {
    console.log(`  • review 中待收尾: ${reviewStories.length} 个 (${reviewStories.map(s => s.id).join(', ')})`);
  }

  // 找 in-progress
  const wipStories = epics
    .flatMap(e => e.stories)
    .filter(s => s.status === 'in-progress');
  if (wipStories.length > 0) {
    console.log(`  • 进行中: ${wipStories.length} 个`);
  }
}

function main() {
  const pathArg = process.argv[2];
  const file = pathArg
    ? resolve(pathArg)
    : resolve('_bmad-output/implementation-artifacts/sprint-status.yaml');

  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (e) {
    console.error(`❌ 无法读取文件: ${file}`);
    console.error('用法: node scripts/sprint-status.mjs [path/to/sprint-status.yaml]');
    process.exit(1);
  }

  const epics = parseSprintYaml(text);
  report(epics);
}

main();
