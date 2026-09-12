# quickstart · 快速上手（可执行）

`index.mjs` 演示 Mebular 的最小闭环：身份自举 → 写入偏好记忆 → 召回并打印。

## 运行

```bash
npm run build
node examples/quickstart/index.mjs
```

首次运行会调用 `Mebular.generateUserMasterKey()` 生成用户主密钥对，并把主私钥导出为 PKCS8 持久化到 `.data/master-key.json`；之后每次运行复用同一把主密钥，设备身份从 `.data/store.jsonl.identity.json` 恢复。生成的主私钥是信任根，**持久化与保管由调用方负责**。

数据目录可用 `MEBULAR_QUICKSTART_DIR` 覆盖，默认 `examples/quickstart/.data/`（已 gitignore）。

## 与其他示例的关系

`obsidian-vault/`、`log-journal/`、`json-memo/` 是供对应适配器导入的示例数据 + 说明，本身不是可执行脚本；本目录是唯一可直接运行的示例。
