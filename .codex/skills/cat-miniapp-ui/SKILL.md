---
name: cat-miniapp-ui
description: Design and review the Cat-AI WeChat mini program UI using its pink, cozy, lightly gamified visual system. Use for WXML/WXSS page redesigns, typography and spacing fixes, touch-target reviews, text clipping prevention, playful feedback states, and visual consistency work in this project.
---

# Cat Mini Program UI

Use the project-root `DESIGN.md` as the source of truth. Read it completely before changing WXML or WXSS.

## Workflow

1. Inspect the target WXML, WXSS, JS state, and global `miniapp/app.wxss` before editing.
2. Preserve task meaning and accessibility; game feedback must never trivialize medical warnings.
3. Reuse design tokens and existing components before adding page-only values.
4. Prefer flexible `min-height` plus padding over fixed text heights or fixed line-height buttons.
5. Ensure every flex text child that may wrap has `min-width: 0`; use explicit line-height and `word-break` for long Chinese/API text.
6. Keep tap targets at least `88rpx`; include bottom safe-area padding where content approaches the tab bar.
7. Use only the pink palette for primary actions. Reserve green, amber, and red for semantic success, warning, and error feedback.
8. Run syntax/JSON checks and inspect the result in the WeChat simulator at standard and large system font sizes.

## Guardrails

- Do not load remote fonts. Use the Chinese system font stack from `DESIGN.md`.
- Do not use unsupported fractional font weights such as 650, 750, or 780.
- Do not place decorative layers above text or interactive controls.
- Do not truncate important instructions, AI answers, health warnings, pet names, or form labels.
- Do not add streak pressure, punishment, or expiring rewards to health-care tasks.

For provenance and reusable principles from Awesome DESIGN.md, read `references/source-notes.md` only when revising this skill or the project design system.
