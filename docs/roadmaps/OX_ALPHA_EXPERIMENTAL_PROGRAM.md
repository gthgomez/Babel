<!-- License: MIT — see LICENSE -->
<!--
status: ACTIVE
last_verified: 2026-08-21
scope: Experimental program roadmap — not normative harness authority.
Harness authority remains docs/architecture/HARNESS_ARCHITECTURE_V1.md.
-->

# Ox Alpha Experimental Program — Roadmap

Turn temporarily-free high-volume inference (`x-preview-f-free` via OpenCode Zen)
into a durable Babel asset: a **behavioral dataset showing where the harness
amplifies or suppresses model capability**, acquired through paired controlled
trials, ablation replay, trace audits, and synthetic stress corpora.

## North-star metric

**BCTS — Babel Capability Transfer Score**, per task class:

```
BCTS(class) = success_rate_under_babel(class) / success_rate_raw(class)
```

Tracked with uncertainty over N paired replicates. `BCTS < 1` classes are
capability-suppression suspects; `BCTS > 1` classes are uplift evidence.

## The core experiment

Same task + same model, three arms, N independent replicates each:

| Arm | Executor | Meaning |
|-----|----------|---------|
| `raw_opencode` | external OpenCode CLI on prepared workspace | baseline capability |
| `babel_enforce` | Babel chat-headless, product policy | normal Babel |
| `babel_shadow` / `babel_prompt_control` | existing Stage-1 diagnostic arms | mechanism diagnostics |

Per pair `(task_id, replicate_id)` one of four outcomes:

| Raw | Babel | Classification |
|-----|-------|----------------|
| pass | pass | harness-neutral |
| fail | pass | **uplift** |
| pass | fail | **suppression suspect** (gold) |
| fail | fail | model/task/environment limitation |

Existing Stage-1 machinery already provides the identity and integrity layer:
`pair_id`/`replicate_id`/`arm_order`, frozen manifest digests, attempt lifecycle
reconciliation, orphan detection (`src/services/causalCampaignContract.ts`).

## Workstreams

### W1 — External-arm executor interface (items 1)

Status: **in flight (foundation landed, executor implementation next)**

- Exists: single live invocation point `runBabelCli(['run','--mode','chat-headless',…])`
  at `src/services/swebenchProCampaign.ts:1346`; verifier overlay + fail-to-pass
  check are arm-agnostic harness-side steps.
- Build:
  - `src/services/campaignExecutors.ts` — frozen `ArmExecutor` contract,
    request/result types, registry helpers. *(landed in foundation)*
  - `src/services/campaignExecutors.opencode.ts` — `createOpenCodeCliArmExecutor()`:
    spawns the OpenCode CLI (`opencode run --model <id> <prompt>`) inside
    `workspaceRoot` with operator-supplied `OPENCODE_API_KEY`; captures
    stdout/stderr/exit/timeouts; never touches Babel policy surfaces.
  - `raw_opencode` under `provider:'mock'` is skipped with signature
    `live:skipped_mock_provider` (no fake offline results).
- Acceptance: executor unit-tested with mocked spawn (argv construction,
  timeout, missing-binary, missing-key paths); babel arms byte-identical
  behavior through the same interface.

### W2 — Arms × replicates live loop (item 2)

Status: **in flight**

- Exists: manifest builder already enumerates tasks × arms × replicates with
  per-replicate `pair_id` (`buildCampaignManifest`,
  `causalCampaignContract.ts:272`); `raw_opencode` added to
  `CAUSAL_STAGE1_ARMS` in foundation.
- Gap: the live phase hardcodes `findAttemptForTaskArm(…, 'babel_enforce', 0)`
  (`swebenchProCampaign.ts:1799,1829,1904`) — one arm, one replicate ever runs.
- Build: loop live phase over `manifest.arms × replicate_id`; dispatch through
  `ArmExecutor`; attempt lifecycle transitions per (task, arm, replicate);
  cells carry `arm`/`replicate_id`.
- Acceptance: mock campaign with 2 arms × 2 replicates produces 4 expected
  attempts per task, reconciled terminal, no orphans.

### W3 — Pair outcome matrix / delta estimator (item 3)

Status: **in flight**

- Build: `src/services/pairOutcomeMatrix.ts` — pure module over terminal
  attempts `{pair_id, task_id, arm, replicate_id, success}` emitting a
  `schema_version`ed artifact (`babel_pair_outcome_matrix`) with:
  per-pair 4-outcome classification, per-arm success rates with replicate
  spread, pairwise deltas with n_pairs, suppression-suspect task list.
- Reuses semantics from `harnessEval.computePairedDeltas` precedent.
- Acceptance: table-driven unit tests covering all outcome classes, missing
  arms, replicate imbalance; no I/O in the pure core.

### W4 — Episode record completion (later)

Durable per-run summary stamped at `ChatEngine.buildResult`: `babel_sha`,
`starting_repo_sha` (at genesis), in-process `false_completion` verdict,
wall-clock `time_to_first_edit` / `time_to_verification`,
denied-action args capture (counterfactual intent),
`failure_confidence` on `completion_decision`.
Extension point documented in episode telemetry audit (2026-08-21):
SessionEventV1 kinds propagate to both `session-events.jsonl` and
`episode-events.jsonl` automatically.

### W5 — Trace critic + stress corpus (later)

- `services/traceCritic.ts`: offline analyzer over hash-chained
  `episode-events.jsonl`; taxonomy MODEL_LIMITATION / BABEL_LIMITATION /
  ENVIRONMENT_LIMITATION / TASK_AMBIGUITY / REPOSITORY_LIMITATION /
  PROVIDER_LIMITATION / UNKNOWN; output includes claim,
  `evidence_event_ids`, counterfactual, confidence, falsifier.
  Mirrors `diffCritic.ts` prompt/parse/threshold structure; stays out of the
  governed completion path.
- `fixtures/harness-stress/`: one scenario per mechanism (long-context recall,
  dirty-git start, verifier-vs-invariant, permission interception,
  misleading-first-implementation, indirection depth, premature done,
  huge-output-one-critical-line), driven by a clone of the vagueness-benchmark
  runner with `--min-pass-rate` gating and campaign-style replicates.

## Allocation guidance (free-window usage)

~50% paired W1–W3 trials · ~20% ablation replays (needs W4 toggles) ·
~15% synthetic stress (W5) · ~10% trace audits (W5) · ~5% ordinary coding.

## Safety and honesty rules

- Safety floor (`CAUSAL_SAFETY_FLOOR`) applies to every arm including raw.
- Raw-arm runs execute UNMEDIATED model actions in an isolated workspace:
  dataset workspaces only, never the Babel repo itself; credential env is
  passed through but never logged; spend parity recorded per attempt.
- No synthetic results: skipped/unavailable attempts stay honestly labeled
  (`skipped`, `env_error`), matching existing dual-scoreboard discipline.
- This document is program roadmap, not harness authority.

## Provenance

Gap analysis 2026-08-21 from three parallel code audits (campaign infra,
episode telemetry, ablation/replay surfaces). Key file anchors verified same
day: causalCampaignContract.ts, swebenchProCampaign.ts, harnessEval.ts,
outcomeSemantics.ts, episodeStream.ts, diffCritic.ts.
