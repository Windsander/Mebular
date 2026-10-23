---
name: readme-authoring
description: Write, rewrite, and review the Mebular GitHub README as a product landing page. Use when working on README.md / README_CN.md, hero copy, section order, screenshots or diagrams, badges, layout, or when the README feels too long, text-heavy, or hard to scan.
---

# README Authoring

A README is a landing page, not a manual. The first screen answers three questions: what is this, who is it for, and what do I do first. Everything after that supports those answers.

## Default shape

Use this order unless the product genuinely needs something else:

1. Banner (already the title — never add `# Mebular` under it)
2. One-line hero
3. Two-line subline
4. Badges
5. Three links: website, quickstart, other language
6. One product visual or diagram
7. Why (problem → answer table)
8. What it is (3–4 short facts in a table)
9. How to use (three steps, then alternative paths)
10. What you get (outcomes table)
11. How it works (one diagram, one or two sentences)
12. Docs and developer links
13. Footer: version · stage · license

## Visual-first

Prefer **image > table > prose**.

- Every major section should have a visual anchor: a diagram, a real UI screenshot, or a table.
- If a section has no visual, make its content a table.
- If neither a visual nor a table is possible, keep the prose to two sentences.
- Use a diagram for a concept. Use a real screenshot only for current UI.
- Never fake UI, never reuse an expired screenshot, and never link to an image that does not exist yet.
- Put captions in `<sub>` under the image; keep them to one line.
- Mebular visual anchors: banner, horizontal network overview, three-step desktop flow, pairing flow, and a four-column feature strip. Reuse them instead of inventing a new visual language.

## First screen

The opening block is the whole pitch. Keep it under 45 words after the banner.

```md
**A distributed memory network for your AI assistants.**

Memory and tasks stay on your devices.<br>Devices sync directly. One shared graph.
```

Rules:

- The banner is the title. Do not repeat the product name as an H1.
- Hero is one sentence, sentence case, no period if it is a fragment.
- Subline is two short lines joined with `<br>`. Write both lines in one source line (`line one.<br>line two.`); a newline after `<br>` can render as a second break.
- One idea per line. Do not pack three claims into one sentence.
- Badges are proof, not decoration. Default to four compact badges: CI, license, runtime, protocol.
- Put all badges on one source line and keep the labels short, so the row stays on one line at README width.
- The three links are navigation, not a table of contents.

## Copy

Write like a person explaining the product to another person.

- Use second person and active voice.
- Prefer concrete verbs: keep, sync, invite, recall, audit.
- Cut, do not paraphrase. If a sentence can become a table cell, make it a table cell.
- One sentence per table cell.
- No marketing adjectives: simple, powerful, seamless, effortless, revolutionary.
- No filler: just, obviously, simply, of course.
- No vague claims. Say what stays local, what syncs, what is signed.
- Name the category in the hero. Local-first, offline, auditable are properties, not the category.
- On first mention, explain a Cloud: “A Cloud (忆云) is one shared memory space — not a hosted service.”

Target lengths:

| Block | Target |
|---|---|
| Hero | 1 line |
| Subline | 2 lines, ≤ 18 words each |
| Section intro | ≤ 30 words |
| Bullet or table cell | ≤ 20 words |
| Whole README | ≤ 900 English words |

If the draft is over budget, remove a section before shortening every sentence.

## Tables

- Two columns are the default. Use three or four only for a compact feature strip or comparison, never for prose.
- Short header, short cells.
- No paragraphs in cells.
- Use tables for comparisons, paths, outcomes, and docs links.
- Do not use a table for a sequence. A sequence belongs in a numbered list or a step diagram.

## Layout

- One blank line around images, tables, and fenced code.
- Design for the GitHub content column at desktop width first. Check 360 px for graceful degradation, not as the primary composition.
- Do not stack two bullet lists or two tables without a sentence between them.
- Use `<details>` for developer detail and reference material, not for the main path.
- Keep code blocks short. One command per line, comments at the end of the line.
- Do not start a code-block line with `#`; `check:docs` treats it as a heading.
- Use `<div align="center">` only for the opening block and the footer.
- Use a horizontal rule only once, after the opening block.

## Bilingual

- `README.md` and `README_CN.md` share the same information architecture and heading-level sequence.
- Adapt the copy; do not translate sentence by sentence.
- Keep the same images per section, localized where a localized asset exists.
- Run `npm run check:docs` before opening a PR.

## Mebular-specific constraints

- Category: **distributed memory network / 分布式记忆网络**.
- Desktop app is the shortest path, but browser, CLI, and agent paths must remain available.
- Do not make the GitHub Releases download the only entry point; a desktop build may not exist yet.
- Current UI screenshots are pending the UI freeze. Until then, use diagrams only.
- Keep `assets/banner.svg` unchanged.
- Do not put protocol details (DAG, fleet, CMF, sealing, certificate chains) on the first screen.

## Workflow

1. Read the current README and the previous version if one exists.
2. Write the section outline first.
3. Choose one visual anchor per section.
4. Turn repeated prose into a table.
5. Write the hero and subline last, after the rest is clear.
6. Cut 20% of the words.
7. Write the other language from the same outline.
8. Preview at desktop width first, then 360 px to confirm it still degrades gracefully.
9. Run `npm run check:docs`.
10. Check every relative link and every image path.

## Review checklist

- [ ] Banner is the only title; no H1 under it.
- [ ] Hero names the category.
- [ ] Subline is two lines and under 45 words total with the hero.
- [ ] First screen has four compact badges and three links.
- [ ] Every major section has a diagram, screenshot, or table.
- [ ] No paragraph longer than three lines on a phone.
- [ ] No duplicated Why / What / What you get content.
- [ ] No expired or fake screenshots; no broken image links.
- [ ] EN/CN headings match.
- [ ] `check:docs` passes.
- [ ] Relative links and image paths exist.
