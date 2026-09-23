# Mebular Quickstart (5 minutes)

From zero to an agent that reads and writes shared memory — then sync that memory to a second device.

Mebular is a decentralized memory network: one machine runs one node (the daemon), your data stays on your
devices, and every write is Ed25519-signed and content-addressed. No cloud, no coordinator.

**Prerequisite:** Node.js >= 20. Check with `node -v`.

## 1. Install (about a minute)

**A. From GitHub, pinned to a commit (recommended, reproducible):**

```bash
SHA=$(git ls-remote https://github.com/Windsander/Mebular.git refs/heads/main | cut -f1)
npm i -g "github:Windsander/Mebular#$SHA"
command -v mebular && command -v fleet
```

**B. From a local checkout (developers):**

```bash
git clone https://github.com/Windsander/Mebular.git && cd Mebular
npm ci && npm run build
npm i -g .
command -v mebular && command -v fleet
```

You now have two commands: `mebular` (daemon, MCP server, console) and `fleet` (setup, invite, join).

## 2. Create your identity and start the daemon

One machine = one node = one daemon. The daemon is the sole holder of identity, network and trust; agents and
the fleet CLI are local clients that share it.

```bash
mebular serve
```

Open the console at `http://127.0.0.1:7331/console`. On an empty home directory it shows the first-run page —
click **Create new Mebular** (root identity + config, then auto-restart). No CLI required.

**CLI equivalent** (scripts / bulk), which also starts the join service:

```bash
fleet quickstart --daemon --dir ~/.mebular --device "$(hostname | tr '[:upper:]' '[:lower:]')"
```

**Check it is up:**

```bash
mebular status
```

`fleet quickstart` and `mebular serve` share the same home (`~/.mebular` by default; override with `MEBULAR_HOME`).
The daemon holds a store lock — run one writer per home.

## 3. Connect an MCP agent

Print a ready-to-paste MCP config for your client:

```bash
mebular print-config --client opencode   # also: claude, cursor, dsh, generic
```

Paste it into your agent's MCP configuration. The local form runs `mebular mcp` over stdio; a Streamable HTTP
client can instead point at `http://127.0.0.1:7331/mcp`.

Optionally install the behavior skill (memory policy and workflow) into your agent's skill directory:

```bash
node packages/skill/scripts/install.mjs
```

## 4. Write and query memory

Ask your agent to remember something. It will call `memory_write`, then `memory_query` to recall it. Every write
is signed and content-addressed, so you can always tell who changed what.

The same handlers are available from the CLI (agent-neutral surface), which is handy for a smoke test:

```bash
mebular memory_write --input '{"items":[{"type":"fact","content":"Ada prefers dark mode"}]}'
mebular memory_query  --input '{"query":"dark mode"}'
mebular memory_status
```

## 5. Sync a second device

Pairing is a QR code (or token). Device A invites; device B joins. No master key is copied — the new device gets
a delegated certificate.

Device A — generate an invitation (terminal QR + text token):

```bash
fleet invite --dir ~/.mebular
```

In the GUI: console → **＋ Invite a device**.

Device B — join with the QR content (or `--token`):

```bash
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-B
```

After the join, grants apply automatically (scoped to the token's domain, 24h by default, revocable) and a
one-time sync runs. Writes on either device converge after reconnect — offline-first, with no central service.

## 6. Verify and troubleshoot

```bash
mebular status          # identity / storage / counts / state hash
mebular doctor --net    # address book / LAN discovery / NAT / bridge role / next steps
```

| Symptom | What to do |
|---|---|
| `MCP_STORAGE_LOCKED` | Another instance holds the store lock: reuse it, or stop it first. |
| `MCP_INSECURE_CONFIG` | Fix `~/.mebular/config.json`: set `mcp.http.host` back to `127.0.0.1`, or supply `auth` + `tls`. |
| Console API returns 401 after switching `auth` | See console → Settings → Diagnostics; `bearer` is recoverable in the UI, `oauth` needs env secrets. |
| Joined device cannot reach the peer | Run `mebular doctor --net` and follow the `next` suggestions. |

## Where to next

- **README** — [`README.md`](README.md) · [中文](README_CN.md)
- **Limits & trade-offs** — [`LIMITATIONS.md`](LIMITATIONS.md)
- **Sealing contract** — [`SEALING.md`](SEALING.md)
- **Two-machine ops** — [`packages/fleet/RUNBOOK.md`](packages/fleet/RUNBOOK.md)
- **Runnable library example** — [`examples/quickstart`](examples/quickstart/index.mjs)
