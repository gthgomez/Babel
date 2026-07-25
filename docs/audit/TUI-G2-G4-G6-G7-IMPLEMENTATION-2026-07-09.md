<!--
status: ACTIVE
last_verified: 2026-07-09
role: SHIP_CLOSEOUT
plan: docs/audit/TUI-COMPETITIVE-CORRECTED-PLAN-2026-07-09.md
-->
# TUI Gap Closure — G2 / G4 / G6 / G7

**Date:** 2026-07-09  
**Branch:** `the feature branch`  
**Depends on plan:** [TUI-COMPETITIVE-CORRECTED-PLAN-2026-07-09.md](./TUI-COMPETITIVE-CORRECTED-PLAN-2026-07-09.md) residual items after G5/G3/G1 wave  
**Status:** **All four items DONE** — plan tracking table aligned 2026-07-09 hygiene pass

## Shipped

| ID | Title | Status | Key files |
|----|-------|--------|-----------|
| **G2** | Vim operator+motion+text-object | DONE | `vimEngine.ts`, wired in `promptInput.ts` |
| **G4** | VT100-class test backend | DONE | `vtTestBackend.ts` |
| **G6** | IME composition cursor parking | DONE | `imeCursor.ts`, `promptInput.renderCursor` |
| **G7** | Kitty keyboard protocol | DONE | `kittyKeyboard.ts`, `keyInput` enable/parse/cleanup |

Also complete on the same plan wave (earlier same day): **G1** highlight hybrid C, **G3** adaptive table holdback, **G5** stream latency timestamps.

## Acceptance notes

### G2
- Counts (`3w`, `2dw`), operators `d/c/y`, motions `h/l/j/k/w/b/e/0/$/f/t/gg/G`
- Text objects `iw/aw`, `i(/a(`, brackets, quotes
- Linewise `dd`/`yy`/`cc` via `applyLinewiseOperator`
- Pure engine unit tests + existing PromptInput yy/p regression

### G4
- Cell grid, CUP, EL, ED, DECSTBM, LF scroll, DEC 2026 ignore
- `getCell` / `screenshotStripped` / `getScrollRegion`

### G6
- `computeImeCursorPos` CJK-aware via `visibleLength`
- Parks caret; force-visible when composing / `BABEL_IME_CURSOR=1` / `BABEL_A11Y=1`

### G7
- Enable `CSI > flags u` on key-handler install when `kittyKbd` (or `BABEL_KITTY_KBD=1`)
- Disable `CSI < u` on cleanup
- Parse `CSI code;mod u` into `KeyEvent`

## Remaining (deferred — optional only)

See corrected plan §5 Optional / defer:

- O1 kill ring / yank-pop
- O2 snapshot case growth (quality paths)
- G2 multi-line pairs depth
- Richer VT SGR palette
- O3–O6 as listed in the plan

## Related

- Matrix / score: babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md
- Harness residual (not TUI): [BABEL_CODING_AGENT_STATE_2026-07-08.md](./BABEL_CODING_AGENT_STATE_2026-07-08.md)
