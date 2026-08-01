// scripts/check-core-imports.mjs
// 零依赖 import 静态守卫：扫描 packages/core/src 下所有 .ts 源码，
// 命中禁用 import 或禁用运行时 API 即以非零退出码失败。
// 纳入根 `npm run test` 门禁（typecheck → 本脚本 → vitest）。
//
// 禁用清单（见 spec Design Notes / architecture.md 核心包铁律）：
//   - import 模块：@nestjs/*、better-sqlite3、@anthropic-ai/*、uuid、crypto/node:crypto、
//     child_process/node:child_process
//   - 直调运行时 API：Date.now(、randomUUID
//   - C1 专属【禁 phase 守卫】：conversation/ 子树严禁出现 C2 运行时相位概念
//     （StreamSession、.phase 成员访问、'settling'/'terminal' 相位字面量）。
//
// 纯扫描逻辑（extractModuleSpecifiers / scanContent）已 export，供
// scripts/check-core-imports.test.ts 回归测试；CLI 主流程仅在本模块
// 作为入口执行时运行（process.exit 行为不变）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/** 禁用的模块 import 规则：匹配 from '...' / import '...' / require('...') 的模块说明符。 */
export const FORBIDDEN_MODULE_RULES = [
  { name: '@nestjs/*', test: (spec) => spec === '@nestjs' || spec.startsWith('@nestjs/') },
  { name: 'better-sqlite3', test: (spec) => spec === 'better-sqlite3' },
  { name: '@anthropic-ai/*', test: (spec) => spec === '@anthropic-ai' || spec.startsWith('@anthropic-ai/') },
  { name: 'uuid', test: (spec) => spec === 'uuid' || spec.startsWith('uuid/') },
  // crypto / node:crypto：核心包禁止直接 import Node 内建随机/哈希源，
  // 随机 id 一律经 SK.IdGenerator 注入（同 randomUUID 直调禁令的 import 侧兜底）。
  { name: 'crypto', test: (spec) => spec === 'crypto' || spec === 'node:crypto' },
  // child_process / node:child_process：C2 会涉及子进程 Runtime（如 CLI/子进程执行器），
  // 但核心包严禁直接 import 子进程模块——进程编排是适配层（apps/api）职责，核心只持类型/端口。
  {
    name: 'child_process',
    test: (spec) => spec === 'child_process' || spec === 'node:child_process',
  },
];

/**
 * 【C1 禁 phase 守卫】—— 仅对 conversation/ 子树生效（见下方 isConversationFile）。
 *
 * 背景：phase / active / settling / terminal / StreamSession 属 C2 运行时实时相位概念，
 * C1 只记持久事实，严禁出现相位建模（见 CLAUDE.md「C1 专属铁律 · 禁 phase」）。
 *
 * 匹配策略与已知局限（务必按强/弱信号分层，控制误伤）：
 *   - StreamSession：强信号标识符，C2 运行时专有名，核心内无任何合法用途 → 全词匹配 \bStreamSession\b。
 *   - .phase：强信号成员访问，相位字段读写的直接形态 → 匹配 \.phase\b（成员访问，非裸词 phase，
 *     避免误伤 phaseName / multiphase 等无关标识；裸 phase 变量名极少见，本轮不扫以免过度）。
 *   - 'settling' / 'terminal'：相位字面量，仅匹配字符串字面量形态（带引号），且这两词在 C1 领域
 *     无任何合法语义（会话/消息领域不存在 settling/terminal 概念）→ 匹配 ['"]settling['"] / ['"]terminal['"]。
 *   - 'active'：【刻意不纳入】。它是 C1 SessionStatus 的合法取值（active | archived，见
 *     chat-session.ts），若禁将大面积误伤会话本体。相位语境下的 'active' 由更强的 StreamSession /
 *     .phase 信号兜底，无需再扫裸 'active'，这是精度取舍后的已知留白。
 *
 * 统一在去注释后的代码文本上匹配（复用 stripLineComment），避免中文注释里提及相位词被误报。
 */
export const FORBIDDEN_PHASE_RULES = [
  { name: 'StreamSession', pattern: /\bStreamSession\b/ },
  { name: '.phase', pattern: /\.phase\b/ },
  { name: `'settling'`, pattern: /['"]settling['"]/ },
  { name: `'terminal'`, pattern: /['"]terminal['"]/ },
];

/**
 * 判定文件是否落在 conversation/ 子树（禁 phase 规则的作用域）。
 * 入参为相对 repo 根、已归一化为 `/` 分隔的路径。
 * 用 `/conversation/` 片段匹配，确保只命中 packages/core/src/conversation/ 下文件，
 * 不波及 SK（domain/error、ports/clock 等）与 apps/api。
 */
export function isConversationFile(relPath) {
  return relPath.includes('/conversation/');
}

/**
 * 禁用的运行时 API 直调规则：源码文本命中即失败。
 * `new Date()` 仅锁「无参」形态——它等价于读系统时钟，与 Date.now()/randomUUID 同属核心内
 * 禁用的隐式时间/随机源（见 CLAUDE.md 核心包铁律「禁止直调 Date.now()/new Date()/randomUUID」）；
 * 带参的 `new Date(ts)`（由显式值构造，如格式化）合法，故 pattern 只匹配空括号，避免误伤。
 */
export const FORBIDDEN_API_RULES = [
  { name: 'Date.now(', pattern: /\bDate\.now\s*\(/ },
  { name: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { name: 'randomUUID', pattern: /\brandomUUID\b/ },
];

/** 提取一行中出现的所有模块说明符（import/export from、动态 import、require）。 */
export function extractModuleSpecifiers(line) {
  const specs = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,               // import X from '...' / export ... from '...'
    /\bimport\s*['"]([^'"]+)['"]/g,             // import '...'（副作用导入）
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,   // 动态 import('...')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,  // require('...')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(line)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

/**
 * 去掉行内 `//` 单行注释之后的内容，避免注释里提及的 API 词（如 sk-1-2
 * 分类逻辑注释中的 `Date.now()` / `randomUUID`）被误判为违规。
 * 已知局限：不处理跨行块注释 /* *\/ —— 本轮范围外，属后续 SK-4 story。
 * 简单按第一个 `//` 截断；不解析字符串字面量中的 `//`（模块 import 说明符
 * 由引号包裹、且合法 import 不含被禁 API 词，故对模块规则无影响；API 规则
 * 的目标是真实调用，出现在字符串里的概率极低，本轮接受该近似）。
 */
function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * 扫描单个文件内容，返回 violations 数组（含 module 规则、API 规则、及 conversation 专属 phase 规则命中）。
 * 每条 violation 形如 { line, rule, detail }；不含文件名（由调用方补充）。
 *
 * @param content 文件文本
 * @param options.isConversation 该文件是否落在 conversation/ 子树；
 *   为 true 时额外施加【C1 禁 phase 守卫】（FORBIDDEN_PHASE_RULES）。默认 false，
 *   确保 SK / apps 代码 0 误伤。
 */
export function scanContent(content, options = {}) {
  const { isConversation = false } = options;
  const violations = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 模块 import 规则：说明符本就在引号内，注释不影响，用原始行扫描。
    for (const spec of extractModuleSpecifiers(line)) {
      for (const rule of FORBIDDEN_MODULE_RULES) {
        if (rule.test(spec)) {
          violations.push({ line: lineNo, rule: `禁用 import: ${rule.name}`, detail: spec });
        }
      }
    }

    // API 直调规则：先去掉行内注释再匹配，避免注释误报。
    const codePart = stripLineComment(line);
    for (const rule of FORBIDDEN_API_RULES) {
      if (rule.pattern.test(codePart)) {
        violations.push({ line: lineNo, rule: `禁用运行时 API: ${rule.name}`, detail: codePart.trim() });
      }
    }

    // 【C1 禁 phase 守卫】：仅 conversation/ 子树生效，同样在去注释文本上匹配。
    if (isConversation) {
      for (const rule of FORBIDDEN_PHASE_RULES) {
        if (rule.pattern.test(codePart)) {
          violations.push({ line: lineNo, rule: `禁用 phase 标识: ${rule.name}`, detail: codePart.trim() });
        }
      }
    }
  });

  return violations;
}

/** 递归收集目录下所有 .ts 文件（含 .test.ts）。 */
export function collectTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目录不存在时视为无文件
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // 断链 / 权限错误：跳过该条目，不让门禁因无关原因崩溃
    }
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (st.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** CLI 主流程：扫描 scanRoot，打印结果并以恰当退出码结束。 */
function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, '..');
  const scanRoot = join(repoRoot, 'packages', 'core', 'src');

  const files = collectTsFiles(scanRoot);

  // 空扫描视为异常：防止 scanRoot 被改名/清空时门禁真空放行。
  if (files.length === 0) {
    console.error(
      `\n[check-core-imports] 扫描根 ${scanRoot} 未扫描到任何 .ts 文件，守卫可能失效（scanRoot 被改名/清空？）。\n`,
    );
    process.exit(1);
  }

  const violations = [];
  for (const file of files) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    const content = readFileSync(file, 'utf8');
    // conversation/ 子树额外施加【C1 禁 phase 守卫】。
    for (const v of scanContent(content, { isConversation: isConversationFile(rel) })) {
      violations.push({ file: rel, ...v });
    }
  }

  if (violations.length > 0) {
    console.error(`\n[check-core-imports] 核心包铁律违规，共 ${violations.length} 处：\n`);
    for (const v of violations) {
      console.error(`  ✗ ${v.file}:${v.line}  ${v.rule}  →  ${v.detail}`);
    }
    console.error('\npackages/core 必须零框架依赖：禁止 import @nestjs/* / better-sqlite3 / @anthropic-ai/* / uuid / crypto / child_process，禁止直调 Date.now() / randomUUID；conversation/ 子树严禁出现 C2 运行时相位标识（StreamSession / .phase / \'settling\' / \'terminal\'）。\n');
    process.exit(1);
  }

  console.log(`[check-core-imports] 通过：扫描 ${files.length} 个文件，0 命中。`);
}

// 仅当作为脚本入口执行时运行主流程；被 import（测试）时不执行。
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
