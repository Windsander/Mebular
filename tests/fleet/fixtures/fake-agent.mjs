#!/usr/bin/env node
// 确定性 fake agent（M4 适配器测试用；不依赖真实 Hermes/CI 环境）。
//
// 解析与 hermes 兼容的参数（-p/-t/-m/-r/--in/-z/--usage-file），并支持 fixture 开关：
//   --mode echo|sleep|fail|large|args   --sleep <ms>   --exit <code>   --bytes <n>   --stderr <text>
// 行为确定性；成功时若给了 --usage-file 会写入 { session_id }。

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--') || t.startsWith('-')) {
      const key = t;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const flags = parse(process.argv.slice(2));
const mode = typeof flags['--mode'] === 'string' ? flags['--mode'] : 'echo';
const prompt = typeof flags['-z'] === 'string' ? flags['-z'] : '';
const usageFile = typeof flags['--usage-file'] === 'string' ? flags['--usage-file'] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'sleep') {
  await sleep(Number(flags['--sleep'] ?? 1000));
  process.stdout.write(`FAKE:${prompt}`);
} else if (mode === 'fail') {
  const msg = typeof flags['--stderr'] === 'string' ? flags['--stderr'] : 'fake-agent failure';
  process.stderr.write(msg);
  process.exit(Number(flags['--exit'] ?? 3));
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(Number(flags['--bytes'] ?? 10000)));
} else if (mode === 'args') {
  // 回显收到的参数（用于断言数组传参、无 shell 解释）。
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
} else if (mode === 'env') {
  // 回显某个环境变量（用于断言 env 白名单：不该看到的变量应为 MISSING）。
  const key = typeof flags['--env-key'] === 'string' ? flags['--env-key'] : 'PATH';
  process.stdout.write(`ENV:${process.env[key] ?? 'MISSING'}`);
} else {
  process.stdout.write(`FAKE:${prompt}`);
}

if (usageFile !== null && mode !== 'fail') {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(usageFile, JSON.stringify({ session_id: 'fake-session' }), 'utf-8');
}
