# W7 原始证据

本目录保存 2026-11-28 在 merge `96629f12`（W7 evidence `fb2410d` + B1 修复 `a9937c3`）上重跑产生的原始 JSON/日志摘要，供 `../0.4.0-verification.md` 与 `../evidence.json` 交叉核对。文件包含 traceId、sessionId、hostInstanceId 等运行标识，不含 raw query 尾部、detail 正文、token、Authorization 或 keyRef。

| 文件 | 来源命令 | 结果 |
|---|---|---|
| `w7-local-model.json` | `MEBULAR_W7_SAMPLES=5 node tests/integration/host-e2e/w7-local-model-evidence.mjs` | 5/5 真实 Qwen3-4B 两轮命中；p50 40,544 ms / p95 46,050 ms（含冷启动） |
| `w7-host-plan.json` | `node tests/integration/host-e2e/w7-host-plan-sidecar.mjs` | 6/6；真实 sidecar 消费/拒绝合成 host plan |
| `w7-local-opencode.json` | `w7-intervention-evidence.mjs --source local --host opencode` | **16/16**；R-RSM，真实 Qwen3-4B 预取命中并注入新鲜片段 |
| `w7-host-opencode.json` | `w7-intervention-evidence.mjs --source host --host opencode` | **16/16**；RH+RS+FM，host plan 命中并注入新鲜片段（host 模型为确定性 fake） |
| `w7-openchamber-heuristic.json` | `w7-intervention-evidence.mjs --source heuristic --host openchamber` | **14/14**；OpenChamber adapter identity + heuristic + outcome |
| `w7-local-openchamber.json` | `w7-intervention-evidence.mjs --source local --host openchamber` | **16/16**；R-RSM，adapter identity（不是 Desktop UI） |
| `w7-host-openchamber.json` | `w7-intervention-evidence.mjs --source host --host openchamber` | **16/16**；RH+RS+FM，adapter identity（不是 Desktop UI） |
| `opencode-outcome.txt` | `node tests/integration/host-e2e/opencode-intervention-outcome.mjs` | 42 passed / 4 failed；失败项见验证报告 §2.3，与 B1 无关 |

复现时使用临时 home；不要把模型权重、引擎二进制或用户凭据复制进仓库。OpenChamber 证据只设置宿主显式身份（`MEBULAR_HOST_APP=openchamber`），没有启动 Desktop。
