# Maintainability review — 2026-11 audit reconciliation

<!--
status: ACTIVE
last_verified: 2026-11-18
-->

> **Scope**: W14 (issue #535) reconciliation of the maintainability/governance findings AR-01…AR-05 from the six-audit reliability campaign (issue #521). **Base**: public main `90583d97`. **Audit snapshot**: `198193b1`. Audit text is historical evidence; every claim below was re-measured on the base commit unless labeled otherwise. This page is not a release approval.

## Method

| Measurement | Command |
| --- | --- |
| Module size | `wc -l babel-cli/src/<module>` and `config/architectural-budget/file-sizes.json` |
| Churn | `git log --since=2026-01-01 --format=%h -- <path> \| wc -l` |
| Import graph / cycles | `npm --prefix babel-cli run audit:import-graph` (Tarjan SCC over static relative edges) |
| Prompt/skill footprint | `du -sh` over stack directories; register paths in `prompt_catalog.yaml` and `02_Skills/Skill-Catalog.yaml` versus files on disk |
| Dead/duplicate sources | `npm --prefix babel-cli run knip` with `babel-cli/knip.json`; shadow check in `src/executor/architectureConformance.test.ts` |

## Results

### AR-01 — large hot modules and cycles (P2)

**Disposition: `reproduced_on_head` for size, churn and import cycles.**

| Module | Lines (head) | Commits since 2026-01-01 |
| --- | ---: | ---: |
| `babel-cli/src/agent/chatEngine.ts` | 4,699 | 205 |
| `babel-cli/src/pipeline.ts` | 3,238 | — |
| `babel-cli/src/pipeline/executorLoop.ts` | 2,887 | — |
| `babel-cli/src/services/liveCliReliabilityMatrix.ts` | 3,767 | — |
| `babel-cli/src/commands/workflowCommands.ts` | 3,371 | — |
| `babel-cli/src/sandbox.ts` | — | 50 |
| `babel-cli/src/interactive/execution/chatCore.ts` | — | 55 |
| `babel-cli/src/executor/kernel.ts` | — | 10 |

The static scan covered 2,802 TypeScript modules with 10,172 static relative edges (8,271 value edges after excluding plain `import type` / `export type`) and found **22 source-level and 18 value-level cyclic components**, including an 18-module cycle across `src/commands/`, `src/interactive/` and `src/ui/` and a 6-module agent session-event cycle. The audit's cycle claim is therefore reproduced on head. Reproduce with `npm --prefix babel-cli run audit:import-graph`. Limits: the scan does not model runtime path strings, worker spawning, or bare package re-exports.

The size/churn claim is also reproduced, but size alone is not a defect. What this workstream can assert is a named owner for every top-level module and a written boundary for the hot paths — see [SOURCE_OWNERSHIP.md](./SOURCE_OWNERSHIP.md). Splitting `chatEngine.ts`/`pipeline.ts` or breaking the command/UI cycle is not authorized here: those files are active seams for W01/W02/W05/W06/W10, and a refactor would need its own characterization and review.

### AR-02 — prompt/catalog/TUI footprint with unmeasured value (P3)

**Disposition: `reproduced_on_head` (footprint); runtime value remains unmeasured.**

| Surface | Footprint at head |
| --- | --- |
| `prompt_catalog.yaml` | 161 KiB, 196 registered paths |
| `02_Skills/` | 3.1 MiB, 367 markdown files |
| Registered skills | 115 in `Skill-Catalog.yaml` |
| Unregistered skills | 122 (116 under `archive/`, 6 elsewhere) |
| `babel-cli/src/ui/` | 3.6 MiB before cleanup (3.5 MiB after removing dead duplicates) |

No ablation study was performed, and deleting prompt layers or the TUI without an experiment would be a speculative rewrite. The 6 non-archive unreferenced skill files are a bounded backlog item; the archive is deliberate history, not orphaned work.

### AR-03 — unused/dead code tooling, placeholders, orphaned skills (P3)

**Disposition: `coded` on branch `w14-535`.**

Reproduced and repaired:

- **Knip unconfigured** — reproduced: `knip` was a devDependency with a bare `npm run knip` script and no config file. Its default scan reported live UI modules (`src/ui/renderers.ts`, `waterfall.ts`, `theme.ts`, …) as unused files because it did not know the CLI, daemon, worker or test entry points. Added `babel-cli/knip.json` with real entries; the remaining report is a bounded, ratcheted list of genuinely unreferenced modules.
- **Shadowed duplicate sources** — found 12 `.js` files that duplicated a `.ts` module (`taskCompletion`, `ui/{badges,inspection,progress,renderers,sections,statusLine,tables,theme,timeline,tokens,waterfall}`). Both `tsc` and `tsx` prefer the `.ts` module, and a clean `npm run build` proved `dist/` emits the TypeScript implementation, so the `.js` copies were dead. Removed 112 KiB of dead source and reduced `source-provenance.json` to the 7 intentional JavaScript-only files. The conformance suite now rejects any new shadowed module.
- **Placeholder renderer** — `zellijReadClipboard()` always returns `null` and is documented as a placeholder for a Zellij capability that does not exist. It has a positive control in `ui/clipboard.test.ts`; removing it would only move the branching elsewhere. Kept, documented, not counted as a defect.
- **Orphaned skills** — only 6 non-archive files are unregistered; the 116 others are deliberate archive history. Recorded as backlog, not deleted.

### AR-04 — churn makes behavioral ownership hard to track (P2)

**Disposition: `coded` on branch `w14-535`.**

Churn is reproduced (205 commits on `chatEngine.ts`, 50 on `sandbox.ts`, 55 on `chatCore.ts` in the measured window). The bus-factor-one assertion in the original audit was based on author labels and is not established by this measurement. The mitigation is structural, not a claim that churn stopped: a machine-checked source-ownership manifest, an explicit hot-path boundary table, and per-workstream disposition files so evidence lands next to its owner instead of in one shared table.

### AR-05 — private audit report promoted before reconciliation (P2)

**Disposition: `historical` / unverifiable from public source.**

Private PR #164 is not reproducible from the public repository. Its claimed "33 findings but 38 negative entries plus 3 positives" cannot be checked here, and no private material is copied into public files. The proposed public register (PR #536) reconciles six audits into 100 unique IDs and states that the sixth report must not become sole canonical truth. When that register merges, the conformance suite validates its 100-ID uniqueness and per-workstream counts. Until then this row stays `historical`, not "fixed".

## Backlog (recorded, not executed)

1. **Ablation for AR-02**: measure a minimal prompt stack (catalog routes → layer refs) against the full stack on a frozen offline task set; keep the result outside the candidate worktree. Do not delete layers before the measurement.
2. **Skill registration sweep**: decide whether the 6 non-archive unregistered skills should be registered, archived or removed. The archive stays.
3. **Dead-module review**: each entry in [`config/architectural-budget/unused-modules.json`](../../config/architectural-budget/unused-modules.json) needs a reachability proof (static + dynamic path + test/script usage) before deletion. Several are test-spawned workers or intentionally unconsumed barrels.
4. **Cycle gate**: current head has 22 source / 18 value cycles. A useful gate must baseline the exact components and fail on growth; a naive zero-cycle assertion would fail immediately and is not wired here because breaking the command/interactive/UI cycle crosses W02/W06/W10 seams.
5. **Hot-module split**: only after the owning streams finish their contract work, and only with behavioral characterization first.

## What remains unverified

- Whether the large modules and the 18 value-level cycles actually cause user-visible failures (the audit inferred impact; this review measured structure only).
- Runtime value of prompt/TUI layers (no ablation).
- Whether any baseline dead module is reachable through a path the static scan and knip cannot see.
- Private audit #164 content and counts.
- Windows/macOS behavior of the removed duplicate sources: removal was verified by build + TypeScript resolution, and the test suite is the portable gate; no Windows runner was executed here.
