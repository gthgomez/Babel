# Style usage audit

Live paint API is the **module-level helpers** in `ui/theme.ts` (`success`, `error`, `warning`, `muted`, `ghost`, `info`, `accent`, `accentBright`, `activeAccent`, `commandAccent`, `colorToken`). `ThemeProvider` is unused; do not migrate.

`HAS_COLOR` / `HAS_TRUE` are computed **once at module load** (`theme.ts:93-94`). `NO_COLOR` and `FORCE_COLOR` are honored by `supportsColor()` (`theme.ts:56-65`). Runtime env flips after import do not repaint already-loaded helpers. Tests that call `supportsColor(stream)` pass a stream and re-read env; daily-driver helpers use the cached flags. This is a known behavioral quirk, not a #80 rewrite.

## Semantic helpers (exported, LIVE)

| Helper | Token | Intended meaning | Daily-driver consumers |
|--------|-------|------------------|------------------------|
| `success` | `success` | confirmed good outcome | `reviewCard` verified title/check; `toolPresentation` ✔; bg-task complete |
| `error` | `error` | actual failure | review fail/infra/agent; tool ✖; bg-task fail; **tokenBar critical** |
| `warning` | `warning` | attention / blocked / high pressure | unverified title; blocked; budget; KG stale; liveness stall |
| `muted`/`ghost`/`dim` | muted/ghost | routine / secondary | tool collapse; cost lines; complete subagents |
| `info` | `info` | informational | KG node count; tokenBar moderate |
| `accent`/`accentBright`/`activeAccent`/`commandAccent` | lavender identity | focus / Babel identity | **overused as generic emphasis** (see below) |

Accessibility themes (`babelDuskDaltonized`, `babelDawnDaltonized` in `tokens.ts`) remap success→blue and error→orange. Icons (`✓` `✖` `○`) already carry meaning; #80 must keep glyphs, not rely on hue.

## Color-meaning collisions (must fix or justify in #80)

1. **`error` = execution failure AND 90%+ context pressure.**  
   `tokenBar.ts:165-166` `coloredPercent = error(percentStr)`; `utilizationColorFn` Critical → `error` (`tokenBar.ts:259-260`). Same channel as `reviewCard` `VERIFICATION_FAILED` / `AGENT_FAILURE` and tool ✖.  
   **Stage 0 decision for #80:** critical pressure is attention, not failure. Paint critical with `warning` (keep `%` text). Do **not** invent a new token. Error stays actual failure.

2. **`success` on read-only complete.**  
   `reviewCard.ts:96-98` `paintTitle(..., isNotApplicable)` returns `success('✓ Complete')` for `NO_CHANGE_REQUIRED` / policy `not_applicable`. Capture `review-readonly.color.plain.txt` shows `✓ Complete` while `looksLikeVerifiedSuccess=false`. Visual lie. **#80:** paint not-applicable complete with `muted`, keep `○`/`✓` distinction only for verified.

3. **Identity accent as status / money / path / progress.**  
   - `renderers.ts:318` `accentBright('BLOCKED')` — status.  
   - `waterfall.ts` `commandAccent('$…')` — cost.  
   - `toolRenderers.ts` `accent(path)` / `accent(pattern)` — generic emphasis.  
   - `backgroundTaskProgress.ts:89,141` `accent` fill + running spinner — activity (borderline; prefer muted/info).  
   - `usageCharts.ts` `accent(costStr)` — not default chat (leave).  
   - `chatPanel.ts` / `historyCells/cells.ts` `accentBright` user label — identity/focus, **keep**.  
   - `onboarding.ts` wordmark — identity, **keep**.

## Raw ANSI on daily-driver-adjacent paths

| Location | What | Verdict |
|----------|------|---------|
| `theme.ts` `toneToAnsi` / `bgToken` / `button*` / `headerBg` | Implements helpers | **Justified** (the helper layer) |
| `waterfall.ts:1559` `\r\x1b[K`, resize `\x1b[nA\x1b[J` | Cursor / erase | **Justified** terminal control, not status color |
| `highlight.ts:41-46` `GREEN='\x1b[32m'` etc. | Syntax highlighting | **Justified** if glyphs/roles stay syntax-only; do not use these for outcomes |
| `dialog.ts:749` `'\x1b[32m✓\x1b[0m'` | Raw green check in picker | **#80 fix** → `success('✓')` (dialog not default chat; small, do if touching file) |
| `component.ts:108` dim placeholder | Error boundary | Justified |
| Input/kitty/mouse CSI | Protocol | Out of scope |

## `NO_COLOR`

`supportsColor()` returns false when `NO_COLOR` is set. Helpers return plain text. Captures `*.nocolor.plain.txt` keep:

- `✓` / `○` / `✖` glyphs
- words `unverified`, `failed`, `Verified complete`, `ctx ?`
- status-bar field text

Hierarchy survives without color. Daltonized themes still need those glyphs (#80 must not drop them).

## #80 file list (paint only)

Touch:

- `tokenBar.ts` — critical tier → `warning` (not `error`)
- `reviewCard.ts` — not-applicable complete → `muted`, not `success`
- `renderers.ts` — `BLOCKED` → `warning`/`error` as status, not `accentBright`
- `toolRenderers.ts` — paths/patterns `muted`/`primary` instead of `accent`
- waterfall cost `commandAccent` → `muted` if on default thinking/end footer
- comments on `ThemeProvider` if they claim live use

Do **not**: new theme system, `ThemeProvider` migration, theme picker, dashboard, status-bar density (#81), live HUD (#82).
