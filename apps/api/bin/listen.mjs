// apps/api/bin/listen.mjs
// 验收链路 · CLI 可执行入口（epic-accept / accept-8）。
//
// 运行方式（任选其一）：
//   1) node apps/api/bin/listen.mjs --new "首句"
//   2) node apps/api/bin/listen.mjs --session <id>
//   3) node apps/api/bin/listen.mjs --help
//   或在仓库根：npx tsx apps/api/src/cli/listen.ts --new "..."（不经此 shim，直跑 TS 源）。
//
// 【职责】本 shim 只做「找入口模块 → 调 main() → 设退出码」，不含任何业务逻辑 / SSE 解析。
//
// 【加载策略】优先加载【已编译】的 dist/cli/listen.js（生产/已 build 场景）；
//   若不存在（开发态、未 build），回落到用 tsx 运行 TS 源 src/cli/listen.ts。
//   两条路径都进同一个 main()，行为一致。
//
// 【安全】本 shim 绝不读 .env / 绝不打印密钥；鉴权与凭据全在 apps/api 服务端，CLI 侧零感知。
//
// 【纯 JS】本文件后缀 .mjs，Node 按【纯 JS】解析——不能含任何 TypeScript 类型注解。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'cli', 'listen.js');
const argv = process.argv.slice(2);

async function runCompiled() {
  const mod = await import(`file://${compiled}`);
  return mod.main(argv);
}

async function runViaTsx() {
  const source = join(here, '..', 'src', 'cli', 'listen.ts');
  const { spawnSync } = await import('node:child_process');
  // 用 tsx 直接跑 TS 源（仓库根 devDependency 已装 tsx）。
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', source, ...argv],
    { stdio: 'inherit' },
  );
  if (result.error !== undefined) throw result.error;
  return result.status ?? 0;
}

try {
  const code = existsSync(compiled) ? await runCompiled() : await runViaTsx();
  process.exit(code);
} catch (e) {
  process.stderr.write(`[CLI] 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
