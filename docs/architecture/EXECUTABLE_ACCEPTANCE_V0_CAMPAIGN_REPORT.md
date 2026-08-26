<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: CHECKPOINT__EMPIRICAL_CAMPAIGN_NOT_RUN
last_verified: 2026-08-26
authority: non-normative campaign report, subordinate to harness-v1
-->

# Babel Executable Acceptance V0 — Campaign Completion Report

This report records the implementation checkpoint. The A7 detection and
prevention cells were not run in this coding session, so empirical performance
claims, percentages, paired statistics, costs, and latency values remain
`UNRESOLVED`. The research decision below is intentionally limited to the
locally verified recording/research surface; it is not a claim that Acceptance
V0 has won the confirmatory experiment.

## 1. Starting state

- Refreshed `origin/main`: `2e2aa60e0bb7339dab6659fe4b04a8629222d0f1`.
- Current working branch: `codex/bdns-b0-architecture`.
- Current branch head at inspection: `985385a8777db96d0a7dc43801cf4365087a764e`.
- Open GitHub PRs observed during inspection: none.
- Existing state: Harness-v1 completion authority, TaskContractV1 freeze,
  revision-bound receipts, EvidenceGraph, IndependentVerifier, clean-room
  grading, paired campaign infrastructure, and BDNS EvidenceCandidateV1.
- The worktree already contained uncommitted BDNS B0 work. Those bytes were
  preserved and were not included in the Acceptance implementation surface.

## 2. Final architecture

`AcceptanceInputSnapshotV0` is a pre-implementation, hash-bound snapshot of
the frozen TaskContract identity, request, baseline revision/verifiers, policy,
and authoritative inputs. Its structural `patchVisibility: 'none'` boundary
and recursive forbidden-field validation reject candidate patch, filesystem,
working-tree, implementor-message, and BDNS-runtime inputs.

`AcceptanceClaimV0` separates epistemic status from provenance and contains a
small falsifiable statement. It has no oracle field; one claim may have many
oracle steps.

`ExecutableAcceptanceContractV0` is content-hashed, TaskContract-bound, and
recursively frozen. `OraclePlanV0` is separately content-hashed and frozen,
records pre/post-patch provenance, and refuses non-human oracle steps for
ambiguous claims.

Evidence admission creates `ClaimEvidenceLinkV0` only after an explicit
supports/contradicts/inconclusive interpretation. Implementor explanations,
stale receipts, unrelated test evidence, truncated evidence, and observer-loss
signals cannot support a required claim. BDNS candidates are read-only inputs;
BDNS itself has no acceptance dependency or verdict field.

`evaluateSufficiency` is a pure deterministic function. It returns
`ACCEPT`, `REJECT`, `ESCALATE`, or `INSUFFICIENT_EVIDENCE` with claim states and
per-subsystem health. It never calls an LLM, mutates the kernel, or writes a
`TerminalOutcome`.

The feature-flagged Chat/headless recording adapter creates the snapshot before
the first model turn and persists bounded, redacted JSON next to the run. Flag
off leaves current completion behavior unchanged. No dashboard or TUI chrome
was added.

## 3. Merge train

No remote merge train was executed. The pre-existing dirty BDNS worktree and
the lack of a current-turn exceptional approval for push/merge prevented
safe PR publication from this session. Local implementation slices are
represented by disjoint module surfaces and tests:

| Slice | Local implementation                                                                                                                                              | CI / merge SHA       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A0    | Corrected architecture contract and this report                                                                                                                   | not run / not merged |
| A1    | `src/acceptance/{types,canonical,integrity,freeze,validation,artifacts}.ts`                                                                                       | not run / not merged |
| A2    | `src/acceptance/compiler.ts`                                                                                                                                      | not run / not merged |
| A3    | `src/acceptance/oraclePlanner.ts`                                                                                                                                 | not run / not merged |
| A4    | `src/acceptance/evidenceAdmission.ts`                                                                                                                             | not run / not merged |
| A5    | `src/acceptance/sufficiency.ts`                                                                                                                                   | not run / not merged |
| A6    | `src/acceptance/recording.ts` and thin `chatCore.ts` hook                                                                                                         | not run / not merged |
| A7    | `src/acceptance/{dataset,experiment,fixtureAdapter,specialFixtures,campaign}.ts`, frozen dataset, readiness/coordinator checks, and provider-free fixture command | not run / not merged |

## 4. Contamination audit

- Compiler patch blindness: `compileAcceptance` accepts one
  `AcceptanceInputSnapshotV0` argument and imports no filesystem, Git,
  process, ChatEngine, or BDNS runtime.
- Implementor blindness: the recording hook passes only the pre-turn task
  contract into the preparation helper; compiled claims are not added to the
  model context.
- Frozen contract integrity: hashes exclude only identity/freeze fields and
  all emitted artifacts are recursively frozen; validation rejects hash and
  identity drift.
- Frozen OraclePlan integrity: plan and step hashes are separate from the
  contract, each step is claim-bound, and post-patch provenance is explicit.

## 5. Detection experiment (A7a)

Provider-free wiring self-test: `RUN — NOT EXPERIMENTAL EVIDENCE`.

The existing clean-room canary runner and two sealed special fixtures were
composed with the D0/D1/D2 scoring adapter for nine runnable preregistered
fixtures, one replicate each. The result was 27 detector rows (9 tasks × 3
detectors): D0 false accepts `6/9` (AA-AMB-01, AA-BDNS-01, C10–C13), D1 false
accepts `0/9`, and D2 false accepts `0/9`. D1 true accepts were `2/9`; D2 true
accepts were `0/9` with `6/9` escalations because H0
correctly refused to invent semantics for ambiguous prompts and conservatively
escalated several explicit canary claims. Paired deltas are recorded by the
scorer, but these fixture results use no model and are only
measurement-wiring/self-test evidence; they do not establish detection lift.

Confirmatory A7a: `NOT RUN`.

The preregistered detectors are `babel_control`, `frontier_posthoc`, and
`acceptance_v0`. Candidate implementations, hidden oracles, replicates, raw
counts beyond the fixture self-test, paired confirmatory statistics, and live
model measurements are not available. All nine preregistered tasks are now
fixture-backed and covered; this does not substitute for a live confirmatory
cell.

The pure A7a coordinator now refuses a non-runnable dataset population, an
incomplete factorial matrix, a manifest/source-manifest hash mismatch, or a
candidate-state mismatch across the paired detector rows. It consumes rows
from the existing canary runner, whose rows now carry a deterministic digest
of the captured production candidate state, and cannot launch providers or
mutate a workspace.

## 6. Prevention experiment (A7b)

Status: `NOT RUN`.

The preregistered arms are `babel_control`, `prove_it_prompt`, and
`acceptance_v0_gated`. Gating remains an experimental/high-assurance concept;
it was not enabled as default Chat behavior.

The provider-free fixture self-test is not A7b-eligible: it has one replicate
instead of the required three, and D2 has no false-accept reduction over the
`frontier_posthoc` detector. No prevention result is inferred from that
self-test.

The pure A7b coordinator now refuses to score prevention rows unless the
frozen A7a gate passes first, the full runnable dataset population is present,
and the P0/P1/P2 factorial matrix is complete. This is coordination and
eligibility enforcement only; it does not enable default Chat gating.

The checked-in `A7B_DETECTION_GATE_POLICY_V0` requires at least three trials per
arm, at least a 0.20 absolute false-accept reduction versus `babel_control`,
and the independent `frontier_posthoc` detector, false rejects no higher than
0.10, escalations no higher than 0.25, and complete coverage.
`buildEligiblePreventionManifest` refuses to construct a prevention cell until
that preregistered gate passes.

## 7. False rejects

`UNRESOLVED` — no empirical candidate set was run.

## 8. Escalations

`UNRESOLVED` — no empirical candidate set was run. The deterministic policy is
that required ambiguous claims produce `ESCALATE` and unverifiable claims
remain unproven.

## 9. Cost and latency

`UNRESOLVED` — no model campaign was executed. No cost or latency value is
reported.

## 10. Kill criteria

All confirmatory criteria are `UNRESOLVED` because A7 was not run. The
provider-free fixture self-test is not sufficient to trigger or clear a kill
criterion.

|   # | Preregistered criterion                                                                                             | Status     |
| --: | ------------------------------------------------------------------------------------------------------------------- | ---------- |
|   1 | Acceptance does not materially improve consequential false-accept detection versus an independent frontier reviewer | UNRESOLVED |
|   2 | Gated Acceptance does not reduce consequential false completion versus the adversarial verification prevention baseline | UNRESOLVED |
|   3 | False rejection exceeds the preregistered bound                                                                     | UNRESOLVED |
|   4 | Escalation burden exceeds the preregistered bound                                                                   | UNRESOLVED |
|   5 | Contract compilation repeatedly paraphrases without falsifiable semantic value                                      | UNRESOLVED |
|   6 | Oracles mainly duplicate existing tests                                                                             | UNRESOLVED |
|   7 | Acceptance invents requirements outside authoritative inputs                                                        | UNRESOLVED |
|   8 | Ambiguous requirements are handled unreliably                                                                       | UNRESOLVED |
|   9 | Candidate information leaks into frozen semantics                                                                   | UNRESOLVED |
|  10 | Oracle strategy is materially adapted to the candidate without provenance                                           | UNRESOLVED |
|  11 | Implementors see hidden claims in the default experimental arm                                                      | UNRESOLVED |
|  12 | Evidence admission treats unrelated green tests as proof                                                            | UNRESOLVED |
|  13 | BDNS gains acceptance authority                                                                                     | UNRESOLVED |
|  14 | Sufficiency changes `TerminalOutcome`                                                                               | UNRESOLVED |
|  15 | Cost or latency is economically unreasonable relative to lift                                                       | UNRESOLVED |
|  16 | A cheap prompt or skill captures nearly all the value                                                               | UNRESOLVED |

The code does enforce the structural protections for patch leakage,
hidden-claim default behavior, unrelated green tests, BDNS authority, mutable
contracts, and `TerminalOutcome` isolation; those protections are not
substitutes for the unresolved empirical criteria above.

## 11. Static architecture audit

Observed implementation status:

| Check                                                                         | Classification                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Acceptance imports BDNS candidate types read-only                             | VALID                                                                                               |
| BDNS imports Acceptance                                                       | VALID — no reverse import                                                                           |
| Compiler reads filesystem/Git/candidate patch                                 | VALID — no such imports or parameters                                                               |
| ChatEngine completion semantics changed                                       | VALID — no ChatEngine edit                                                                          |
| Kernel completion writes from Acceptance                                      | VALID — no kernel import                                                                            |
| Redacted acceptance artifacts are inspectable                                 | VALID — read-only `inspect acceptance` route reuses the existing run resolver                       |
| `claimSatisfied`, `requirementMet`, or `acceptanceVerdict` on BDNS candidates | VALID — forbidden recursively                                                                       |
| Mutable frozen contracts/plans                                                | FIXED — recursive freeze plus hash validation                                                       |
| Unbounded acceptance artifacts                                                | FIXED — redaction, depth/array bounds, 64 KiB per artifact                                          |
| Duplicate campaign runner                                                     | VALID — fixture adapter composes the existing canary runner; no second live campaign implementation |

## 12. Sequential verification checkpoint

Observed on 2026-08-26 after formatting the new acceptance modules:

| Check                                                                                                                        | Result                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Acceptance unit tests                                                                                                        | PASS — 18/18 (compiled test runner, no-isolation mode)                                                                                        |
| Provider-free acceptance fixture command                                                                                     | PASS — 9 runnable tasks × 3 detector rows; explicitly non-experimental; no design-only tasks skipped                                          |
| Existing canary suite                                                                                                        | PASS — 13/13, including candidate-state digest coverage                                                                                       |
| Harness acceptance suite                                                                                                     | PASS — 23/23                                                                                                                                  |
| BDNS diagnostic suite                                                                                                        | PASS — 25/25                                                                                                                                  |
| Typecheck                                                                                                                    | PASS                                                                                                                                          |
| Build                                                                                                                        | PASS                                                                                                                                          |
| Resolver, pipeline-v9, MCP adapter, OTel, Android warning cleanup, bounded contract, orchestrator routing, portable workflow | PASS                                                                                                                                          |
| Lint                                                                                                                         | PASS — existing warning baseline: 743 warnings, 0 errors                                                                                      |
| `git diff --check`                                                                                                           | PASS                                                                                                                                          |
| Full unit suite                                                                                                              | FAIL — existing live-provider credential, project-root identity, live-provider, and UI snapshot failures; no acceptance test failure observed |
| Smoke fixtures                                                                                                               | BLOCKED — no Docker image configured for `safe_repo` isolation                                                                                |
| Parity audit                                                                                                                 | BLOCKED — referenced `scripts/parity_audit_montecarlo.ts` is absent                                                                           |
| Repo-wide Prettier check                                                                                                     | FAIL — existing repository-wide formatting drift; acceptance files were formatted directly                                                    |
| Public content policy                                                                                                        | FAIL — five pre-existing BDNS documentation violations (PCONT007)                                                                             |
| Strict public scrub                                                                                                          | PASS — no external scanner installed, so gitleaks enforcement remains unavailable                                                             |

The generated `babel-cli/effect-ledger.jsonl` test artifact was removed after
verification. No pre-existing BDNS or other dirty work was removed.

## 13. Final main

- Starting `origin/main`: `2e2aa60e0bb7339dab6659fe4b04a8629222d0f1`.
- Ending `origin/main`: unchanged at the observed starting SHA.
- Acceptance changes remain local and unmerged.
- Latest main CI state: `UNRESOLVED` in this session; no PR was published.

## 14. Final decision

**PARTIAL GO — RETAIN RECORDING/RESEARCH ONLY**

This checkpoint promotes only the locally verified, non-authoritative
recording/research surface for further controlled evaluation. It does not
promote gating, does not claim detection lift, and does not substitute for the
required A7a/A7b confirmatory decision. The next authorized step is to publish
serialized PR slices from a clean, classified worktree, then run the frozen
detection cell before considering any gated prevention arm.
