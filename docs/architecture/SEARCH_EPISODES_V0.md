<!--
status: PROPOSAL
last_verified: 2026-08-21
-->

# SEARCH_EPISODES_V0 — Governed Long-Horizon Search Foundation

Design for an AVO-inspired search-episode layer on top of Babel's existing
harness: candidate lineage, score receipts, durable search memory, plateau
detection, and a **read-only** strategy supervisor.

This is a design proposal only. It changes no runtime behavior and touches no
protected surface until separately approved and implemented.

---

## 0. Provenance

| Artifact | Identity |
|---|---|
| Babel worktree audited | `babel-cli` @ `cab2eb4637b4e9075b2811c01bfbff5ed96ffdde` (clean) |
| NOOA checkout | NVIDIA-NeMo/labs-OO-Agents @ `97f52dec84ed88ca3b202f91bee0bc0074626246`, Apache-2.0 |
| Tycho checkout | NIMI-research/Tycho @ `f68912a764372ead0a610db2e1c011d41ce5197e`, Apache-2.0 |
| AVO paper | arXiv 2603.24517 (2026-03-25); no public implementation as of 2026-08-21 |
| AVO ARC-AGI-3 blog | NVIDIA Technical Blog, 2026-08-21 |
| NOOA paper / blog | arXiv 2607.20709; "Six Agent Harness Capabilities" (2026-07-27) |
| Tycho paper | arXiv 2607.28287 |
| VISTA | vista-research.github.io (no code repo announced) |

Corpus clones are git-ignored; see
`infrastructure/TUI-CLI-Examples/_research/SOURCES.md` for reconstruction data.
Note: line citations below refer to the audited SHA and may drift.

---

## 1. Evidence ledger (post-review)

Labels: `VERIFIED` (primary source or local code), `INFERRED` (reasoned,
not directly demonstrated).

1. **VERIFIED** — AVO's transferable loop is hypothesis → action → observation
   → preserved state → revision → recovery, with persistent memory plus a
   supervisor that redirects strategy on stagnation (paper + Aug-21 blog).
2. **VERIFIED** — On the ARC-AGI-3 public set, AVO (Opus 5, 6,624 actions),
   Tycho (Opus 5, 6,641 actions), and VISTA (Opus 5, 7,542 actions) all reached
   100.00 RHAE. These are **cross-system comparisons, not ablations**;
   prompts, representations, context management, and runtimes remain confounded.
   No efficiency claim is attributable to any single mechanism from these
   results alone. (Earlier phrasing "essentially nil difference" is retracted.)
3. **INFERRED, not VERIFIED** — that *agent-selected evaluation timing*
   specifically outperforms harness-forced evaluation. Tycho supports
   agent-controlled metacognitive delegation (actor-requested world-model
   builder, 88.49 vs 83.07 RHAE under matched budgets). That is adjacent
   evidence, not proof for authoritative-evaluation timing.
4. **VERIFIED (caveat)** — All ARC-AGI-3 results above are public-set only.
   VISTA notes models postdate the public games, so contamination cannot be
   ruled out; private-set generalization is unestablished for every system
   cited. The field-level lesson: radically different harnesses extract far
   more capability from the same models on this benchmark — nothing stronger.
5. **VERIFIED** — Babel already has the governance kernel this design must
   preserve: frozen hashed `TaskContractV1`
   (`src/agent/taskContract.ts:79`), behavioral progress scoring
   (`src/agent/progressController.ts:1`), stall escalation
   (`src/agent/stallDetector.ts`), verifier receipts
   (`src/agent/verifierKernel.ts:23`), compaction capsule
   (`src/agent/providerCapabilities.ts:188`).
6. **OBSERVED (scoped)** — In the audited NOOA paths/version: no approval
   gates found; actor = verifier in-harness; AST restrictions self-described as
   "guardrails, not a boundary" (`code_validator.py:197`). These are absence
   findings in inspected code, not universal product claims, and NOOA/Babel
   target different trust models.
7. **DESIGN RULE (from review)** — NOOA's memory edge vocabulary
   (`derived_from`, `refines`, …) is inspiration only. Candidate lineage needs
   stricter semantics (§3.2).

**Gap statement.** Babel can detect *"the agent is behaving unproductively."*
It lacks machinery for recognizing *"the current search strategy itself is
unproductive"* — an agent can edit, test, and change hypotheses every turn
(positive under `ProgressController`) while cycling inside one optimization
basin for dozens of iterations.

---

## 2. Authority invariants (non-negotiable)

1. The supervisor is a **read-only adviser**. It may not mutate the workspace,
   approve candidates, execute evaluators, or declare terminal outcomes.
   Its output enters the loop only as controller-mediated proposals.
2. Model claims remain proposals; controller/verifier evidence establishes
   completion. Promotion of a candidate is a controller decision gated on
   receipts, never an agent decision.
3. The canonical episode store is append-only structured truth. Compaction
   consumes it; it never becomes the database itself. Information lost in
   summarization must remain recoverable from the store.
4. Episode machinery is additive. `TaskContractV1` semantics, freeze/drift
   rejection, and failure-class budgets are untouched.
5. No autonomous merging: lineage commits are transactional workspace events
   authorized through the existing capability broker path.

---

## 3. Data model

New module (proposed): `babel-cli/src/search/` — types, store, plateau detector,
supervisor client. Zod schemas at the boundary, strict TS types internally,
matching repo discipline.

### 3.1 Core types

```ts
export const SEARCH_EPISODE_VERSION = 0 as const;

export type CandidateStatus =
  | 'working'      // under construction in isolated workspace state
  | 'rejected'     // evaluated, failed correctness or promotion policy
  | 'promoted'     // passed gate; retained in lineage
  | 'best'         // current argmax under episode objective
  | 'superseded';  // previously-best, displaced by promotion

export interface ScoreVector {
  /** Domain metrics, e.g. { throughput_tops: number } or { tests_failed: number }. */
  metrics: Record<string, number>;
  higher_is_better: Record<string, boolean>;
}

/** Binds an evaluation to immutable verifier evidence. */
export interface ScoreReceipt {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  receipt_id: string;
  candidate_id: string;
  /** Existing H5 receipt — exit codes, hashes, workspace binding. */
  verifier_receipt_ids: string[];
  score_vector: ScoreVector;
  correct: boolean;
  evaluated_at: string;
  evaluator_profile: string;
}

export interface Candidate {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  candidate_id: string;            // immutable
  parent_candidate_id?: string;    // lineage edge, immutable after creation
  workspace_revision: WorkspaceRevisionIdentity; // reuse executor/contracts identity
  mutation_refs: string[];         // diffs/patch refs relative to parent revision
  hypothesis_id?: string;
  receipts: ScoreReceipt[];        // every evaluation ever run on it
  status: CandidateStatus;
  created_at: string;
}
```

### 3.2 Lineage edges (dedicated semantics — not NOOA vocabulary)

`parent_of`, `forked_from`, `promoted_from`, `supersedes`,
`evaluated_by (candidate→receipt)`, `score_receipt (receipt→verifier receipt)`,
`rejected_because (candidate→failure class)`. Immutable IDs throughout;
edges are append-only records in the episode store. Rationale: lineage and
verification properties need explicit typed edges; generic derivation verbs
cannot express promotion gates or rejection causes.

### 3.3 Hypotheses and episode

```ts
export interface HypothesisRecord {
  hypothesis_id: string;
  claim: string;
  family_id: string;              // groups related hypotheses (basin detection)
  evidence_for: string[];         // receipt/observation refs
  evidence_against: string[];
  disposition: 'open' | 'supported' | 'disproven' | 'abandoned';
}

export interface PlateauMetrics {
  consecutive_non_improving: number;
  best_score_age_evals: number;
  distinct_failure_mechanisms: string[];
  hypothesis_family_repeats: number;
  window_score_delta: number;
}

export interface SearchEpisode {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  episode_id: string;
  task_contract_id: string;       // links to frozen TaskContractV1
  objective: string;
  knowledge_pack_refs: string[];  // formal K — placeholder for later phase
  candidates: Candidate[];
  hypotheses: HypothesisRecord[];
  search_state: {
    current_best?: string;
    current_strategy: string;
    bottleneck?: string;
    plateau_metrics: PlateauMetrics;
    unexplored_directions: string[];
  };
  supervisor_events: SupervisorEvent[];
  budget: { max_evaluations?: number; max_wallclock_ms?: number };
}
```

### 3.4 Storage: canonical store vs capsule

```text
Canonical SearchEpisode store (append-only JSONL per episode, or SQLite later)
        ↓  durable structured truth
Projection builder
        ↓  bounded token projection
Compaction capsule extension (refs + compact view ONLY)
```

`buildCompactionCapsule` gains optional `search_episode_ref` +
`search_projection` fields. The capsule carries: episode id, current best,
plateau metrics snapshot, open hypotheses count, last supervisor event ref.
Full lineage, failed-experiment detail, and receipts live only in the store.
On resume, the engine rehydrates from the store, not from capsule prose.

---

## 4. Plateau detection (Type-B epistemic stall)

Deterministic, computed from the episode store after each evaluation:

| Condition (window W evaluations) | Signal |
|---|---|
| ≥ N consecutive candidates fail to beat `current_best` | `consecutive_non_improving` |
| Best unchanged across ≥ M evaluations | `best_score_age_evals` |
| Same failure-mechanism signature ≥ K times | mechanism repetition |
| New hypotheses all share one `family_id` | basin lock-in |
| Verifier scores within noise band of each other | verifier plateau |

These signals are **orthogonal to `ProgressSignal`**: behavioral progress
(edits, tests, new reproductions) can be positive while all Type-B conditions
hold. Escalation on Type-B is *not* nudge/restrict/kill — it is supervisor
consultation (advice), while Type-A behavioral escalation remains exactly as
today in `stallDetector.ts`.

---

## 5. Strategy Supervisor contract (read-only adviser)

Built **last**, after the store exists. It supervises structured trajectory
state, not chat history.

```text
INPUT (projection): objective, current_best + score vector, promoted lineage
summary, rejected-candidate digest w/ failure classes, hypothesis table,
plateau_metrics, budget remaining.

OUTPUT:
  diagnosis: plateau classification
  directions[2..5]: each { rationale, evidence_refs, falsification_experiment }

AUTHORITY: none. Read-only over the episode store. Output is recorded as a
SupervisorEvent and surfaced to the main agent as proposals via the existing
controller/nudge channel. The supervisor never holds tools, never verifies,
never completes.
```

Implementation note: first version should reuse the existing subagent/verifier
adapter plumbing (`chatEngineVerifierAdapter.ts` pattern) rather than new
authority-bearing machinery.

---

## 6. Integration hook points (audited files)

| Concern | File (audited SHA) | Change shape |
|---|---|---|
| Receipt ingestion | `src/agent/verifierKernel.ts` | ScoreReceipt wraps VerifierReceiptV2; no verifier changes |
| Post-evaluation scoring | chat engine turn runtime (`chatEngine*.ts`) | record candidate+receipt into episode store |
| Type-A/B split | `src/agent/stallDetector.ts` | classify; route Type-B to supervisor consult instead of kill |
| Progress scoring | `src/agent/progressController.ts` | optional score-based signal source alongside existing signals |
| Capsule projection | `src/agent/providerCapabilities.ts:188`, `compactionCommit.ts` | add episode ref + projection fields |
| Checkpoint/resume | live session snapshot paths | persist episode_id; rehydrate store on restore |
| Authorization | capability broker path | candidate commit/promotion flows through existing gates |

---

## 7. Rollout: causal ablation before adoption

Freeze per run: model, task set, reasoning level, starting SHA, tools,
task acceptance, budget, evaluator.

```text
B0 = current Deep mode (control)
B1 = B0 + candidate lineage + score receipts
B2 = B1 + structured SearchMemory across compaction/resume
B3 = B2 + deterministic plateau detection (metrics logged, no action)
B4 = B3 + supervisor consultation on plateau (read-only advice)
B5 = B4 + agent-selected evaluation timing   [tests INFERRED item §1.3]
```

Measure: verified success rate, false-completion rate, score improvement per
evaluation, repair count, tool calls, tokens, wall-clock, stalls, repeated
experiments, useful-candidates/attempts, improvement/token, improvement/minute.
Ship a stage only if it beats its predecessor on verified success without
regressing false-completions. This answers "which AVO mechanisms actually help
Babel" instead of grafting the architecture wholesale.

---

## 8. Open questions

1. Store format: JSONL-per-episode (simple, greppable) vs SQLite (queryable)?
   Default proposal: JSONL first, matching chronicle-store precedent options.
2. Isolation granularity for candidates: worktrees vs patch-stacks on one tree?
3. Should non-promoted candidates retain full artifacts forever, or garbage-collect
   bodies and keep receipts/metadata? (Evidence-retention policy needed.)
4. Does an `Optimize`/`Evolve` mode deserve separate surface status, or is
   episode support a Deep-mode capability flag?
5. KnowledgePack (`K`) formalization — deferred by design; revisit after B2.

---

## 9. Review corrections incorporated

From the 2026-08-21 external review: Tycho comparison downgraded to
cross-system (§1.2); evaluation-timing labeled INFERRED (§1.3, tested only at
B5); public-set contamination caveat made prominent (§1.4); dedicated lineage
edge semantics replacing borrowed vocabulary (§3.2); differentiator claims
scoped to audited paths/version (§1.6); exact SHAs recorded (§0); implementation
order reordered foundation-first (§7); supervisor constrained to read-only
adviser (§2.1, §5); SearchMemory kept out of the compaction capsule (§3.4).

---

## 10. Wave-1 hardening notes

Scope of this section: the B1 substrate in `babel-cli/src/search/`
(`types.ts`, `receipts.ts`, `episodeStore.ts`, `searchEpisode.test.ts`).
This domain object — candidate → score receipt → lineage → promotion /
supersession — remains deliberately separate from Babel's runtime episode
event stream (`src/evidence/`). Nothing here is wired into ChatEngine or deep
mode.

### 10.1 Confirmed invariants

1. **Append-only store.** Every mutation appends exactly one JSONL record;
   persisted history and live state fold from the same code path
   (`applyRecord`). Reload identity holds: folding the same JSONL twice
   yields byte-identical `SearchEpisode` state (tested).
2. **Receipt-bound scores.** A `ScoreReceipt` must carry ≥ 1 verifier
   receipt id; `buildScoreReceipt` refuses zero receipts and derives
   `correct` mechanically (`exit_code === 0 && !timed_out`) — never from
   model claims. Receipt-less scores are rejected live and at fold time.
3. **Immutable candidates.** Candidate IDs never rewrite: duplicate
   `candidate` records fail the fold instead of overwriting lineage.
4. **Edge integrity.** Edge IDs are unique per episode; edges are never
   mutated after append. `supersedes` must reference a candidate that was
   promoted (`best` / `superseded` / `promoted`) when the edge folds.
   Parent chains cannot cycle (path-local walk validation).
5. **Fail-closed corruption handling.** Malformed JSON, malformed record
   envelope, unknown record types, unknown edge kinds/statuses/dispositions,
   broken ID linkage, and duplicate IDs all abort load with precise,
   line- or context-tagged errors. Nothing is silently skipped or
   quarantined — the design doc authorizes no quarantine path for V0.
6. **No poisoned stores.** Live appends dry-run the fold against a state
   clone before writing, so a record the loader would reject never reaches
   disk; file and memory cannot diverge mid-failure.

### 10.2 Defects found and fixed

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | High | Unknown record types were silently skipped during fold despite the module header claiming fail-closed behavior (`applyRecord` switch had no default) | `parseSearchRecordLine` validates `type` against the known set; precise error names the offending type + line |
| 2 | High | Duplicate `candidate` records upserted over existing candidates, allowing post-hoc rewriting of receipts/status of promoted candidates | Fold rejects duplicate candidate IDs; candidates are strictly write-once |
| 3 | Medium | No uniqueness enforcement: duplicate `edge_id` / `receipt_id` folded without error | Both rejected at fold time and on live append |
| 4 | Medium | Payloads were blind casts; structurally garbage payloads flowed into state | Per-type structural validators with precise errors; final episode re-validated via `validateSearchEpisode` at end of fold |
| 5 | Medium | Lineage refs unvalidated: raw edges could reference nonexistent candidates or non-promoted supersession targets; parent cycles passed validation | Order-aware ref resolution while folding + parent-chain cycle detection in the shared validator |
| 6 | Medium | Validators crashed (TypeError) instead of rejecting cross-type payloads (e.g., `Candidate` into `validateScoreReceipt`) | All exported validators shape-guard and return error strings |
| 7 | Low | `scoreDominates` ignored b-only metrics and treated undeclared direction as lower-is-better / NaN as tie | Rule below; incomparable pairs return false |

### 10.3 Documented semantics (chosen rules)

- **`scoreDominates` partial order.** Compare over the union of metric
  names. `a` dominates `b` iff every metric is ≥ under its declared
  direction and at least one is strictly better. Missing metric on either
  side, undeclared direction, or non-finite value ⇒ incomparable (false).
  Ties dominate nothing; empty vectors are incomparable with everything.
  This keeps dominance a strict partial order safe for promotion gating.
- **Hypothesis replay is the single sanctioned last-write-wins mutation.**
  `disposition` evolves across an episode by appending a revised record with
  the same `hypothesis_id`; every revision stays recoverable from the JSONL.
  Candidates and lineage edges have no such escape hatch.
- **`promoted_from.to_ref` may be the `root` sentinel** (`LINEAGE_ROOT_REF`)
  when a promoted candidate has no parent; every other edge kind must anchor
  both refs to existing candidates (or, for `rejected_because`,
  `evaluated_by`, `score_receipt`, external/label refs — non-empty only).
- **Blank lines** in the JSONL are tolerated and skipped; they carry no
  record semantics.
- **Out-of-order records are corruption**, not a reorderable log: a score
  receipt naming a not-yet-appended candidate fails the load.

### 10.4 Future evidence-reference hooks (not implemented)

Deferred by design; do not wire these until their sources exist:

1. **Bottleneck-ledger IDs** — `SearchState.bottleneck` should eventually
   reference a durable bottleneck-ledger entry ID rather than free prose.
2. **Experiment manifests** — `SupervisorDirection.falsification_experiment`
   and `ScoreReceipt.evaluator_profile` should point at versioned experiment
   manifests so evaluation setups are reproducible.
3. **Verifier receipt bodies** — `verifier_receipt_ids` are opaque strings
   today; a later wave should define where receipt bodies live and whether
   `EpisodeStore.load` may verify their existence/hashes (fail closed) or
   only their shape.
4. **Mutation artifact hashes** — `mutation_refs` should gain content hashes
   so patch drift after promotion is detectable.

### 10.5 Integration dependency (reported, not fixed)

`babel-cli/package.json` test globs (`test:unit`, line-level globs) do not
include `src/**/*.test.ts` for the new `src/search/` directory, so
`npm test` does not run these suites. Orchestrator action needed: add
`src/search/*.test.ts` to the `test:unit` glob list. Editing that file was
outside this wave's write scope.

### 10.6 Wave-A hardening notes (M1 — late failing receipt on a crowned best)

Reviewer-reproduced defect: `recordScoreReceipt` appended an explicit
`status_change:'rejected'` unconditionally on every failing receipt, so a late
failing evaluation demoted the crowned `best` candidate while
`search_state.current_best` still pointed at it — two divergent semantics for
one event depending on write path, invisible to the validator.

Chosen semantics (documented decision):

- **Explicit auto-reject mirrors the fold's implicit rule**: a failing receipt
  rewrites status to `rejected` only while the candidate is `working`. For
  `best` / `promoted` / `superseded` candidates the failing receipt is recorded
  as evidence with **no status rewrite**, and `current_best` is left
  **unchanged (never implicitly cleared)** — demotion/supersession remains an
  explicit controller decision (§2.2). The `rejected_because` edge now appends
  only on actual rejections so lineage cannot assert a rejection that did not
  happen.
- **New report-only validator invariant** (`validateCurrentBestConsistency`,
  folded into `validateSearchEpisode`): `current_best`, when set, must
  reference a candidate whose folded status is `best`; every `best`-status
  candidate must be exactly the candidate `current_best` points at.
- **Deterministic replay preserved**: `foldSearchRecords` still fails closed on
  structural violations but deliberately does not throw on these consistency
  findings — dangling-crown states written by any writer (including pre-fix
  logs replayed verbatim from JSONL) fold deterministically and are surfaced by
  `validateSearchEpisode` after load.
