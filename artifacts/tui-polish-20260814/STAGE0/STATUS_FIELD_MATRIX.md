# Status field matrix

## Current algorithm (`renderStatusBar`, `statusBar.ts:73-186`)

Always constructs the full field set, then truncates:

1. Left: `modelLabel | mode | project(gitBranch*)` + optional kg + bg-task footer  
2. Right: `totalTokens tok | $cost | turn N` + optional rate-limit + compact token bar  
3. If right exceeds width → truncate **right**  
4. If left+right exceed width → truncate **left** (model/mode/project go first)  
5. Clamp + `bgPanel` fill  

This is truncation-as-policy. Evidence: `captures/statusbar-matrix.color.md`.

## Occupancy at required widths (idle, DeepSeek V4 Flash, 12.4k active / 48.2k session)

| Width | Visible | Truncated / lost | Notes |
|-------|---------|------------------|-------|
| 60 | partial model `DeepSeek V4 …`, session tok, cost, turn, `[▏ 1%]` | mode, project, full model id | **Right cluster wins; model identity damaged** |
| 80 | model + `default` + `…`, session tok, cost, turn, bar | project, branch, kg | Default mode occupies scarce columns |
| 100 | model, `default`, `Babel`, session tok, cost, turn, bar | mid-turn extras start clipping | First width where project fits idle |
| 120 | same + large pad | idle is sparse; mid-turn still clips kg/index | Empty space ≠ useful fields |
| 160 | full idle + mid-turn `kg 1.3k` + `Indexing 45% 567/1234` | nothing | Mid-turn becomes a dashboard |

Truthfulness captures:

| Scenario | Result |
|----------|--------|
| unknown model / no limit | `[ctx ?]` — `statusbar-unknown-model-80`, `statusbar-unknown-limit-80` |
| 1M window (Pro, 412k active) | `[█████ 41%]` readable — `statusbar-1m-120` |
| zero/missing active context | bar omitted or `[ctx ?]` (never session tokens as `%`) — code `statusBar.ts:83-98` |
| long model @ 60 | left truncated; right kept — `statusbar-long-model-60` |

**Active context ≠ session tokens** is already implemented for the **bar**. The **text** `48,200 tok` is session cumulative and sits next to a 1% bar. Users cannot tell which number is the window. That is the #81 density/truth problem.

## Field usefulness (from occupancy + role)

| Field | Persistent value | Shed priority |
|-------|------------------|---------------|
| Model identity | Always — who is answering | **Keep at 60+** (full as possible) |
| Active context (`ctx ?` or compact bar / `12k/1M`) | Always — pressure + honesty | **Keep at 60+** |
| Mode | Useful only when **not** `default`/`chat` | 80+ if non-default |
| Cost | Sometimes useful mid-session | 100+ |
| Git branch | Useful when not `main`/empty | 120+ |
| Turn count | Rarely sought | 160 or drop |
| Session `N tok` | Confused with active ctx | Drop from persistent bar (review card already has cost/tok) |
| Default mode label | Noise | Drop |
| Routing cue | Forensic | Drop from default (verbose/receipt) |
| KG state | Dashboard | Drop from default |
| Rate-limit widget | Useful **only when limited** | Show only if active; else drop |
| Git dirty `*` | Cheap if branch shown | With branch only |
| Bg-task footer | Consequential execution | Keep when tasks exist; allow shed at 60 |

## Proposed shed matrix for #81

Derived from the captures above, not taste:

```text
60:  model · active-context
80:  model · mode-if-nondefault · active-context
100: model · mode-if-nondefault · active-context · cost
120: + branch (and dirty * if dirty)
160: + turn  (only if it still fits without padding theater)
```

Conditional (any width if they fit after required fields, else drop):

```text
rate-limit: only when getGlobalRateLimitState() is active
bg-tasks:   only when tasks.length > 0; first to drop after 80
```

Never persistent in default bar:

```text
knowledge-graph
routing label
default mode word
session cumulative token count
```

Invariants to test (shipped `renderStatusBar`):

- no wrap at 60/80/100/120/160  
- model visible at 60/80 (not `…` only)  
- unknown model / unknown limit / unknown active → no guessed `%`  
- 1M windows remain human-readable  
- helper/model-switch uses `activeContext.modelId` as denominator (`statusBar.ts:87`)  
- `NO_COLOR` narrow still shows model + ctx  

Wide layouts must **not** fill leftover cells with kg/routing just because `width === 160`.
