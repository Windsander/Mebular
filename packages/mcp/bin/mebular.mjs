#!/usr/bin/env node
// mebular CLI（@mebular/mcp）
//
// G6.2 实现 `mcp`（stdio MCP server）；其余命令按阶段补齐（G6.3+）。

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'mcp': {
      const { startStdioServer } = await import('../src/server.mjs');
      await startStdioServer();
      return;
    }
    case '--help':
    case '-h':
    case undefined:
      console.log(
        [
          '用法：mebular <command>',
          '',
          '命令：',
          '  mcp            启动 stdio MCP server（stdio 传输）',
          '  serve          启动 Streamable HTTP server（G6.3 计划）',
          '  init           初始化 .mebular 配置（G6.4 计划）',
          '  keygen         生成用户主密钥（G6.4 计划）',
          '  print-config   打印各 client 接入片段（G6.4 计划）',
          '  status         打印记忆状态（G6.3 计划）',
          '  token          管理访问令牌（G6.3 计划）',
        ].join('\n'),
      );
      process.exit(0);
      return;
    case 'serve':
    case 'init':
    case 'keygen':
    case 'print-config':
    case 'status':
    case 'token':
      console.error(`mebular ${command}：尚未实现（按 G6 计划补齐）`);
      process.exit(2);
      return;
    default:
      console.error(`未知命令：${command ?? '(空)'}`);
      process.exit(2);
  }
}

await main();
