// MCP 包对外报告的版本号唯一真源。
//
// serve.mjs 的 /healthz、/app/embed/info、runtime.json，server.mjs 的 MCP server
// 元数据，client.mjs 的 clientInfo 都从这里读取。发布脚本
// scripts/bump-version.mjs 只改这一处，scripts/verify-release-version.mjs
// 校验它等于发布版本；不要在其它文件再写版本字面量。

export const APP_VERSION = '0.2.2';
