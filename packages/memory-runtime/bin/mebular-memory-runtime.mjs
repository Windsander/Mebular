#!/usr/bin/env node
// Memory Runtime sidecar 可执行入口。
//
// 只负责把 argv 交给编译后的 `dist/sidecar/main.js`；业务与生命周期在 src/sidecar。
// 与 `mebular runtime`（MCP daemon runtime）完全分离。

import { main } from '../dist/sidecar/main.js';

const code = await main(process.argv.slice(2));
process.exitCode = code;
