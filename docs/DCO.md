# Developer Certificate of Origin（DCO）

标准原文来源：<https://developercertificate.org/>（Developer Certificate of Origin, Version 1.1）。

以下为原文逐字引用，未作改写；下方另有中文导读。

---

Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.

---

## 中文导读

### 它是什么

DCO（Developer Certificate of Origin，开发者原创声明）是一份简短的贡献来源声明，由 Linux 基金会维护，被大量开源项目采用。贡献者在每次提交时声明：该提交由自己创作、或来自允许这样提交的公开许可来源，并且自己有权按本项目的许可（这里是 MIT）提交它。

DCO 不是 CLA（贡献者许可协议），不要求签署额外文件，也不转移版权。它只是对「这次提交从哪来」的逐次确认。

### 贡献者怎么用

在提交时加上 `-s` 参数，Git 会在提交信息末尾追加一行 `Signed-off-by`：

```bash
git commit -s -m "fix(sync): 修復衝突收斂的邊界條件"
```

生成的内容类似：

```
Signed-off-by: Your Name <you@example.com>
```

该行取自 `git config user.name` 与 `git config user.email`，须使用真实姓名或常用署名，以及可联系的邮箱。一个提交有多位作者时，每位作者各加一行 `Signed-off-by`。

忘记签署时，对最近一次提交补签：

```bash
git commit --amend -s --no-edit
```

多个提交可交互式变基逐个补签：

```bash
git rebase -i --signoff HEAD~<n>
```

若 PR 以 squash 合并，请确认合并后的提交信息仍保留 `Signed-off-by`。

### 为什么需要

- 让每个贡献的授权链条可追溯：合并进 MIT 项目的代码，确实有权以 MIT 分发。
- 给下游使用者与再分发者一个明确的来源记录。
- 处理雇主或第三方权利：若贡献属于职务作品或基于他人代码，声明 (b)/(c) 要求贡献者确认自己已有相应授权。

本项目采用 DCO，不要求 CLA。版权归属与商标条款见 [CONTRIBUTING.md](../CONTRIBUTING.md) 的「知识产权与商标 / Intellectual Property & Trademark」章节。

---

## English summary

The Developer Certificate of Origin is a per-commit certification that you created the contribution, or have the right to submit it under this project's license (MIT). It is not a CLA, and it does not transfer copyright. Sign every commit with `git commit -s`, which appends a `Signed-off-by` line using your configured name and email. To sign off a commit you already made, run `git commit --amend -s --no-edit`; to sign off several commits, run `git rebase -i --signoff HEAD~<n>`.

The DCO text above is quoted verbatim from <https://developercertificate.org/> and is not modified. See the "Intellectual Property & Trademark" section of [CONTRIBUTING.md](../CONTRIBUTING.md) for copyright and trademark terms.
