# Visual review (Stage 0 questions)

Answers from captures + call sites. Corpus: `captures/` (color + `NO_COLOR`), widths 60/80/100/120/160, scenarios listed in the goal. Limitation: library renders, not Windows Terminal.

## 1. What default surfaces currently dominate attention?

The **status bar right cluster** (session tokens + cost + turn + bar) and the **review card** (title + Changed + Verified + Summary + Cost + Next). Assistant prose is visually equal to chrome, not dominant. Routine tools already collapse (`○ Read 3 files`) — good. Thinking HUD is a full line plus optional overlays.

See `transcript-verified-80.color.plain.txt`: 7-line review card under a 1-line answer.

## 2. Which colors carry multiple meanings?

- `error` / red-pink: tool failure, review failure, **and** 90%+ token pressure.  
- `success` / green: verified pass **and** read-only `✓ Complete`.  
- lavender `accent*`: identity, focus, paths, cost, BLOCKED, progress fill.

## 3. Where are raw ANSI or styling bypasses?

Justified: `theme.ts` helper implementation; waterfall CSI erase/cursor; `highlight.ts` syntax palette.  
Unjustified on/near daily-driver: `dialog.ts:749` raw `\x1b[32m✓`; accent-as-status in `renderers.ts` / `toolRenderers.ts` / waterfall cost.

## 4. Which identity-accent helpers are used as generic emphasis?

`accent(path)`, `accentBright('BLOCKED')`, `commandAccent('$cost')`, `accent` progress fill, `accentBright` spinner in `progress.ts`. User-prefix / BABEL wordmark / focused `›` are legitimate identity.

## 5. Which status-bar fields are repeatedly useful?

Model identity. Active-context meter (`[ctx ?]` / `%` of **this** request). Cost at ≥100. Branch when not obvious.

## 6. Which are repeatedly ignored?

`default` mode word, session `N tok` next to a `%` bar, turn count, kg node count, routing `Flash·mutate`, idle padding at 120/160.

## 7. What should disappear first at 60/80/100?

See `STATUS_FIELD_MATRIX.md`. First off: kg, routing, default mode, session tok, turn. Then cost (below 100). Then branch (below 120). **Never** drop model or honest active context.

## 8. Does critical context pressure need the same visual channel as execution failure?

**No.** Captures show critical token bars as a filled `%` (attention). Execution failure is `✖` / `Verification failed`. Sharing `error()` makes 90% context look like a broken turn. #80: critical → `warning`; keep the `%` text so color is not the only carrier.

## 9. Is the review card actually too large in real turns?

Yes for short answers. `review-verified` is 11 lines including Summary (duplicates assistant), Cost (duplicates bar), and always-on Next. Read-only still emits Next `[Enter] Continue` (`review-readonly`). #83 should subtract, not add chrome. Taxonomy is sound.

## 10. Does live work currently feel stalled?

Thinking line **does** show elapsed + model-idle and warns after 3s (`thinking-stalled`). Unknown/long tool work has no `● Editing` line in production (classifier unwired). Unknown tools, if wired naively, would say `● Running` (`live-activity` capture). #82 must fail unknown to neutral.

## 11. What is the real current progress architecture?

One scheduler (`FrameScheduler`) + waterfall thinking tick + liveness formatter + optional bg/subagent overlays. Separate unused `liveActivity` helper. Separate TEST_ONLY `AgentTeamOverview` with a lying 100% success bar. Do not add a fourth system.

## 12. What existing dashboard-like features must stay out of default chat?

See `DO_NOT_EXPAND.md`.

## Corpus checklist

| Scenario | Artifact |
|----------|----------|
| trivial question | `transcript-trivial-80/120` |
| repo inspection | `transcript-inspect-*` |
| one-file edit | `transcript-onefile-*` |
| multi-file edit | `transcript-multifile-*` |
| successful verification | `transcript-verified-*` |
| verification failure | `transcript-veriffail-*` |
| tool failure | `transcript-toolfail-*` |
| unverified/unknown tool | `transcript-unverified-*`, `tools-unverified-*` |
| long-running | `transcript-longrun-*`, `thinking-stalled`, `live-activity` |
| cancellation | `transcript-cancel-*` |
| read-only | `transcript-readonly-*`, `review-readonly-*` |
| model/context change | `statusbar-model-switch-100`, `statusbar-1m-120`, `statusbar-unknown-*` |
| widths 60–160 | `statusbar-*-{60,80,100,120,160}` |
| `NO_COLOR` | `*.nocolor.*` |
| 100+ line transcript | `transcript-100plus-100` |
| Windows Terminal | **not captured** — harness has no ConPTY automation |
| resize/cancel native | **not captured** — limitation |

## Hierarchy / density notes from 100+ line inspect

`transcript-100plus-100` repeats `○ Read 3 files` + short assistant + (at end) a review card. Routine work is already quiet. Chrome at top (status) and end (card) is what still shouts. Lavender identity is not the loudest problem in plain captures; **metadata volume** is.
