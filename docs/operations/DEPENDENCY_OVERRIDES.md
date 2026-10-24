# Dependency overrides

This document records every `overrides` entry in the root `package.json`, why it
exists, and when it can be removed. Overrides are a containment measure for
transitive advisories that upstream packages have not yet fixed; they are not a
substitute for upgrading the owning dependency.

## Scope

All entries below only affect the **development/CI install of this repository**
(the root npm workspace). They exist because `packages/dsh-plugin` declares
`@deepseek-ai/dsh-mcp-client` as a peer dependency, so npm installs the DSH peer
tree at the repository root for contract tests.

They are **not shipped**:

- `@mebular/core` publishes only the dependencies in its own `dependencies` /
  `optionalDependencies` lists; `@deepseek-ai/*` is not among them.
- The Electron desktop artifact installs `apps/desktop` separately and does not
  include the root workspace.
- A consumer of `@mebular/dsh-plugin` resolves `@deepseek-ai/dsh-mcp-client`
  from its DSH host. npm ignores `overrides` declared by installed packages, so
  these entries cannot change a host's resolution. Fixing host installs requires
  an upstream DSH release that raises the pins below.

## Entries

| Override | Target | Vulnerable path (as installed) | Advisory |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-llm` → `zod` | `4.6.7` | `@deepseek-ai/dsh-mcp-client@0.2.1-rc.3` → `@deepseek-ai/dsh-llm@0.2.1-rc.3` → `zod@4.4.3` | GHSA-mrhx-c7xc-m3w5 |
| `@deepseek-ai/dsh-sandbox-policy` → `zod` | `4.6.7` | `…/dsh-mcp-client` → `dsh-tools` → `dsh-sandbox-policy@0.2.1-rc.3` → `zod@4.4.3` | GHSA-mrhx-c7xc-m3w5 |
| `@deepseek-ai/dsh-session-projection` → `zod` | `4.6.7` | `…/dsh-mcp-client` → `dsh-tools` → `dsh-agent` → `dsh-session-projection@0.2.1-rc.3` → `zod@4.4.3` | GHSA-mrhx-c7xc-m3w5 |
| `@deepseek-ai/dsh-http-proxy` → `undici` | `8.12.3` | `…/dsh-mcp-client` → `dsh-subprocess` → `dsh-http-proxy@0.2.1-rc.3` → `undici@8.11.2` | GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472 |
| `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/client` | `2.4.0` | `@deepseek-ai/dsh-mcp-client@0.2.1-rc.3` → `@modelcontextprotocol/client@2.2.0` | GHSA-6prh-2h8m-c8cw |

The chosen targets are the versions already used elsewhere in this workspace
(`zod@4.6.7`, `@modelcontextprotocol/client@2.4.0`) or the first patched
release (`undici@8.12.3`). `@deepseek-ai/dsh-mcp-client@0.2.1-rc.3` is the latest
published version; its `dependencies` pins all three packages to the vulnerable
versions.

## Compatibility evidence

- `zod` 4.4.3 → 4.6.7 is a patch release on the same major; the DSH packages use
  only `import { z } from "zod"`.
- `undici` 8.11.2 → 8.12.3 is a patch release; `dsh-http-proxy` imports it
  dynamically only to install a global dispatcher.
- `@modelcontextprotocol/client` 2.2.0 → 2.4.0 keeps the surface used by
  `dsh-mcp-client`: `Client`, `StreamableHTTPClientTransport`,
  `specTypeSchemas`, and `@modelcontextprotocol/client/stdio`'s
  `StdioClientTransport`.
- `npm run verify:dsh-plugin` and `npm test -- --runInBand tests/dsh` guard the
  host/client contract.

## Removal criteria

Drop an entry once the owning DSH package declares at least the fixed version:

- `zod >= 4.6.6`
- `undici >= 8.12.2`
- `@modelcontextprotocol/client >= 2.3.0`

Then run `npm install` to regenerate the lockfile and confirm `npm audit` (root
and `apps/desktop`) reports zero advisories.
