import { existsSync, readFileSync } from 'node:fs';

/**
 * 过滤第三方依赖触发的 punycode 弃用警告。
 *
 * 链路：openai@4 → node-fetch@2 → whatwg-url → tr46 → require('punycode')，
 * Node 22+ 启动时会打印 DEP0040。只忽略这一条，其它警告照常输出。
 */
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.code === 'DEP0040' || /punycode/i.test(warning?.message ?? '')) {
    return;
  }
  console.warn(warning?.stack ?? String(warning));
});

/**
 * 读取本地 `.env`（不提交到仓库），把里面的键值注入 process.env。
 *
 * config.js 里的凭证都走环境变量，这样仓库里只留占位符。
 */
function loadEnv(file = new URL('.env', import.meta.url)) {
  if (!existsSync(file)) {
    return;
  }
  const content = readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const { MiGPT } = await import('./packages/next/dist/index.js');
const { default: config } = await import('./config.js');

MiGPT.start(config).catch((error) => {
  console.error('❌ 启动失败：', error);
  process.exit(1);
});
