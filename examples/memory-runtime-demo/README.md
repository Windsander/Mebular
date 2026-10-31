# Memory Runtime demo

[中文](README_CN.md) · [Memory Runtime guide](../../docs/guides/MEMORY_RUNTIME.md)

A runnable, end-to-end demo of the 0.3 Memory Runtime sidecar. It uses the **real**
Mebular app, the **real** `startHttpServer` (including the internal Memory Capability
API), and the **real** supervisor that spawns `mebular-memory-runtime`. It does not
mock the graph, the capability API or the sidecar.

```bash
npm run build
node examples/memory-runtime-demo/index.mjs
```

The demo creates a temporary Mebular home and deletes it at the end. Use `--home` to
keep and reuse one:

```bash
node examples/memory-runtime-demo/index.mjs --home /tmp/mebular-memory-demo
```

## What it shows

1. **Ingest a user preference** with `extractor=heuristic`: “我喜欢深色主题，默认用中文回答。”
   The deterministic rules write a `preference` into the `user` domain.
2. **Ingest a project fact** with `extractor=host` candidates: `mebular / port / 7331`.
   This is host-provided structured data, not a model call.
3. **Broad recall** (“你还记得我的偏好吗？”) returns only the gist for the matching
   fragment. The demo asserts that no `detail` is attached.
4. **Specific recall** (`7331`) expands the fact detail and asserts the original value
   `7331` is present. The detail is a domain-shared record in the graph; local staging is
   not the authoritative copy.
5. **`/context`** assembles a request-ready block inside `maxBytes=2048` /
   `tokenBudget=500`, marked `trust=untrusted` and `purpose=background`.
6. **Checkpoint** writes `task:<threadId>` through capability and reads it back from
   the sidecar, showing `source=cloud` and the same revision.

The demo prints only a short Chinese summary (the product UI and guide are Chinese);
code and comments are in English.

## Requirements and boundaries

- Node.js 20 or newer and a built repository (`npm run build`). The demo imports
  `dist/` and `packages/mcp/src`, not TypeScript sources.
- The repository must contain `packages/memory-runtime/dist`. If not, run the build
  first; the demo fails with a clear error instead of silently skipping the sidecar.
- It forces `MEBULAR_MEMORY_RUNTIME_BIN` to the repository sidecar unless you already
  set that variable.
- **No external network, no model download, no model call.** Only `heuristic` plus
  host candidates; the sidecar status must report `heuristic`.
- Temporary home only; it never reads or writes your real `~/.mebular`.
- It stops the sidecar and MCP server before deleting the temporary home. With
  `--home`, the home is kept for inspection/reuse.

## Output shape

```text
[Mebular Memory Runtime Demo]
home: /tmp/...（临时，结束删除）
MCP daemon: http://127.0.0.1:<port>
Memory Runtime sidecar: http://127.0.0.1:<port>/memory-runtime/v1
sidecar 状态: ready · 模型来源: heuristic

[1/6] ingest 用户偏好（heuristic）
[2/6] ingest 项目事实（host candidates；不调用模型）
[3/6] 宽泛 recall：...（只给 gist）
[4/6] 具体问题：查询精确端口 7331（detail 展开）
[5/6] /context 预算块（blocks / bytes / tokens）
[6/6] checkpoint 写入/读取（revision / summary）
```

If a step fails, the script prints `演示失败：...` with the failing request and exits
non-zero. It does not swallow a missing sidecar, a missing record or a detail mismatch.

## Related

- [Memory Runtime guide](../../docs/guides/MEMORY_RUNTIME.md)
- [0.3.0 acceptance report](../../docs/quality/0.3.0-memory-runtime-acceptance.md)
- [Three-host E2E](../../tests/integration/host-e2e/README.md)
