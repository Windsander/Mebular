// 统一家目录（唯一真源，F-INST-1）
//
// `MEBULAR_HOME` 覆盖，缺省 `~/.mebular`。CLI（bin/mebular.mjs）与配置解析
// （src/config.mjs）**必须共用本模块**，避免「bin 用 <cwd>/.mebular、config 用
// ~/.mebular」的分裂（会导致 store lock 与 service.heartbeat 各写一边）。
//
// 本模块刻意不引入任何重依赖（不 import @mebular/core），以便 bin 在任意
// 子命令（含 --version）下都能轻量加载。

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 统一家目录：`MEBULAR_HOME` 覆盖，缺省 `~/.mebular`。 */
export function homeDir() {
  return process.env.MEBULAR_HOME ?? join(homedir(), '.mebular');
}
