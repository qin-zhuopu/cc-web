// apps/api/scripts/c2-6-integration-check.mts
// c2-6 连真 litellm 代理的集成验证（人在场、手动跑，不进 npm run test 门禁）。
// 用真实 SDK query() 经 https://litellm.jereh.cn 跑一次回合，过 ClaudeSdkEventMapper 观察归一事件。
// 运行：cd apps/api && npx tsx scripts/c2-6-integration-check.mts
//
// 读 apps/api/.env 的配置注入 query() options.env（token 不回显）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, type Options, type SDKUserMessage, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkEventMapper } from '../src/agent-runtime/adapters/claude-sdk-event-mapper.ts';

// —— 读 .env（简单解析，不引依赖）——
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i)] = t.slice(i + 1);
}

const mapper = new ClaudeSdkEventMapper();

async function* prompt(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: '用一句话介绍你自己，然后停止。' },
    parent_tool_use_id: null,
  };
}

const options: Options = {
  env: { ...process.env, ...env },
  // 不强制 maxTurns，让它自然收尾；只跑一轮。
};

console.log('=== 发起真实回合（经 litellm 网关）===');
console.log('base_url:', env.ANTHROPIC_BASE_URL, '| model:', env.ANTHROPIC_MODEL, '| token: <已注入，不回显>');

const q = query({ prompt: prompt(), options });

let rawCount = 0;
const normalizedEvents: string[] = [];
try {
  for await (const message of q as AsyncIterable<SDKMessage>) {
    rawCount++;
    console.log(`\n[SDK message #${rawCount}] type=${(message as { type?: string }).type}`);
    for (const event of mapper.mapMessage(message)) {
      const summary =
        event.type === 'text'
          ? `text("${event.text.slice(0, 60)}${event.text.length > 60 ? '…' : ''}")`
          : event.type === 'thinking'
            ? `thinking("${event.delta.slice(0, 60)}${event.delta.length > 60 ? '…' : ''}")`
            : event.type === 'result'
              ? `result(tokenUsage=${JSON.stringify(event.tokenUsage ?? '省略')})`
              : event.type;
      normalizedEvents.push(event.type);
      console.log(`   → 归一事件: ${summary}`);
    }
  }
  console.log(`\n=== 完成 ===`);
  console.log(`SDK 原始消息数: ${rawCount}`);
  console.log(`归一事件类型序列: ${normalizedEvents.join(', ')}`);
  console.log(`含 text 事件: ${normalizedEvents.includes('text')}`);
  console.log(`含 thinking 事件（Kimi 思维链）: ${normalizedEvents.includes('thinking')}`);
  console.log(`含 result 事件: ${normalizedEvents.includes('result')}`);
} catch (err) {
  console.error('\n=== 回合抛错 ===');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
}
