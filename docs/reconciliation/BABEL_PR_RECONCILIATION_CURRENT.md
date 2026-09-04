<!--
status: ACTIVE
last_verified: 2026-09-04
-->

# Babel PR Reconciliation — current canonical ledger

Authoritative source for this document: live GitHub state of `gthgomez/Babel`
at reconciliation time. Reconstructed 2026-09-04 with `origin/main` at
`c91be8ff901769958691f505b6a4fb3a0b8cd4ed`.

## Open PR inventory at reconstruction (live GitHub)

| PR | HEAD_SHA | BASE_SHA | Mergeable | Draft | Commits | Changed files |
| --- | --- | --- | --- | --- | --- | --- |
| #120 | `73fda8d46e0cd85706d225551793946557e5c7c5` | `09882fa839253e9615a1e95ec6cd4fe81edb7871` | CONFLICTING | no | 5 | 24 |
| #126 | `e029ca2c762cccbc9f21681ba562327e23350850` | `a997d877e8342759afefc3ca9257eb6d4d9a38a2` | CONFLICTING | yes | 1 | 70 |
| #128 | `7e80571c925e60c94dc5466206704bb0b75d61f4` | `a997d877e8342759afefc3ca9257eb6d4d9a38a2` | CONFLICTING | yes | 4 | 186 |
| #129 | `9805502a6ee9bedc482e161c3cf5309e6bd270fe` | `a997d877e8342759afefc3ca9257eb6d4d9a38a2` | CONFLICTING | yes | 11 | 29 |
| #130 | `41ddded863149ded47d2934328819626952e664b` | `a997d877e8342759afefc3ca9257eb6d4d9a38a2` | CONFLICTING | no | 10 | 190 |
| #133 | `9038551311b1c3ee206d39b0eecb632a3d57e10c` | `c91be8ff901769958691f505b6a4fb3a0b8cd4ed` | MERGEABLE (BLOCKED) | no | 14 | 194 |
| #138 | `867034bddb7b98c778696509d9d5abd7cc90b787` (replaced by `a922fb2…`, see below) | `c91be8ff901769958691f505b6a4fb3a0b8cd4ed` | MERGEABLE (BLOCKED) | draft→ready | 1 | 8 |

`protect-main` ruleset at reconstruction: active, `bypass_actors: []`,
required checks `security`, `public-content-policy`, `linux-validation`,
`public-pr-metadata`, `windows-portability`, `trusted-control-plane`;
review-thread resolution required; deletion and non-fast-forward protected.
`trusted-control-plane` had **never** completed successfully for any PR
(structural deadlock documented in
[`docs/architecture/TRUST_ROOT_UPGRADE.md`](../architecture/TRUST_ROOT_UPGRADE.md)).

## Disposition ledger

| PR | HEAD_SHA | CLASSIFICATION | VALUABLE_UNIQUE_WORK | SUPERSEDED_BY | BLOCKERS | FINAL_ACTION |
| --- | --- | --- | --- | --- | --- | --- |
| #120 | `73fda8d4…` | SUPERSEDED | trusted-execution stack (supervisor, read port, execution lifecycle, independent review evidence) — all byte-identical or formatting-only in #133; breaker lane, executable identity binding, revision-scoped receipts, journal run binding, evidence sealing salvaged via #126 copies; review-thread pagination already on main; `verify-independent-review.mjs` already on main | #138 (trust), #133 lineage (product) | conflicts with main; obsolete trust-root stubs (`config/independent-review-keys.json` empty bootstrap, PR117 record) intentionally not carried | CLOSE_SUPERSEDED |
| #126 | `e029ca2c…` | SUPERSEDED | five trust-plane-neutral durability/integrity items (breaker lane with tamper fingerprint, frozen verifier executable binding, revision-scope receipt hardening, journal `run_id`/`contract_hash` + fsync, evidence-graph sealing/BLOCKED) — all preserved on the product successor; rest already evolved on main or campaign-only tooling | #138 (trust), #133 lineage (product) | conflicts with main; #126 trust/runtime plane (branded read-port-only gate, neutral transport) deliberately rejected by main's independent repair | CLOSE_SUPERSEDED |
| #128 | `7e80571c…` | SUPERSEDED | none — zero changed files outside #133's set | #133 lineage | conflicts with main | CLOSE_SUPERSEDED |
| #129 | `9805502a…` | SUPERSEDED | intended CLI-readiness stabilization commit `9805502` is superseded by #133's stronger `realCliInteractiveProcess.test.ts` rewrite (ready gating, `BABEL_SKIP_KG_INDEX`, fail-fast); 10 other commits are historical benchmark/experimental work already merged to main byte-identical | #133 lineage | conflicts with main; branch polluted with unrelated commits (one stale `campaignExecutors.ts` where main is newer) | CLOSE_SUPERSEDED |
| #130 | `41ddded8…` | SUPERSEDED | none — zero changed files outside #133's set | #133 lineage | conflicts with main; contains a simplified trust gate deliberately not adopted by main's repair | CLOSE_SUPERSEDED |
| #133 | `9038551311…` | MERGED_VIA_SUCCESSOR (#139; merge commit da1e3e6) | the 194-file product/runtime consolidation (Model Intelligence, provider reliability, trusted-execution evidence, CLI readiness, tooling) — rebuilt as clean successor content on the post-#138 main; #133's own trust-file changes are NOT carried | product successor PR(s) built from post-#138 main | failing `linux-validation`/`windows-portability` (28 snapshot tests updated without the renderer change they presupposed), failing `trusted-control-plane` (structural deadlock) | MERGED_VIA_SUCCESSOR — commits reached main through #139; own trust changes and CI regressions not carried (see BABEL_CANONICAL_RECONCILIATION_FINAL.md) |
| #138 | replaced by `a922fb2…` (branch `codex/trust-root-upgrade-v1-20260904`) | TRUST_SUCCESSOR_REBUILT | TrustRootUpgradeV1 protocol, workflow-integration fixes, adversarial + offline end-to-end trust tests, [`TRUST_ROOT_UPGRADE.md`](../architecture/TRUST_ROOT_UPGRADE.md) | — | pre-upgrade verifier cannot authorize a trust-root change by construction; merged via the documented one-time bounded exception (PR-#127 mechanism) | MERGED as 31e7d7e via the documented one-time bounded exception |

## Valuable work preservation matrix

| Feature | Original PR | Final canonical path | Final PR/commit | Status |
| --- | --- | --- | --- | --- |
| Trusted execution supervisor + read port + lifecycle + identity | #120 | `babel-cli/src/authority/trustedExecution*.ts`, `babel-cli/src/agent/executionLifecycle.ts` | product successor (via #133 content) | preserved |
| Independent review receipts, challenge ledger, review V2 | #120/#133 | `babel-cli/src/evidence/independentReview.ts`, `scripts/verify-independent-review.mjs` | product successor | preserved |
| Breaker lane execution + isolated process + tamper fingerprint | #120/#126 | `babel-cli/src/agent/breakerContract.ts` | product successor (salvage from `pr/126` copies) | reimplemented (replayed verbatim) |
| Frozen verifier executable identity binding | #120/#126 | `babel-cli/src/agent/taskContract.ts`, `babel-cli/src/evidence/evidenceGraph.ts` | product successor | reimplemented |
| Revision-scoped evidence receipts (scope kinds, git binding, path safety) | #120/#126 | `babel-cli/src/evidence/revisionBoundReceipt.ts` | product successor | reimplemented |
| Journal run/contract binding + fsync durability | #120/#126 | `babel-cli/src/agent/taskEventJournal.ts`, `babel-cli/src/services/autonomousSWEArtifacts.ts` | product successor | reimplemented |
| Evidence-graph sealing + BLOCKED completion status | #120/#126 | `babel-cli/src/evidence/evidenceGraph.ts` | product successor | reimplemented |
| Trust-root adversarial hardening tests | #120 | `tools/tests/*` (new trust test suites) | #138 successor | superseded by stronger suites |
| Review-thread pagination (fail-closed) | #120 | `scripts/agent-pr-gate.ps1` | already on main (`c91be8f`) | already present |
| Provider failure receipts, retryability, transport conformance | #126 | `babel-cli/src/runners/*` | already on main (evolved) | already present |
| OpenAI-compatible neutral transport | #126 | — | rejected: main keeps one provider contract (`DeepInfraApiRunner` base with derived wrappers) | intentionally rejected |
| Model Intelligence (profiles, qualification, registry, resolver, routing observations, attribution, retention) | #126/#128/#130/#133 | `babel-cli/src/intelligence/*`, `docs/architecture/MODEL_INTELLIGENCE_QUALIFICATION_V1.md` | product successor | preserved |
| MI-012 timestamp-in-hash fix | #133 | `babel-cli/src/intelligence/*`, `docs/architecture/MODEL_INTELLIGENCE_ADDITIONAL_FINDINGS.md` | product successor | preserved |
| Interactive CLI readiness stabilization | #129 | `babel-cli/src/interactive/testing/realCliInteractiveProcess.test.ts` | product successor (via #133's stronger rewrite) | reimplemented |
| Trusted-root bootstrap (one-time) | #121 | `scripts/bootstrap-trust-root.ps1` (restricted), `docs/architecture/TRUST_ROOT_BOOTSTRAP.md` | already on main | preserved as historical |
| Trust-root upgrade protocol | #138 successor | `scripts/verify-trust-root-upgrade.mjs`, `docs/architecture/TRUST_ROOT_UPGRADE.md` | #138 | reimplemented (this campaign) |

## Intentionally rejected (not carried forward)

- #126 neutral OpenAI-compatible transport + `CURRENT_RUNTIME_INVARIANTS.md`
  invariant that OpenRouter must not derive from `DeepInfraApiRunner` (main's
  canonical provider architecture is the opposite; one provider contract).
- #126/#120 branding-only read-port trust plane as a *replacement* for
  main's registry-based plane (both coexist in the canonical stack).
- #130 simplified trust gate (main deliberately repaired the trust plane
  without it).
- Campaign-only tooling from #126: `tools/assert-clean-integration.mjs`,
  `build-final-consolidation-*.mjs` (superseded by canonical gating).
- #129 benchmark/experimental branch pollution (already merged to main
  elsewhere or stale, e.g. its older `campaignExecutors.ts`).
- Obsolete bootstrap stubs from #120 (empty key registry stub; PR117
  reconciliation record).

## Recovery documentation archived

Archived under [`archive/`](./archive/) with `ARCHIVED_SUPERSEDED` headers (content carried onto main from the superseded recovery branches; this PR introduces these files new on main):
`PR126_BOOTSTRAP_RECONCILIATION.md`, `PR120_PR126_RECONCILIATION.md`,
`REPOSITORY_CONSOLIDATION_LEDGER.md`, `TRUST_ORDER_ANALYSIS.md`.
`ADDITIONAL_FINDINGS.md` became
[`docs/architecture/MODEL_INTELLIGENCE_ADDITIONAL_FINDINGS.md`](../architecture/MODEL_INTELLIGENCE_ADDITIONAL_FINDINGS.md)
(content preserved, canonical location).

## Campaign completion note (2026-09-04)

The campaign concluded with #139 merged (main `da1e3e6932241a9ef5eaba9854f4b7c45471fa51`),
zero open PRs, all required checks green with no exception, and the first
green `trusted-control-plane` run in repository history. Final report:
[`BABEL_CANONICAL_RECONCILIATION_FINAL.md`](./BABEL_CANONICAL_RECONCILIATION_FINAL.md).
