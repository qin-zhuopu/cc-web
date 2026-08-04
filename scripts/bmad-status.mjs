#!/usr/bin/env node
// 遍历所有 BMad 文档及其状态，输出项目进度报表。
//
// 覆盖两类产物：
//   1. 规划文档（Phase 1-3）：docs/contexts/<边界>/ 下的 4 份 BMad 文档
//      product-brief / prd / architecture / epics-stories —— 以「文件是否存在」判定完成。
//   2. 实现进度（Phase 4）：_bmad-output/implementation-artifacts/sprint-status.yaml 的
//      development_status 段 —— epic / story / retrospective 三类状态；
//      各 epic 的故事定义取自同目录 epic-*/stories.yaml。
//
// 用法：
//   node scripts/bmad-status.mjs            # 人类可读报表
//   node scripts/bmad-status.mjs --json     # 机器可读 JSON（供其他工具消费）
//   node scripts/bmad-status.mjs --stories  # 额外逐条列出每个故事及其状态
//
// 零外部依赖：sprint-status / stories 两种格式规整，手写针对性解析，不引入 yaml 库。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTEXTS_DIR = join(ROOT, 'docs', 'contexts');
const IMPL_DIR = join(ROOT, '_bmad-output', 'implementation-artifacts');
const SPRINT_STATUS = join(IMPL_DIR, 'sprint-status.yaml');

// 规划阶段的 4 类 BMad 文档（文件名 → 显示名），按 BMad 阶段顺序。
const PLANNING_DOCS = [
  ['product-brief.md', 'brief'],
  ['prd.md', 'prd'],
  ['architecture.md', 'arch'],
  ['epics-stories.md', 'epics'],
];

// 边界执行顺序（绞杀者迁移顺序），用于稳定排序；未列出的追加到末尾。
const EXEC_ORDER = ['SK', 'C7', 'C1', 'C2', 'C3', 'C8', 'C9', 'C10', 'C4', 'C6', 'C5'];

// 实现状态 → 展示符号 + 是否算「完成」。
const STATUS_ICON = {
  done: '✅',
  review: '🔍',
  'in-progress': '🚧',
  'ready-for-dev': '📝',
  backlog: '⬜',
  deferred: '⏸️',
  optional: '·',
};

const args = new Set(process.argv.slice(2));
const AS_JSON = args.has('--json');
const SHOW_STORIES = args.has('--stories');

// ── 目录名 → 边界 code（shared-kernel→SK，c2-agent-runtime→C2 …） ──
function dirToCode(dirName) {
  if (dirName === 'shared-kernel') return 'SK';
  const m = dirName.match(/^c(\d+)/i);
  return m ? `C${m[1]}` : dirName.toUpperCase();
}

function orderIndex(code) {
  const i = EXEC_ORDER.indexOf(code);
  return i === -1 ? EXEC_ORDER.length : i;
}

function countLines(path) {
  try {
    const txt = readFileSync(path, 'utf8');
    return txt.length === 0 ? 0 : txt.split('\n').length;
  } catch {
    return 0;
  }
}

// ── 1. 规划文档扫描 ──
function scanPlanning() {
  if (!existsSync(CONTEXTS_DIR)) return [];
  const dirs = readdirSync(CONTEXTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const rows = dirs.map((dir) => {
    const code = dirToCode(dir);
    const docs = PLANNING_DOCS.map(([file, label]) => {
      const path = join(CONTEXTS_DIR, dir, file);
      const exists = existsSync(path);
      return { label, exists, lines: exists ? countLines(path) : 0 };
    });
    const complete = docs.every((d) => d.exists);
    return { code, dir, docs, complete };
  });
  rows.sort((a, b) => orderIndex(a.code) - orderIndex(b.code) || a.code.localeCompare(b.code));
  return rows;
}

// ── 2. sprint-status.yaml 的 development_status 段解析 ──
// 只取 `development_status:` 之后、缩进 >= 2 空格的 `key: value` 行，跳过注释/空行。
function parseSprintStatus() {
  if (!existsSync(SPRINT_STATUS)) return null;
  const lines = readFileSync(SPRINT_STATUS, 'utf8').split('\n');
  const entries = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^development_status:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    // 遇到顶格非空行（新的顶层键）则结束该段。
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([\w-]+):\s*(\S+)\s*$/);
    if (!m) continue;
    const [, key, status] = m;
    let kind = 'story';
    if (key.startsWith('epic-') && key.endsWith('-retrospective')) kind = 'retrospective';
    else if (key.startsWith('epic-')) kind = 'epic';
    entries.push({ key, status, kind });
  }
  return entries;
}

// 从 story/epic key 推导所属边界 code：sk-1-1→SK, c2-7-1→C2, accept-1→ACCEPT, epic-c2-7→C2。
function keyToCode(key) {
  const bare = key.replace(/^epic-/, '');
  if (bare.startsWith('sk-') || bare === 'sk') return 'SK';
  const m = bare.match(/^c(\d+)-/i);
  if (m) return `C${m[1]}`;
  const g = bare.match(/^([a-z]+)-/i);
  return g ? g[1].toUpperCase() : bare.toUpperCase();
}

// 从 key 提取所属 epic 前缀：c2-7-1-... → epic-c2-7；sk-1-2-... → epic-sk-1。
function storyEpicKey(key) {
  const m = key.match(/^([a-z]+-\d+|[a-z]+)-\d+/i) || key.match(/^([a-z]+)-\d+/i);
  return m ? `epic-${m[1]}` : null;
}

// ── 3. 各 epic 的落盘情况：目录 + SPEC.md + stories.yaml 是否存在、故事数 ──
// 「上层已在 sprint-status 规划、但故事文件尚未 scaffold」本身是一个状态（scaffolded=false）。
function scanEpicScaffold() {
  const map = {}; // epicKey(epic-xxx) -> { scaffolded, hasSpec, hasStories, storyCount }
  if (!existsSync(IMPL_DIR)) return map;
  for (const d of readdirSync(IMPL_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith('epic-')) continue;
    const specPath = join(IMPL_DIR, d.name, 'SPEC.md');
    const storiesPath = join(IMPL_DIR, d.name, 'stories.yaml');
    const hasStories = existsSync(storiesPath);
    const storyCount = hasStories
      ? readFileSync(storiesPath, 'utf8').split('\n').filter((l) => /^-\s+id:/.test(l)).length
      : 0;
    map[d.name] = {
      scaffolded: true,
      hasSpec: existsSync(specPath),
      hasStories,
      storyCount,
    };
  }
  return map;
}

// ── 汇总实现状态：按边界分组，统计各状态计数 ──
function summarizeImpl(entries) {
  const groups = new Map(); // code -> { epics:[], stories:[], retros:[] }
  for (const e of entries) {
    const code = keyToCode(e.key);
    if (!groups.has(code)) groups.set(code, { code, epics: [], stories: [], retros: [] });
    const g = groups.get(code);
    if (e.kind === 'epic') g.epics.push(e);
    else if (e.kind === 'retrospective') g.retros.push(e);
    else g.stories.push(e);
  }
  const rows = [...groups.values()];
  rows.sort((a, b) => orderIndex(a.code) - orderIndex(b.code) || a.code.localeCompare(b.code));
  return rows;
}

function tally(items) {
  const t = {};
  for (const it of items) t[it.status] = (t[it.status] || 0) + 1;
  return t;
}

function fmtTally(t) {
  return Object.entries(t)
    .map(([s, n]) => `${STATUS_ICON[s] || '?'}${s}×${n}`)
    .join('  ');
}

// ── 输出 ──
function main() {
  const planning = scanPlanning();
  const entries = parseSprintStatus();
  const scaffold = scanEpicScaffold();

  // 交叉核对：sprint-status 里登记的 epic vs 磁盘上已落盘的 epic 目录。
  // 已规划（sprint-status 有该 epic）但未落盘（无 epic-*/ 目录）= 一个独立状态。
  const epicKeysInStatus = entries ? entries.filter((e) => e.kind === 'epic').map((e) => e.key) : [];
  const plannedNotScaffolded = epicKeysInStatus
    .filter((k) => !scaffold[k]?.scaffolded)
    .map((k) => {
      const e = entries.find((x) => x.key === k);
      return { key: k, status: e ? e.status : 'unknown' };
    });

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          planning,
          implementation: entries,
          implementationByContext: entries ? summarizeImpl(entries) : null,
          epicScaffold: scaffold,
          plannedNotScaffolded,
        },
        null,
        2,
      ),
    );
    return;
  }

  // ---- 规划阶段 ----
  console.log('\n═══ 规划阶段（Phase 1-3）· BMad 四文档 ═══\n');
  const head = ['边界'.padEnd(6), ...PLANNING_DOCS.map(([, l]) => l.padEnd(7)), '状态'];
  console.log('  ' + head.join(' '));
  let planDone = 0;
  for (const r of planning) {
    const cells = r.docs.map((d) => (d.exists ? `✅${String(d.lines).padStart(4)}` : '  ⬜  ').padEnd(7));
    console.log('  ' + r.code.padEnd(6) + ' ' + cells.join(' ') + ' ' + (r.complete ? '✅' : '⬜'));
    if (r.complete) planDone++;
  }
  console.log(
    `\n  小计：${planDone}/${planning.length} 边界四文档齐全（数字为文档行数）`,
  );

  // ---- 实现阶段 ----
  if (!entries) {
    console.log('\n═══ 实现阶段（Phase 4）═══\n  未找到 sprint-status.yaml，实现阶段可能尚未开始。');
    return;
  }
  console.log('\n═══ 实现阶段（Phase 4）· sprint-status.yaml ═══\n');
  const byCtx = summarizeImpl(entries);
  for (const g of byCtx) {
    const epicT = tally(g.epics);
    const storyT = tally(g.stories);
    // 该边界下有多少 epic 已在 sprint-status 登记、但磁盘上还没 scaffold。
    const notScaffolded = g.epics.filter((e) => !scaffold[e.key]?.scaffolded).length;
    const scaffoldNote = notScaffolded ? `  📂未落盘×${notScaffolded}` : '';
    console.log(
      `  ${g.code.padEnd(5)} 史诗[${fmtTally(epicT) || '—'}]  故事[${fmtTally(storyT) || '—'}]${scaffoldNote}`,
    );
    if (SHOW_STORIES) {
      for (const s of g.stories) {
        console.log(`        ${STATUS_ICON[s.status] || '?'} ${s.status.padEnd(13)} ${s.key}`);
      }
    }
  }

  // ---- 已规划但未落盘（上层规划完成，故事文件尚未 create-story scaffold） ----
  if (plannedNotScaffolded.length) {
    console.log('\n  ── 📂 已规划、待落盘（sprint-status 已登记，磁盘无 epic 目录/stories.yaml） ──');
    for (const p of plannedNotScaffolded) {
      console.log(`     ${STATUS_ICON[p.status] || '?'} ${p.key}（${p.status}）→ 用 bmad-create-story 生成故事文件`);
    }
  }

  // 全局汇总
  const allStories = entries.filter((e) => e.kind === 'story');
  const allEpics = entries.filter((e) => e.kind === 'epic');
  console.log('\n  ── 全局汇总 ──');
  console.log(`  史诗：${fmtTally(tally(allEpics))}（其中 ${plannedNotScaffolded.length} 个已规划未落盘）`);
  console.log(`  故事：${fmtTally(tally(allStories))}`);
  const totalStoriesInDirs = Object.values(scaffold).reduce((a, s) => a + s.storyCount, 0);
  console.log(
    `  对账：sprint-status 故事 ${allStories.length} 条；已落盘 epic-*/stories.yaml 定义 ${totalStoriesInDirs} 条` +
      `（差额 = 未落盘 epic 的故事，属正常）`,
  );

  // 下一步提示：第一个非终态故事
  const TERMINAL = new Set(['done', 'deferred']);
  const next = allStories.find((s) => !TERMINAL.has(s.status));
  if (next) {
    console.log(`\n  下一个待推进故事：${STATUS_ICON[next.status] || '?'} ${next.key}（${next.status}）`);
  } else {
    console.log('\n  所有故事均已 done / deferred。');
  }
  console.log('');
}

main();
