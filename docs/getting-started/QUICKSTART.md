# Mebular Quickstart (5 minutes)

From zero to an assistant that reads and writes shared memory — then sync that memory to a second device.

Mebular is a local-first memory layer for AI assistants. One machine runs one node (the daemon), your data
stays on your devices, and every write is signed and content-addressed. No hosted service, no coordinator.

**Prerequisites:** a 64-bit macOS, Windows or Linux machine for the desktop app. The browser, CLI, agent and
source paths need Node.js >= 20; check with `node -v`.

## 1. Desktop app (recommended)

1. Download the app from [GitHub Releases](https://github.com/Windsander/Mebular/releases/tag/v0.2.2) and open it.
2. Click **Start deployment**. It starts the local service on this machine, connects the AI assistants already
   installed here, and opens the **locked main console**.
3. Choose **Create new Cloud** on your first device, or **Join existing Cloud** on a later one.

> The v0.2.2 installers are unsigned. Verify `SHA256SUMS.txt` first, then use right-click → **Open**
> on macOS or **More info → Run anyway** on Windows. The package bundles Electron and its runtime;
> no local Node.js is needed. Details: [desktop release](../operations/DESKTOP_RELEASE.md).

A **Cloud** (忆云) is one shared memory space. It is not a hosted service: its data lives on the devices that
belong to it.

- **First device** — **Create new Cloud**: enter a Cloud name and a device name. This machine becomes the root.
- **Later devices** — on a device already in the Cloud, use **Invite device** to get a QR code / one-time
  token; on the new device, **Join existing Cloud**: paste the token and enter a device name. The new device
  receives a delegated certificate; the master key is never copied.

Create and join complete in the same daemon process and on the same page: no daemon restart, no page reload.
The console unlocks as soon as initialization returns, and the top bar switches to **Invite device** + **Join
Cloud**. The app never picks or creates a Cloud for you.

The app writes the HTTP `/mcp` form into the assistants it connects, so those connections keep working after
setup — no config rewrite is needed.

On an empty home directory the console is locked: the star map is visible, the other cards are disabled, and
the top bar has the two entries above. That is expected, not a broken install.

## 2. Other ways to run it

**Browser console** — the desktop app hosts the same console; you can also serve it yourself:

```bash
npm install -g @mebular/core
mebular serve
```

Open `http://127.0.0.1:7331/console` and use the same two entries: **Create new Cloud** for the first device,
**Join existing Cloud** for later ones. Both unlock the same page without a restart.

**CLI** — three commands to start, invite and join:

```bash
fleet quickstart --daemon --dir ~/.mebular --device "$(hostname | tr '[:upper:]' '[:lower:]')"
fleet invite --dir ~/.mebular                                  # QR code + token for the new device
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-B   # or --token
```

`fleet quickstart` prepares this machine and prints a one-time invite token. `fleet quickstart` and
`mebular serve` share the same home (`~/.mebular` by default; override with `MEBULAR_HOME`). The daemon holds a
store lock — run one writer per home.

**Agent** — install the skills (memory + tasks), then say “deploy Mebular” or “join with this code”. The agent
follows [`packages/skill/SETUP.md`](../../packages/skill/SETUP.md) and self-checks with `mebular doctor --net`:

```bash
node packages/skill/scripts/install.mjs
```

**Source checkout** — for development or a pinned build.

From npm (published release):

```bash
npm install -g @mebular/core
command -v mebular && command -v fleet
```

From GitHub, pinned to a commit (reproducible):

```bash
SHA=$(git ls-remote https://github.com/Windsander/Mebular.git refs/heads/main | cut -f1)
npm i -g "github:Windsander/Mebular#$SHA"
command -v mebular && command -v fleet
```

From a local clone:

```bash
git clone https://github.com/Windsander/Mebular.git && cd Mebular
npm ci && npm run build
npm i -g .
command -v mebular && command -v fleet
```

`@mebular/core` is the root bundle and the install that provides both CLIs: `mebular` covers the daemon, MCP
server and console; `fleet` covers setup, invite and join. Installing `@mebular/mcp` alone provides only
`mebular`, not `fleet`. To install the memory / task skills from the npm tree instead of a checkout:

```bash
node "$(npm root -g)/@mebular/core/packages/skill/scripts/install.mjs"
```

## 3. Connect an MCP agent

Print a ready-to-paste MCP config for your client:

```bash
mebular print-config --client opencode   # also: claude, cursor, dsh, generic
```

Paste it into your agent's MCP configuration. The local form runs `mebular mcp` over stdio; a Streamable HTTP
client can instead point at `http://127.0.0.1:7331/mcp`. The HTTP `/mcp` form is what the desktop app writes
when it auto-connects your assistants, so the same path keeps working after setup.

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

In the GUI: console → **＋ Invite device**.

Device B — in the GUI, enter the locked console and choose **Join existing Cloud**, then paste the token and a
device name. Or use the CLI with the QR content (or `--token`):

```bash
fleet join --qr "<QR content>" --daemon --dir ~/.mebular --device device-B
```

After the join, the GUI unlocks in the same process (no restart or reload). The new device declares its own
subscription (zero friction) and a one-time sync runs. Writes on either device converge after reconnect —
offline-first, with no central service.

## 6. Verify and troubleshoot

```bash
mebular status          # identity / storage / counts / state hash
mebular doctor --net    # address book / LAN discovery / NAT / bridge role / next steps
```

| Symptom | What to do |
|---|---|
| Console is locked with only the star map | Expected before the first Cloud: use **Create new Cloud** / **Join existing Cloud** in the top bar. |
| “Start deployment” finished but there is no Cloud | Expected: it starts the daemon and connects assistants; it does not create a Cloud. Use the top bar. |
| MCP tool call returns `NOT_INITIALIZED` | No Cloud yet: create/join in the locked console. The same session recovers; no restart. |
| `MCP_STORAGE_LOCKED` | Another instance holds the store lock: reuse it, or stop it first. |
| `MCP_INSECURE_CONFIG` | Fix `~/.mebular/config.json`: set `mcp.http.host` back to `127.0.0.1`, or supply `auth` + `tls`. |
| Console API returns 401 after switching `auth` | See console → Settings → Diagnostics; `bearer` is recoverable in the UI, `oauth` needs env secrets. |
| Joined device cannot reach the peer | Run `mebular doctor --net` and follow the `next` suggestions. |

## Where to next

- **README** — [`README.md`](../../README.md) · [中文](../../README_CN.md)
- **Changelog** — [`CHANGELOG.md`](../../CHANGELOG.md)
- **Release SOP** — [`RELEASE.md`](../operations/RELEASE.md)
- **Limits & trade-offs** — [`LIMITATIONS.md`](../limitations/LIMITATIONS.md)
- **Sealing contract** — [`SEALING.md`](../../SEALING.md)
- **Two-machine ops** — [`packages/fleet/RUNBOOK.md`](../../packages/fleet/RUNBOOK.md)
- **Architecture** — [`ARCHITECT.md`](../architecture/ARCHITECT.md)
- **Runnable library example** — [`examples/quickstart`](../../examples/quickstart/index.mjs)
