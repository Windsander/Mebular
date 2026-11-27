# W7 原始证据

本目录保存 2026-11-27 W7 真实运行产生的原始 JSON/日志摘要，供 `../0.4.0-verification.md` 与
`../evidence.json` 交叉核对。文件包含 traceId、sessionId、hostInstanceId 等运行标识，
不含 raw query 尾部、detail 正文、token、Authorization 或 keyRef。

| 文件 | 来源命令 | 结果 |
|---|---|---|
| `w7-local-model.json` | `MEBULAR_W7_SAMPLES=5 node tests/integration/host-e2e/w7-local-model-evidence.mjs` | 5/5 真实 Qwen3-4B 两轮命中；p50 45,471 ms / p95 45,667 ms（含冷启动） |
| `w7-host-plan.json` | `node tests/integration/host-e2e/w7-host-plan-sidecar.mjs` | 6/6；真实 sidecar 消费/拒绝合成 host plan |
| `w7-local-opencode.json` | `w7-intervention-evidence.mjs --source local --host opencode` | 14/16；local 首轮 fallback 通过，命中被 adapter dedupe 阻断 |
| `w7-host-opencode.json` | `w7-intervention-evidence.mjs --source host --host opencode` | 13/16；host 首轮 fallback 通过，命中被 adapter dedupe 阻断 |
| `w7-openchamber-heuristic.json` | `w7-intervention-evidence.mjs --source heuristic --host openchamber` | 12/12；OpenChamber adapter identity + heuristic + outcome |
| `opencode-outcome.log` | `node tests/integration/host-e2e/opencode-intervention-outcome.mjs` | 42 passed / 4 failed；失败项见验证报告 §2.3 |

复现时使用临时 home；不要把模型权重、引擎二进制或用户凭据复制进仓库。
