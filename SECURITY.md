# Security Policy

## Supported versions

| Version | Status |
| --- | --- |
| `0.1.x` | Current, maintained |
| Earlier than `0.1` | Not guaranteed to receive fixes |

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub Private Vulnerability Reporting:

<https://github.com/Windsander/Mebular/security/advisories/new>

This opens a private advisory visible only to you and the maintainers.

### What to include

- Affected version(s)
- Component: daemon, MCP, Console, or Electron desktop
- Steps to reproduce
- Impact
- Proof of concept, if available

Please do not include real keys, tokens, or user data. Use redacted or synthetic examples instead.

## What to expect

Responses are best effort: we usually acknowledge a report within 7 days and give an initial assessment within 30 days. This is not a fixed SLA, and timelines may vary with complexity and maintainer availability.

## Coordinated disclosure

We publish details after a fix or mitigation is available. Please give the maintainers reasonable time to respond and release a fix before disclosing publicly.

## Scope

In scope:

- Mebular daemon
- MCP server
- Console
- Electron desktop app
- Sync protocol
- Authentication and authorization
- Cryptography and key handling

Out of scope:

- Dependency upgrades with no demonstrated security impact
- Ordinary bugs with no security impact
- Local issues that require physical access and have no additional impact

Out-of-scope reports are welcome as regular GitHub issues.

## Safe harbor

We consider good-faith security research authorized under this policy when you:

- do not destroy, corrupt, or exfiltrate data;
- do not access, modify, or publicly disclose other people's data;
- stop testing and report promptly once you identify a vulnerability.

---

**中文提示**：安全漏洞请通过上方的 GitHub 私密报告入口提交，不要开公开 issue；报告中请勿附带真实密钥、令牌或用户数据。
