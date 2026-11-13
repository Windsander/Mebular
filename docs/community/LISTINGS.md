# Community listings and directory audit

Where Mebular (and its DSH plugin) is listed outside npm, GitHub Releases and the
product site, what each surface shows today, and who owns the next move.

- **Audit date**: 2026-11-13
- **Current release**: v0.3.4 (`@mebular/*` npm packages, incl. `@mebular/dsh-plugin`)
- **Canonical DSH entry source**: [`docs/dsh/awesome-dsh-plugin-entry.yml`](../dsh/awesome-dsh-plugin-entry.yml)
- **Scope**: community/listing surfaces only. Version numbers, manifests, the changelog,
  release/publish workflows, tags and release notes are owned by the release train and are
  not edited from this document.

## Approved DSH long description

The listing copy of record is the 🌌 version approved in
[awesome-dsh-plugin#11519](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11519):

```yaml
description:
  en: "🌌 Mebular · shared memory and task collaboration for agents. Through a DSH-native plugin, it provides complete cross-device, cross-agent memory sharing and task-graph capabilities — so physical devices are no longer the boundary of your agents. Secure, controllable, and decentralized!"
  zh: '🌌 Mebular 忆云 · 智能体共享记忆与任务协作。通过 DSH 原生插件接入，提供完整的跨设备、跨 Agent 记忆共享与任务图功能，让物理设备不再是你智能体的边界，安全、可控、去中心化！'
```

Current upstream `main` carries that text plus one appended sentence describing the runtime
prerequisite (`attaches to an existing Mebular app or CLI runtime; when none exists, …`).
That sentence is added back by the maintainers' batch calibration commits, so it is treated as
an accepted addition, not as drift to revert.

## Status table

| Surface | What it shows now (2026-11-13) | Action taken | PR / link | State |
|---|---|---|---|---|
| awesome-dsh-plugin entry file (`data/plugins/Windsander__Mebular--packages-dsh-plugin.yml`) | 🌌 copy + one runtime-prerequisite sentence; `category: memory`; `url` → `tree/main/packages/dsh-plugin`; icon resolves (HTTP 200) | Verified only. #9167 (initial), #11519 (🌌 copy) and #12556 (restore 🌌 copy) are all merged; no duplicate PR opened | [entry](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/Windsander__Mebular--packages-dsh-plugin.yml) · [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167) · [#11519](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11519) · [#12556](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12556) | Up to date |
| awesome-dsh-plugin detail page EN/ZH | Copy is the approved 🌌 text, but the install snippet still reads `@mebular/dsh-plugin@0.3.2` | None possible from here: the page renders a cached README snapshot and is rebuilt by the upstream nightly `build-site` workflow from this repo's README, which already says 0.3.4 | [EN](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) · [ZH](https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/) | Waiting on upstream rebuild |
| dshmarketplace.dev | Listed: 1 result for `mebular`, category `memory`, install check **passed** on DSH `0.2.2-rc.1` (2026-11-13), npm install command unpinned, star count cached at 16 | Verified only; the catalogue syncs itself from the community registry and the `dsh-plugin` GitHub topic | [search](https://dshmarketplace.dev/plugins?q=mebular) · [API record](https://dshmarketplace.dev/api/v1/plugins?q=mebular) | Up to date (auto-synced) |
| dshmarket.com | Listed in the browse index (10,581 plugins) with the same registry data | Verified only; the site is a front end over the awesome-dsh-plugin registry | [browse](https://dshmarket.com/browse/) | Up to date (auto-derived) |
| dsh-plugin.org | Not listed. Pages exist only per repository (`/plugins/<owner>/<repo>`), and submission requires an npm package, the `dsh-plugin` topic and a reviewed GitHub issue | Submission drafted, not filed — needs a signed-in GitHub session, which this maintenance session does not have | [submit](https://dsh-plugin.org/submit) · [issue template](https://github.com/dshplugin/dsh-plugin-hub/issues/new) | Blocked (credentials) |
| dshplugin.app | Not listed. The registry fetches a repository root and classifies the artifact; the submit form is protected by an interactive challenge | Submission drafted, not filed — interactive form plus challenge, and a monorepo root would be indexed as the whole product rather than the plugin | [submit](https://dshplugin.app/submit) | Blocked (interactive form) |
| dsharness.io | Not listed. Its catalogue crawls the `dsh-plugin` GitHub topic daily and still reports "No plugins match your search" for `mebular`; site data stamped 2026-11-06 | Verified only; the repo already carries the `dsh-plugin` topic, so this is a crawl/eligibility gap on their side | [search](https://dsharness.io/en/plugins?q=mebular) | Blocked (external crawler) |
| dshpub | Domain does not resolve: `dshpub.com`, `dshpub.dev`, `dshpub.io`, `dshpub.net` all NXDOMAIN | Recorded; nothing to update | — | Not applicable |
| GitHub repository About | Description, homepage (`https://mebular.cyberfederal.io/`) and topics (`agent-context`, `agent-memory`, `ai-memory`, `deepseek-harness`, `dsh-plugin`, `knowledge-graph`, `mcp`, `multi-agents`, `task-graph`) all current | Verified only; no change needed | [repo](https://github.com/Windsander/Mebular) | Up to date |
| README / README_CN community entry | v0.3.4 install command present; listing line named awesome-dsh-plugin only | Expanded to name the verified directories and link this audit | [`README.md`](../../README.md) · [`README_CN.md`](../../README_CN.md) | Updated in this change |
| npm (`@mebular/*`) | `latest` = `0.3.4` for all 8 packages, including `@mebular/dsh-plugin` | Read-only check; publishing is out of scope here | [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) | Up to date |

## Submission drafts (not filed)

Ready-to-paste material for the two directories that accept submissions. Both must be filed
from a signed-in maintainer session; neither is an announcement, and nothing here should be
posted as a comment or social update.

### dsh-plugin.org — issue body

```markdown
### Repository
https://github.com/Windsander/Mebular/tree/main/packages/dsh-plugin

### One-line value
Shared memory and task graph for every agent on every device, delivered as a DSH-native plugin.

### Category
Memory & Context

### Install command
dsh plugin --profile web add @mebular/dsh-plugin@0.3.4

### Compatibility
DSH >=0.2.1-rc.2 <0.3.0; Node.js >=22.19; macOS, Windows and Linux (loopback panel only).

### License
MIT

### Screenshots / demo
https://raw.githubusercontent.com/Windsander/Mebular/main/packages/dsh-plugin/assets/dsh-panel.jpg

### Notes
Monorepo sub-package: the plugin lives in packages/dsh-plugin and is published on npm as
@mebular/dsh-plugin. The GitHub repository root is the Mebular product, not the plugin alone.
```

### dshplugin.app — form values

- **GitHub repository URL**: `https://github.com/Windsander/Mebular`
- **Notes**: `DSH plugin is the npm package @mebular/dsh-plugin in packages/dsh-plugin of this monorepo. Install: dsh plugin --profile web add @mebular/dsh-plugin@0.3.4. Category: memory. MIT.`

## Rules for this surface

1. One upstream entry per directory. Check for an existing PR or listing before opening another.
2. Copy changes go through the registry entry, never through a directory's own database.
3. Directory pages that cache README snapshots refresh on their own schedule; do not open a PR
   just to force a rebuild.
4. Announcements, marketplace comments and social posts are drafted here first and published
   only with explicit approval.
