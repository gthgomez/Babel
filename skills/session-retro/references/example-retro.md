# Worked example: real retrospective from 2026-10-10 (Prismatix UI/UX campaign)

This is the format applied to an actual session. Note the properties: every
finding quotes an artifact, every "why" trace lands in a taxonomy category,
each lesson is a directive, and one fix was mechanical (a script patch) rather
than prose.

---

### [P1] False "deploy missing changes" report (category: V, tactical)
- **What happened:** Concluded the production deployment lacked the new
  features, when it had them.
- **Evidence:** `grep -c "Search chats" index-BZfVmmJz.js` → `0`, but that file
  was an 11 KB Vite loader; the app was `AuthenticatedApp-DprKerQ2.js`
  (341 KB), which grepped `1`. Some early `0`s were also CDN edge-cache lag
  seconds after aliasing (`Age: 146`, `X-Vercel-Cache: HIT`).
- **Why (trace):** Grepped first script tag assuming entry = app → never
  validated the verifier against a marker that must exist → internal
  inconsistency (one marker present, others absent in the "same" bundle) was
  the only catch. Root cause: **V — verification gap** (verifier not
  validated; wrong file class).
- **Fix applied now:** Re-verified against the real chunk; recorded the chunk
  layout in project memory.
- **Persistent lesson:** Verify SPA deploys by grepping ALL loaded chunks;
  sanity-check the verifier against a known-present marker first; treat "new
  build produced byte-identical asset hash to old build" as a red flag of
  wrong-file analysis, not proof of staleness.

### [P1] Edit deleted an adjacent header button (category: R, tactical)
- **What happened:** An Edit call replacing the "whole header button block"
  silently removed the reset button that was meant to stay.
- **Evidence:** Post-edit re-read showed one button where two belonged; the
  `old_string` spanned kept code, the `new_string` omitted it.
- **Why (trace):** Large-block replacement → no post-structural-edit check
  until a re-read happened to catch it → root cause: **R — plan error** in
  edit anchoring (compounded by **V** — check was incidental, not systematic).
- **Fix applied now:** Restored the button in the immediately following edit.
- **Persistent lesson:** Use minimal unique anchors around the insertion
  point; re-read the region after any structural JSX edit; rely on the
  pre-commit diff review as the systematic net.

### [P2] React controlled-input test failures (category: T, tactical)
- **What happened:** 2 of 8 new tests failed; onChange never fired.
- **Evidence:** `expect(onRename).toHaveBeenCalledWith(id, 'Renamed chat')`
  received `'First chat'` — the draft never updated.
- **Why (trace):** `input.value = x; dispatchEvent(new Event('input'))` →
  React's value tracker dedupes untracked writes → root cause: **T — jsdom/
  React harness behavior**.
- **Fix applied now:** Native setter
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, v)`)
  then dispatch; tests green.
- **Persistent lesson:** Controlled inputs in jsdom need the native value
  setter before dispatching `input`.

### [P2] workspace-autonomy.ps1 invocation burned 3 calls (category: T, tooling defect)
- **What happened:** Wrong relative path from another repo's CWD; `-Pr`
  prefix ambiguity; then `Split-Path : Cannot bind argument ... empty string`
  on every `-File` invocation.
- **Evidence:** Error at line 7: `$WorkspaceRoot = (Split-Path -Parent
  (Split-Path -Parent $PSScriptRoot))` — PS 5.1 leaves `$PSScriptRoot` empty
  inside parameter-default expressions.
- **Why (trace):** Didn't read the param block before first use → **T**;
  underlying **tooling defect** in the script itself.
- **Fix applied now (mechanical guard):** Patched the script to default
  `-WorkspaceRoot` to empty and resolve from `$PSScriptRoot` in the script
  body; verified `dirty-work` and `merge-readiness` (MERGE_READY on an open
  PR) end-to-end. Committed as a code fix, not a memory note — recurring
  tooling defects get code fixes.
- **Persistent lesson:** Read a tool's parameter list (or `--help`) before
  first invocation.

### [P3] Hunt for a nonexistent "New Chat" title writer (category: D)
- **What happened:** Several greps searched for code writing the literal
  "New Chat" title; no such code existed — the rows were legacy pre-PX07
  database rows.
- **Evidence:** Repo-wide literal search returned only comments and the
  sidebar's `Untitled conversation` fallback; the title-setting logic shipped
  in migration `20261006040000` (weeks after the oldest rows).
- **Why (trace):** Treated displayed state as live-code behavior without
  asking when the fixing code shipped vs. when the data originated →
  root cause: **D — data/state lineage misread**.
- **Fix applied now:** Reframed as a legacy-data problem; shipped a backfill
  migration.
- **Persistent lesson:** For impossible-looking UI state, check
  feature/row lineage first; label inferences as inferences.

**Session triad:** went well — evidence-first review caught the false deploy
report before it was acted on; went poorly — verification method unvalidated
until inconsistency forced a re-check; got lucky — the bundle-internal
inconsistency was visible at all.

**Recurrence note:** items 1, 2, and 5 share a meta-cause (conclusions ahead
of verification). Escalated remedy: the pre-commit diff review and
verifier-validation steps are now mandatory checks, not habits.
