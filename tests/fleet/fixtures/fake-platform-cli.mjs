#!/usr/bin/env node
// 确定性 fake 平台 CLI（dsh/opencode/claude-code 适配器测试用）。
//
// 通过 `process.execPath <fixture> [flags]` 调用，不依赖 shebang/可执行位。
// 支持：
//   --version                     打印 fake-platform-cli 版本
//   --mode args|fail|sleep        参数回显 / 非 0 退出 / 长跑
//   --exit <code> --stderr <text> --sleep <ms>
// 默认：读取 stdin 并回显 `IN:<stdin>`（覆盖 DSH 默认 stdin 模式）。

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[token] = true;
      else {
        out[token] = next;
        i++;
      }
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const flags = parse(argv);
const mode = typeof flags['--mode'] === 'string' ? flags['--mode'] : 'stdin';

if (argv.includes('--version')) {
  process.stdout.write('fake-platform-cli 1.0.0\n');
} else if (mode === 'args') {
  process.stdout.write(JSON.stringify(argv));
} else if (mode === 'fail') {
  process.stderr.write(typeof flags['--stderr'] === 'string' ? flags['--stderr'] : 'fake-platform-cli failure');
  process.exit(Number(flags['--exit'] ?? 3));
} else if (mode === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, Number(flags['--sleep'] ?? 1000)));
  process.stdout.write('SLEPT');
} else {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    process.stdout.write(`IN:${data}`);
  });
}
