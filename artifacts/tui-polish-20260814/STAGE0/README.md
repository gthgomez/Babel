# Stage 0 — TUI Evidence & Archaeology

**Campaign:** Babel TUI polish (`tui-polish-20260814`)  
**Baseline:** `1ac3bcd6b878c3c06e820e1502c5c218d62c86b6` (`origin/main`, unchanged from reviewed SHA)  
**Date:** 2026-08-14  
**Product-code edits this stage:** none  

## Verdict

```text
EVIDENCE_PARTIAL
```

Enough to execute Batch #80 (semantic paint) and #81 (field shedding). Incomplete only where a real Windows Terminal / ConPTY session could not be driven in this harness. Those gaps are recorded, not guessed.

## Contents

| File | Purpose |
|------|---------|
| `BASELINE.md` | SHA, dirty-tree, TUI diffs since `1ac3bcd` |
| `SURFACE_MAP.md` | Live surfaces, symbols, owners |
| `STYLE_USAGE_AUDIT.md` | Semantic helpers vs raw ANSI / accent misuse |
| `PROGRESS_PRIMITIVES.md` | Scheduler, liveness, overlays, percentages |
| `STATUS_FIELD_MATRIX.md` | Current occupancy + proposed 60–160 shed matrix |
| `VISUAL_REVIEW.md` | Answers to the twelve Stage 0 questions |
| `DO_NOT_EXPAND.md` | Advanced surfaces that stay out of default chat |
| `captures/` | Deterministic library renders (color + `NO_COLOR`) |

## Capture limitation

Captures are **render-to-string** of shipped modules (`renderStatusBar`, `presentChatReview`, `renderToolExecutionTrail`, `classifyLiveActivity`, `renderTokenBar`, `formatConversationThinkingStatus`, overlays). They are not Windows Terminal screenshots and do not exercise ConPTY resize/cancel/scrollback. Interactive `babel` REPL was not launched (no TTY automation / provider key required for this stage).

## Next

Batch #80 on its own branch from this baseline. No `ThemeProvider` migration. Critical context pressure must not share the execution-`error` paint.
