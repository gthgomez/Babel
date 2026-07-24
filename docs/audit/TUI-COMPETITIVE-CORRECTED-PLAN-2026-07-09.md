<!--
status: ACTIVE
last_verified: 2026-07-09
role: CANONICAL_TUI_GAP_WAVE
wave_status: G1-G7 COMPLETE; residual O1-O6 optional
-->
# Babel TUI — Corrected Competitive Position & Implementation Plan

**Date:** 2026-07-09  
**Status:** CANONICAL for post–A–E TUI residual gaps · **G1–G7 wave COMPLETE** (2026-07-09)  
**Branch context:** spot-checked against live `babel-cli/src`; closeout on `the feature branch`  

**Supersedes (for planning):**
- `docs/audit/TUI-COMPETITIVE-COMPARISON-2026-07-09.md` — original 8-dimension comparison (strengths mostly good; **gap list unreliable**)
- `docs/audit/TUI-COMPARISON-AUDIT-2026-07-09.md` — source-code audit of that comparison (use as evidence ledger)

**Complements (do not replace):**
- `babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md` — long-running competitive reference (Phases A–E + matrix)
- [TUI-G2-G4-G6-G7-IMPLEMENTATION-2026-07-09.md](./TUI-G2-G4-G6-G7-IMPLEMENTATION-2026-07-09.md) — ship evidence for residual G2/G4/G6/G7
- This doc = **verified residual gap plan** after A–E; primary wave **G1–G7 done**; open work is **§5 Optional / defer** only

---

## 0. How to use this document

| Need | Section |
|------|---------|
| One-screen status | [§1 Executive verdict](#1-executive-verdict) |
| What is already true (do not re-build) | [§3 Verified strengths](#3-verified-babel-strengths-do-not-rebuild) |
| What was wrongly listed as missing | [§4 Closed false gaps](#4-closed-false-gaps-do-not-schedule) |
| What was open / what remains | [§5 Open backlog](#5-open-backlog-verified) |
| Ordered delivery plan (historical) | [§6 Implementation plan](#6-implementation-plan) |
| Acceptance tests | [§7 Definition of done](#7-definition-of-done-per-work-item) |
| Source map | [§8 File map](#8-file-map) |
| Live tracking | [§10 Tracking table](#10-tracking-table-edit-as-prs-land) |

**Rules:**
1. **G1–G7 are DONE.** Do not re-open them from older comparison gap lists. New TUI work is **§5 Optional / defer (O1–O6)** plus D2 tail in `TUI_COMPETITIVE_REFERENCE`.
2. Do not schedule work from the original comparison’s P1 autocomplete / dialog / keymap items — they are **CLOSED** (§4).
3. Competitor claims (Codex test counts, Claude Code monolith size, etc.) are **not re-verified** here; use them only as design references with file paths.
4. Prefer smallest correct change; each work item ships behind existing patterns (no new framework).

---

## 1. Executive verdict

### Position (corrected)

Babel and Codex remain the same **elite tier**. The original weighted scores (Babel 87.87 / Codex 86.68) are **directional only** — not re-scored after audit. After removing false gaps, Babel’s competitive shape is **stronger than the original comparison suggested**:

| Area | Corrected stance | Leader |
|------|------------------|--------|
| Rendering / streaming architecture | Strong, production | **Babel ≈ Codex** |
| State durability (SQLite ThreadStore, branch/resume) | Differentiator | **Babel** |
| Accessibility (ANSI strip, WCAG, structured events) | Differentiator | **Babel** |
| Input / composer (IME, stdin RAII, PromptInput V2) | Strong; vim depth trails | **Codex** (vim) / **Babel** (IME) |
| Markdown breadth (lang + table polish) | Good base; coverage trails | **Codex** |
| Testing depth (snapshot volume, VT simulator) | Strong TS suite; trails Codex VT/insta | **Codex** |
| Dialog / keymap / autocomplete | **Shipping strengths** (were mislabeled gaps) | **Babel ≈ peers** |

### What this wave was for (G1–G7 — COMPLETE)

Closed the **real residual gaps** only (all shipped 2026-07-09):

1. ~~Syntax highlighting breadth~~ **DONE (G1 hybrid C)**  
2. ~~Vim operator + motion + text-object chaining~~ **DONE (G2)**  
3. ~~Column-width-adaptive table holdback (streaming)~~ **DONE (G3)**  
4. ~~VT100-class test backend (fidelity upgrade)~~ **DONE (G4)**  
5. ~~Streaming per-chunk latency timestamps~~ **DONE (G5)**  
6. ~~IME composition cursor positioning~~ **DONE (G6)**  
7. ~~Kitty keyboard enhancement protocol~~ **DONE (G7)**  

**Still optional:** kill-ring/yank-pop, snapshot **case** growth, deeper multi-line text objects, richer VT SGR — see §5 Optional / defer.

### Confidence

| Layer | Confidence |
|-------|------------|
| Babel strengths listed below | **High** — file-backed |
| Closed false gaps | **High** — re-verified 2026-07-09 |
| G1–G7 ship status | **High** — tracking + implementation closeout 2026-07-09 |
| O1–O6 effort estimates | **Medium** — until spike per item |
| Competitor reference paths | **Medium** — not re-audited this pass |

---

## 2. Corrected metrics (point-in-time)

| Metric | Original comparison | Audit | Live check (2026-07-09) | Use this |
|--------|---------------------|-------|-------------------------|----------|
| `*.test.ts` under `babel-cli/src` | 317 | 315 | **315** | 315 |
| `*.test.ts` under `src/ui` | 70+ | 72 | **78** | ~78 (drifts) |
| Snapshot **files** (`.snap`) | “93 files” | “93 files” | **5 files** | **5 files** |
| Snapshot **cases** (JSON keys) | conflated with files | conflated | **166 total**; HistoryCell-related **~93** | say **cases**, not files |
| CI **jobs** (`ci.yml` + `tui-tests.yml`) | 24 | 10 | **10** | 10 jobs (many steps inside) |
| Binding contexts | 12 | 11 | **11** | 11 |
| Regex highlight families | “12+ languages” | 7 families | TS/JS, Python, Rust, Go, JSON, YAML (+ aliases) | **~6 families + aliases** |
| Tree-sitter grammars | 6 | 6 | TS, Python, Rust, Go, JSON, YAML (optional) | 6 optional |
| Dialog types | “1 (PermissionDialog)” | 12+ | **12+** | 12+ |
| Inline autocomplete | “not wired” | CLOSED | wired in PromptInput | **SHIPPING** |
| Keybinding remap UI | “missing” | CLOSED | `KeybindingRemapWizard` | **SHIPPING** |
| DECSTBM two-region | claimed missing in §2.8 | FALSE | primary path | **SHIPPING** |
| Resize-reflow | contradicted self | implemented | `onResize` + `reflow()` | **SHIPPING** (full-source, not incremental) |

---

## 3. Verified Babel strengths (do not rebuild)

These were CONFIRMED against source. Treat as preserve / extend, not greenfield.

### 3.1 Rendering & streaming

| Capability | Primary evidence |
|------------|------------------|
| 3-paradigm hybrid (ADR-009) | `docs/adr/ADR-009-tui-rendering-paradigm.md` |
| ChunkCoalescer 16ms batching | `babel-cli/src/ui/chunkCoalescer.ts` |
| MarkdownAccumulator fast-path + common-prefix delta | `babel-cli/src/ui/markdownAccumulator.ts` |
| TwoRegionStreaming + DECSTBM primary, cursor-up fallback | `babel-cli/src/ui/twoRegionStreaming.ts` |
| OutputBuffer singleton + DEC 2026 sync + EPIPE guards | `babel-cli/src/ui/outputBuffer.ts` |
| FrameScheduler blur-aware | `babel-cli/src/ui/frameScheduler.ts` |
| PaneManager docked/floating/modal + Z-order | `babel-cli/src/ui/paneManager.ts` |
| Table holdback (line-level scanner; Codex port) | `babel-cli/src/ui/tableHoldback.ts` |
| Content-aware table **render** (column vs K/V) | `babel-cli/src/ui/tables.ts` |
| Zero TUI framework deps | `babel-cli/package.json` |

### 3.2 Input & composer

| Capability | Primary evidence |
|------------|------------------|
| CompositionHandler (bracketed paste, UTF-8 buffer, manual) | `babel-cli/src/ui/keyInput.ts` |
| RAII stdin ownership (`withPausedStdin`, refCount) | `babel-cli/src/ui/inputCoordinator.ts` |
| PromptInput V2: multi-line, vim insert/normal/visual, undo, kill buffer | `babel-cli/src/ui/promptInput.ts` |
| InlineAutocomplete (suggest / ghost / Tab / Right) | `promptInput.ts` + `inlineAutocomplete.ts` |
| ComposerQueue (Tab queue during tasks) | `babel-cli/src/ui/composerQueue.ts` |
| KeybindingRemapWizard (3-step, atomic JSON) | `babel-cli/src/ui/keybindingRemap.ts` |
| 11 binding contexts + stack match | `babel-cli/src/ui/keybindings.ts` |
| Voice hotkey Ctrl+Shift+V | `promptInput.ts` |
| ANSI paste sanitization | `sanitizeUserText` in prompt path |

### 3.3 State

| Capability | Primary evidence |
|------------|------------------|
| SQLite ThreadStore + cell lifecycle | ThreadStore service (`node:sqlite`) |
| Dual-read resume (ThreadStore + jsonl) | `babel-cli/src/interactive/chatSessionResume.ts` |
| Thread fork / rewind / checkpoint | `babel-cli/src/interactive/commands/threadBranch.ts` (or equivalent command path) |
| ScrollbackBuffer ring (10k / 10MB) | `babel-cli/src/ui/scrollback.ts` |
| StateMutationBus | `babel-cli/src/ui/stateMutationBus.ts` |

### 3.4 Accessibility

| Capability | Primary evidence |
|------------|------------------|
| `BABEL_A11Y=1` strip CSI/OSC/DCS/ESC | `babel-cli/src/ui/a11y.ts` |
| WCAG contrast AA/AAA | `babel-cli/src/ui/contrast.ts` |
| Reduced motion multi-factor | `babel-cli/src/ui/motion.ts` |
| Structured `A11Y:` JSON-line events | `a11y.ts` |
| Plain-text fallbacks + alt-screen avoid | `a11y.ts` |

### 3.5 Dialogs (strength, not gap)

| Type | Location |
|------|----------|
| Confirm, Select, MultiSelect, Permission, Input, CostThreshold, Progress, Alert, ThemePicker | `babel-cli/src/ui/dialog.ts` |
| ActionPicker, KeyCapture, BindingPicker | `babel-cli/src/ui/keybindingRemap.ts` |
| Theme picker variant | `babel-cli/src/ui/themePicker.ts` |

---

## 4. Closed false gaps (do not schedule)

| ID | Original claim | Reality | Action |
|----|----------------|---------|--------|
| F1 | Dialog overlay thin — PermissionDialog only | 12+ dialog types | **DROP** |
| F2 | Inline autocomplete not wired | Fully integrated in PromptInput | **DROP** |
| F3 | No keybinding remapping UI | `KeybindingRemapWizard` ships | **DROP** (list as strength) |
| F4 | 24 CI jobs | 10 jobs / multi-step workflows | **DOC FIX only** |
| F5 | 5 pre-existing twoRegionStreaming failures | No skip/todo; suite active | **DROP** |
| F6 | No two-region hardware scroll | DECSTBM is primary path | **DROP** |
| F7 | No resize-reflow in streaming | Implemented; full-source reflow | **DROP** as missing; optional future: incremental reflow is not required for parity |

Also drop original P1 “wire autocomplete” and P6 “build dialog framework from 1 type” as greenfield work.

---

## 5. Open backlog (verified)

Severity: **HIGH / MEDIUM / LOW**  
Effort: **S** (<1 day) · **M** (2–5 days) · **L** (1–2 weeks) · **XL** (>2 weeks)

> **Hygiene (2026-07-09):** Waves A–C below were the **implementation plan**. All **G1–G7** items are **DONE**. Do not schedule greenfield work from the G tables. Live residual = **Optional / defer** only.

### Wave A — User-visible polish — **COMPLETE**

| ID | Gap | Severity | Effort | Status | Primary Babel targets |
|----|-----|----------|--------|--------|----------------------|
| **G1** | Syntax highlighting breadth | MEDIUM | M | **DONE** (hybrid C) | `highlight.ts`, `treeSitterHighlight.ts` |
| **G2** | Vim operator+motion+text-object | MEDIUM | M–L | **DONE** | `vimEngine.ts`, `promptInput.ts` |
| **G3** | Column-width-adaptive table **holdback** | MEDIUM | M | **DONE** | `tableHoldback.ts`, `markdownAccumulator.ts` |

### Wave B — Observability & test fidelity — **COMPLETE**

| ID | Gap | Severity | Effort | Status | Primary Babel targets |
|----|-----|----------|--------|--------|----------------------|
| **G4** | VT100-class test backend | MEDIUM | L | **DONE** | `vtTestBackend.ts` |
| **G5** | Per-chunk arrival timestamps | LOW | S | **DONE** | `chunkCoalescer.ts` |

### Wave C — Input protocol polish — **COMPLETE**

| ID | Gap | Severity | Effort | Status | Primary Babel targets |
|----|-----|----------|--------|--------|----------------------|
| **G6** | IME composition cursor parking | LOW | S–M | **DONE** | `imeCursor.ts`, `promptInput.renderCursor` |
| **G7** | Kitty keyboard enhancement protocol | LOW | S–M | **DONE** | `kittyKeyboard.ts`, `keyInput` |

Ship notes for G2/G4/G6/G7: [TUI-G2-G4-G6-G7-IMPLEMENTATION-2026-07-09.md](./TUI-G2-G4-G6-G7-IMPLEMENTATION-2026-07-09.md).

### Optional / defer (not blocking) — **only open TUI residual from this plan**

| ID | Item | Severity | Effort | Notes |
|----|------|----------|--------|-------|
| O1 | Kill ring + yank-pop (multi-slot) | LOW | S | Single kill buffer exists; ring is nicety |
| O2 | Grow snapshot **cases** (not files) toward 150+ critical paths | LOW | M | Target quality paths not raw count |
| O3 | Bundle tree-sitter grammars as first-class (not optional) | MEDIUM | M | G1 shipped hybrid; bundling still optional |
| O4 | Incremental resize-reflow (vs full-source) | LOW | L | Current full-source reflow is correct; optimization only |
| O5 | Fence unwrapping for md-fenced tables | LOW | S | Codex feature; only if tables mis-render in the wild |
| O6 | Runtime A11Y toggle (not env-only) | LOW | S | Product polish |
| — | G2 multi-line pair depth / richer VT SGR | LOW | S–M | Deferred depth from G2/G4 closeout |

---

## 6. Implementation plan

### 6.1 Principles

1. **One work item ≈ one PR** (or tightly stacked PR pair: impl + tests).  
2. **Tests first or with** — no gap closed without automated proof.  
3. **Reference before invent** — read Codex/Claude Code path listed in §5, port pattern not whole crate.  
4. **No framework creep** — stay pure TS, OutputBuffer choke-point, ADR-009 paradigms.  
5. **Doc sync** — when an item closes, update this file status + `TUI_COMPETITIVE_REFERENCE.md` critical-gaps section.  
6. **Verify** — `cd babel-cli && npm test` (+ targeted file tests during development).

### 6.2 Suggested sequence

```
Week 1–2   Wave A start
  PR-G5  (S) timestamps — quick win, unblocks latency claims
  PR-G3  (M) adaptive table holdback — most visible stream polish
  PR-G1  (M) highlight breadth — packaging decision + expand families OR syntect-like strategy

Week 2–4   Wave A finish
  PR-G2  (M–L) vim operator+motion+text objects — largest composer investment

Week 4–6   Wave B
  PR-G4  (L) VT test backend — enables higher-fidelity snapshots going forward

Week 6+    Wave C (opportunistic)
  PR-G6  IME cursor
  PR-G7  Kitty keyboard
  O1–O6 as needed
```

**Rationale for order:**
- **G5 first** — tiny, reduces debate on streaming performance later.  
- **G3 next** — highest user-visible “unpolished stream” artifact.  
- **G1 next** — developer-facing quality; decide strategy early (expand regex vs bundle grammars vs hybrid).  
- **G2 after** — larger surface area; benefits from stable PromptInput test habits.  
- **G4 after product polish** — multiplies value of future snapshot work.  
- **G6/G7 last** — real but lower severity; protocol/terminal variance risk.

### 6.3 Work packages (implementation-ready)

---

#### PR-G5 — Per-chunk arrival timestamps

**Goal:** Attach arrival time to streaming chunks for latency profiling and optional regression tests.

**Design sketch:**
1. Extend `ChunkCoalescer` (or a thin `TimestampedChunk` wrapper at pipeline entry) to record `performance.now()` / `Date.now()` per push.  
2. On flush, emit optional metrics: batch size, max inter-chunk gap, time-in-buffer.  
3. Gate verbose logging behind env (e.g. `BABEL_STREAM_LATENCY=1`) or debug flag — no default noise.  
4. Add unit tests with fake timers.

**Files:**
- `babel-cli/src/ui/chunkCoalescer.ts` (+ test)
- Wire site: streaming path into MarkdownAccumulator / waterfall (find single entry)
- Optional: small metrics helper under `ui/` or `telemetry/`

**Acceptance:**
- [ ] Timestamps available at coalesce boundary without changing default render output  
- [ ] Unit tests with fake timers validate batch latency accounting  
- [ ] No measurable regression in default path (feature dark unless env set)

**Out of scope:** Full APM dashboard; only plumbing + test hooks.

---

#### PR-G3 — Column-width-adaptive table holdback

**Goal:** While a GFM table is streaming, hold output until column widths stabilize (or until a policy allows progressive reveal), matching Codex’s “no column reshuffle” behavior more closely.

**Current state:**
- `TableHoldbackScanner` detects header+delimiter and holds at **line/state** level (`tableHoldback.ts`).  
- `tables.ts` already does content-aware **final** column allocation.  
- Gap is **streaming intermediate frames**, not final layout.

**Design sketch:**
1. Read Codex `table_holdback.rs` column-width tracking.  
2. Track per-column max display width (CJK-aware) for held rows.  
3. Either:  
   - **A (preferred):** hold entire table body until stream end / blank line / fence, then render once with final widths; or  
   - **B:** re-render held region only when widths change, using accumulator reflow for that span.  
4. Keep existing line-level state machine; extend with width vector.  
5. Tests: progressive rows that would reshuffle under naive render.

**Files:**
- `babel-cli/src/ui/tableHoldback.ts` + `tableHoldback.test.ts`
- `babel-cli/src/ui/markdownAccumulator.ts` (integration)
- Possibly `tables.ts` for shared width helpers

**Acceptance:**
- [ ] Streaming table of N rows does not visibly change earlier column boundaries after each row (test via snapshot or holdback state asserts)  
- [ ] Incomplete tables still eventually flush (no deadlock on stream end)  
- [ ] Narrow terminal K/V fallback still works  
- [ ] Existing holdback tests pass; new cases for width growth mid-stream

**Risk:** Over-holding feels laggy — cap hold by row count or time if needed.

---

#### PR-G1 — Syntax highlighting breadth

**Goal:** Reduce “dim unhighlighted fence” frequency for common languages without adopting a heavyweight runtime by default.

**Strategy decision (pick one in PR description, implement that path):**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A. Expand regex families** | Add Java/C/C#/Ruby/PHP/Shell/SQL/HTML/CSS keyword sets | No new deps | Never hits 250+ |
| **B. Bundle tree-sitter grammars** | Make 6+ grammars first-class deps; document install | Better quality | Binary size, optional native pain |
| **C. Hybrid (recommended)** | Expand regex to top ~15 aliases; keep tree-sitter optional; add fence-lang alias map; dim fallback stays | Practical parity for chat | Still not Codex breadth |

**Recommended default: C.**

**Files:**
- `babel-cli/src/ui/highlight.ts` (+ tests)
- `babel-cli/src/ui/treeSitterHighlight.ts`
- `babel-cli/package.json` if bundling
- Docs: language list honesty in CLAUDE / competitive reference

**Acceptance:**
- [ ] Documented language matrix (aliases + families + tree-sitter) in code comment or small `highlight.langs.md`  
- [ ] Top languages used in Babel itself (TS, JS, JSON, YAML, PowerShell/shell, Markdown fences) all highlight  
- [ ] Unknown lang still safe (dim, sanitized)  
- [ ] No escape injection regression (`sanitize` before highlight)

**Out of scope:** Matching syntect’s 250+ one-for-one in this wave.

---

#### PR-G2 — Vim operator + motion + text-object chaining

**Goal:** Support composable editing: operators `d/c/y` (and optionally `>/ <`) + motions `w/b/e/0/$/f/t` + text objects `iw/aw/i(/a(/i"/a{/i[` with optional count prefix.

**Current state:**
- Modes: insert / normal / visual  
- Linewise ops (`dd`, `yy`), marks, dot-repeat, kill buffer exist  
- Missing: full operator-pending state, text objects, count prefixes (`5j`, `3dw`)

**Design sketch:**
1. Introduce explicit `VimState`: `mode | operatorPending | count | register`.  
2. Motions return ranges; operators apply to ranges.  
3. Text objects return inner/around ranges for pairs and words.  
4. Port behavior from Codex/Claude Code **selectively** — do not clone entire state machine in one PR if too large; split:  
   - **G2a:** counts + motions + `d/c/y` + motion  
   - **G2b:** text objects `i`/`a`  
5. Heavy unit tests for ranges on multi-line buffers.

**Files:**
- Prefer extract: `babel-cli/src/ui/vimEngine.ts` (new) used by `promptInput.ts`  
- `promptInput.ts` becomes thinner dispatcher  
- `vimEngine.test.ts` pure tests (no TTY)

**Acceptance:**
- [ ] `diw`, `daw`, `yi(`, `da{`, `3dw`, `c$` work on fixtures  
- [ ] Dot-repeat works for operator+motion forms that mutate  
- [ ] Insert mode unaffected; `/vim` toggle still works  
- [ ] No regression in non-vim editing paths  

**Risk:** Largest regression surface in composer — quarantine logic in pure module.

---

#### PR-G4 — VT100-class test backend

**Goal:** Test backend that models cursor, attributes, and scroll regions so streaming/two-region tests assert screen state, not only byte dumps.

**Design sketch:**
1. Keep `TestOutputBuffer` for simple capture.  
2. Add `VtTestBackend` wrapping a pure VT parser (evaluate: `vt100` npm, or minimal subset: CUP, EL, ED, SGR, DECSTBM, DEC 2026 ignore).  
3. API: `getCell(row,col)`, `getScrollRegion()`, `screenshotStripped()`.  
4. Migrate 2–3 critical twoRegionStreaming tests first as proof.  
5. Do not require full Codex parity in v1.

**Files:**
- `babel-cli/src/ui/testBackend.ts` (extend or sibling `vtTestBackend.ts`)  
- `babel-cli/src/ui/twoRegionStreaming.test.ts` (pilot migrations)  
- package.json only if adding a small pure dependency

**Acceptance:**
- [ ] At least 3 tests assert screen region content via VT model  
- [ ] DECSTBM + write + graduate path covered  
- [ ] Existing TestOutputBuffer tests still pass  
- [ ] CI time increase documented if material  

---

#### PR-G6 — IME composition cursor positioning

**Goal:** Park terminal cursor at the composition/caret location so OS IME UI aligns with PromptInput caret.

**Design sketch:**
1. Track composition range from CompositionHandler.  
2. On render of prompt, compute terminal (row,col) of caret.  
3. Emit CUP after frame if IME active or a11y cursor-declare mode.  
4. Respect alt-screen / two-region layout offsets.

**Files:**
- `keyInput.ts`, `promptInput.ts`, possibly `outputBuffer.ts` for post-frame cursor set

**Acceptance:**
- [ ] Unit test: given layout geometry, cursor coords match caret  
- [ ] Manual check note for Windows Terminal + one CJK IME (doc in PR)  
- [ ] No cursor flicker in non-IME path  

---

#### PR-G7 — Kitty keyboard enhancement protocol

**Goal:** Progressive enhancement for key reporting where supported.

**Design sketch:**
1. Detect support via terminal probe / env.  
2. Enable enhancement flags on enter raw mode; disable on exit (RAII with stdin ownership).  
3. Parse enhanced sequences into existing key event type — **no parallel key system**.  
4. Feature flag / capability bit; default safe on unsupported terminals.

**Files:**
- Terminal capability probe  
- `inputCoordinator.ts` / `keyInput.ts`  
- Tests with fixture sequences  

**Acceptance:**
- [ ] Unsupported terminals unchanged  
- [ ] Enhanced fixtures map to existing actions (e.g. Ctrl+Shift+V still works)  
- [ ] Enter/exit cleanup verified (no sticky mode after crash path — best effort)

---

### 6.4 Parallelization rules

When fanning out agents:

| Agent | Owns |
|-------|------|
| A | `tableHoldback.ts`, `markdownAccumulator.ts` (G3) |
| B | `highlight.ts`, `treeSitterHighlight.ts` (G1) |
| C | `vimEngine.ts` + `promptInput.ts` vim paths (G2) — **exclusive** on promptInput |
| D | `testBackend` / VT (G4) |
| E | `chunkCoalescer` timestamps (G5) |

**Never** dual-write `promptInput.ts` or `markdownAccumulator.ts` across concurrent agents.

---

## 7. Definition of done (per work item)

Every PR must:

1. Implement the acceptance checklist for its ID.  
2. Add/extend tests under `babel-cli/src/ui/**/*.test.ts`.  
3. Pass:  
   ```powershell
   cd ./babel-cli
   npm test
   npx tsc --noEmit
   ```  
4. Update this file: move ID to **Done** with date + PR link.  
5. If user-visible, add one line to `babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md` critical gaps / score history.  
6. No secrets; no unrelated refactors.

**Wave complete:** **G1–G7 Done** (2026-07-09). Remaining optional items do not block wave closure.

---

## 8. File map

### Babel (edit targets)

| Area | Paths |
|------|-------|
| Streaming | `chunkCoalescer.ts`, `markdownAccumulator.ts`, `twoRegionStreaming.ts`, `tableHoldback.ts`, `outputBuffer.ts`, `waterfall.ts` |
| Highlight | `highlight.ts`, `treeSitterHighlight.ts` |
| Input | `promptInput.ts`, `keyInput.ts`, `inputCoordinator.ts`, `keybindings.ts`, `inlineAutocomplete.ts`, `keybindingRemap.ts` |
| Tables (final layout) | `tables.ts` |
| Test harness | `testBackend.ts`, `snapshot.ts`, `*.test.ts`, `*.snap` |
| A11y | `a11y.ts`, `contrast.ts`, `motion.ts` |
| ADR | `docs/adr/ADR-009-tui-rendering-paradigm.md` |

### Competitor references (read-only)

| Area | Codex | Claude Code |
|------|-------|-------------|
| Table holdback | `codex-rs/tui/src/streaming/table_holdback.rs` | — |
| Streaming timestamps | chatwidget / stream state `QueuedLine` | — |
| Vim | TUI composer vim | `PromptInput` vim state machine |
| VT tests | `VT100Backend` | — |
| Kitty keys | `KeyboardEnhancementFlags` | — |
| IME cursor | — | `useDeclaredCursor` / cursor declaration |

Root: `/workspace-root/reference-corpus/`

---

## 9. Corrected competitive narrative (short)

**Babel wins / matches on structure:** zero-framework TS, DECSTBM two-region streaming, SQLite durability + branch/resume, accessibility stack, IME/stdin ownership, dialog + keymap wizard + autocomplete shipping.

**Codex still leads on (post G1–G7):** absolute language breadth (syntect 250+ vs Babel hybrid), snapshot **culture**/volume, and some vim edge depth. Babel closed operator+motion+objects, VT test backend v1, adaptive holdback, and related residual items.

**Claude Code still leads on:** kill-ring maturity in places; loses on architecture weight and (per prior audit) test culture — competitor claims not re-validated this pass.

**Claw Code:** harness / minimalist reference only — not a UX peer for this plan.

**Moat to preserve:** escape sanitization, a11y events, ThreadStore, pure-TS control of every write via OutputBuffer. Do not trade these away for optional O1–O6 polish.

---

## 10. Tracking table (edit as PRs land)

| ID | Title | Wave | Status | Owner | PR | Done date |
|----|-------|------|--------|-------|-----|-----------|
| G5 | Stream latency timestamps | A | **DONE** | | G1/G3/G5 wave | 2026-07-09 |
| G3 | Adaptive table holdback | A | **DONE** | | G1/G3/G5 wave | 2026-07-09 |
| G1 | Highlight breadth | A | **DONE** (hybrid C) | | G1/G3/G5 wave | 2026-07-09 |
| G2 | Vim operator+motion+objects | A | **DONE** | | `the feature branch` | 2026-07-09 |
| G4 | VT test backend | B | **DONE** | | `the feature branch` | 2026-07-09 |
| G6 | IME cursor parking | C | **DONE** | | `the feature branch` | 2026-07-09 |
| G7 | Kitty keyboard protocol | C | **DONE** | | `the feature branch` | 2026-07-09 |
| O1 | Kill ring / yank-pop | Opt | **DEFER** | | | |
| O2 | Snapshot case growth | Opt | **DEFER** | | | |
| O3 | Bundle tree-sitter | Opt | **DEFER** (G1 hybrid ships without bundling) | | | |
| O4–O6 | Incremental reflow / fence unwrap / A11Y toggle | Opt | **DEFER** | | | |
| F1–F7 | False gaps | — | **CLOSED** | — | audit 2026-07-09 | 2026-07-09 |

---

## 11. Source lineage

| Document | Role |
|----------|------|
| `TUI-COMPETITIVE-COMPARISON-2026-07-09.md` | Original swarm comparison — strengths retained; **do not plan from gap list** |
| `TUI-COMPARISON-AUDIT-2026-07-09.md` | 78-claim audit — 7 FALSE, severity re-rates (evidence ledger) |
| `TUI-G2-G4-G6-G7-IMPLEMENTATION-2026-07-09.md` | Ship closeout for residual G2/G4/G6/G7 |
| This file | **Corrected plan** + tracking; G1–G7 complete; residual O1–O6 |
| `babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md` | Ongoing canonical competitive matrix / score |

**Audit confidence on original report:** 75/100 (strengths ~90%+ accurate; gap prioritization ~30% error rate).  
**Primary wave status:** G1–G7 **complete** 2026-07-09. Open backlog = optional O1–O6 only.

---

## 12. Next moves (post G1–G7)

G1–G7 are shipped. Prefer product pain over checklist completion:

1. **Only if users hit it:** O1 kill-ring, O6 runtime A11Y toggle, or G2 multi-line pair depth.  
2. **Test culture:** O2 snapshot **case** quality on critical paths (not raw count racing Codex).  
3. **Architecture follow-on (outside this plan):** D2 out-of-process protocol transport in `TUI_COMPETITIVE_REFERENCE`.  
4. **Harness residual (not TUI):** [BABEL_CODING_AGENT_STATE_2026-07-08.md](./BABEL_CODING_AGENT_STATE_2026-07-08.md) — SWE quality, GOV-D pass-rate recovery.

---

*Generated 2026-07-09 from comparison + adversarial audit + live source spot-check. Hygiene pass 2026-07-09: G1–G7 marked complete; residual O1–O6 only.*
