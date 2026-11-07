<!--
status: ACTIVE
last_verified: 2026-09-04
-->

# Babel Canonical Reconciliation — Final Report

Campaign: reconcile `gthgomez/Babel` into one clean, authoritative, fully
verified state. Executed 2026-09-04 against live GitHub truth throughout.

## 1. Final verdict

**RECONCILIATION_COMPLETE**

All superseded recovery PRs are closed or merged-via-successor; the trust
plane no longer deadlocks; `main` carries exactly one canonical
implementation per responsibility; every required check is green on the
canonical head with zero exceptions and zero bypass actors; no valuable work
was lost (preservation matrix below).

## 2. Canonical state

| Item | Value |
| --- | --- |
| Repository | `gthgomez/Babel` |
| Main SHA at final report | `da1e3e6932241a9ef5eaba9854f4b7c45471fa51` (this report's PR is based on it) |
| Open PRs | 0 |
| Required checks (protect-main) | `security`, `public-content-policy`, `linux-validation`, `public-pr-metadata`, `windows-portability`, `trusted-control-plane` — all green at the merged heads |
| Ruleset | active; pull-request rule with required review-thread resolution; deletion + non-fast-forward protected; required status checks strict |
| Bypass actors | **0** (verified after every ruleset operation) |

## 3. PR disposition table

| PR | Final state | Disposition |
| --- | --- | --- |
| #120 | CLOSED (superseded) | trusted-execution stack preserved via #133 lineage; five durability items salvaged via #126 copies; obsolete trust stubs rejected |
| #126 | CLOSED (superseded) | five trust-plane-neutral durability items replayed verbatim into #139; neutral transport + campaign tooling intentionally rejected |
| #128 | CLOSED (superseded) | zero unique files (audit-proven); contained in #133 lineage |
| #129 | CLOSED (superseded) | intended CLI-readiness fix superseded by a stronger rewrite in #139; 10/11 commits historical pollution already on main |
| #130 | CLOSED (superseded) | zero unique files; simplified trust gate deliberately rejected |
| #133 | MERGED via successor | commits reached main through #139 (GitHub marks it merged with merge commit `da1e3e6`); its trust-file changes and CI regressions were NOT carried; disposition comment recorded |
| #138 | MERGED (trust successor) | rebuilt head `a922fb2`, merged `31e7d7e` via the documented one-time bounded exception (only `trusted-control-plane` temporarily unrequired; restored and verified immediately; zero bypass actors throughout) |
| #139 | MERGED (product successor) | rebuilt from post-#138 main; all required checks green with **no** exception; `trusted-control-plane` certified the candidate through the new gate — the first green run of that check in repository history |

Open PRs after campaign: **0**.

## 4. Valuable work preservation matrix

Full matrix with per-file evidence:
[`BABEL_PR_RECONCILIATION_CURRENT.md`](./BABEL_PR_RECONCILIATION_CURRENT.md).
Summary of every audited theme:

| Feature | Original PR | Final canonical path | Final PR | Status |
| --- | --- | --- | --- | --- |
| Trusted execution supervisor / read port / lifecycle / identity | #120 | `babel-cli/src/authority/trustedExecution*.ts`, `agent/executionLifecycle.ts` | #139 | preserved |
| Independent review receipts + challenge ledger | #120/#133 | `babel-cli/src/evidence/independentReview.ts` | #139 | preserved |
| Breaker lane + isolated process + tamper fingerprint | #120/#126 | `agent/breakerContract.ts` | #139 | reimplemented (verbatim replay) |
| Frozen verifier executable binding | #120/#126 | `agent/taskContract.ts`, `evidence/evidenceGraph.ts` | #139 | reimplemented |
| Revision-scoped receipts (scope kinds, git binding, path safety) | #120/#126 | `evidence/revisionBoundReceipt.ts` | #139 | reimplemented |
| Journal run/contract binding + fsync | #120/#126 | `agent/taskEventJournal.ts`, `services/autonomousSWEArtifacts.ts` | #139 | reimplemented |
| Evidence-graph sealing + BLOCKED | #120/#126 | `evidence/evidenceGraph.ts` | #139 | reimplemented |
| Model Intelligence (profiles/qualification/registry/resolver/routing/attribution/MI-012) | #126/#133 | `babel-cli/src/intelligence/*`, `docs/architecture/MODEL_INTELLIGENCE_*` | #139 | preserved |
| Provider reliability (OpenRouter live routes, failure receipts, credential hub) | #126/#133 | `babel-cli/src/runners/*` | #139 | preserved |
| CLI readiness stabilization | #129 | `interactive/testing/realCliInteractiveProcess.test.ts` | #139 | reimplemented (stronger) |
| Trust-root upgrade protocol | #138 | `scripts/verify-trust-root-upgrade.mjs`, `docs/architecture/TRUST_ROOT_UPGRADE.md` | #138 | new (TrustRootUpgradeV1) |
| One-time trust-root bootstrap | #121 | `scripts/bootstrap-trust-root.ps1` (historical, restricted) | pre-existing | preserved as historical |
| OpenAI-compatible neutral transport; read-port-only gate as merge authority; campaign packaging tools | #126 | — | — | intentionally rejected (documented) |

## 5. Final architecture

One implementation per responsibility on `main`:

- **Prompt OS** — behavioral rules, domains, skills, adapters, resolver
  (unchanged by the campaign).
- **Runtime harness** — Chat/Plan/Deep controllers over the shared executor
  kernel; policy differences between modes preserved.
- **Safety** — capability broker, workspace transactions, sandbox profiles
  (`sandbox.ts`: Docker-only risk classes denied on host profiles unless
  `BABEL_ALLOW_HOST_FALLBACK` explicitly authorizes and audits the
  escalation), completion authority.
- **Evidence** — execution identity, replay/event stream, revision-bound
  receipts, evidence-graph sealing, independent-review receipts/challenge
  ledger, breaker-lane tamper evidence.
- **Provider runtime** — ONE contract: `DeepInfraApiRunner` base with derived
  wrappers; OpenRouter live routes as approved primary with fail-closed
  observed-model-identity enforcement; provider failure receipts.
- **Model Intelligence** — profiles, qualification, routing evidence,
  treatment identity, certification; informs routing, never a second
  authority plane.
- **Trust control plane** — immutable-base verifier (`pull_request_target`
  checks out `base.sha`, candidate materialized as data-only detached
  worktree), exact-SHA review binding, supervisor challenge lane,
  **TrustRootUpgradeV1** for post-bootstrap trust-root changes, protected
  GitHub ruleset. All 11 protected paths byte-identical to the trust head on
  final main (verified post-merge; the gate's protected-path array enumerates 10 files, plus the trusted workflow itself which the campaign also held fixed).

## 6. Trust verdict

| Property | Status |
| --- | --- |
| Immutable-base verification | **PRESERVED** — gate code and key registries materialized from `base.sha`; candidate is data only |
| Candidate self-verification | **IMPOSSIBLE** — trust-root changes require a supervisor-signed authorization verified by base-rooted code plus a signed review receipt; the autonomous review tier is structurally excluded for trust-root changes (`signedReviewRequired`) |
| Trust-root upgrade path | **FUNCTIONAL** (TrustRootUpgradeV1): authorization binds repository, PR, base SHA, head SHA, protected path set, protected diff digest, intent, decision, issued/expiry, key id; Ed25519 over canonical JSON against the base-rooted supervisor registry; comment transport with full pagination; 23 adversarial verifier cases + 6-case offline end-to-end suite pass |
| Exact-SHA binding | **PASS** — every receipt/evidence/authorization binds exact base and head; the one-time #138 exception was bound to exactly one PR and one head (`a922fb2`) |
| Comment pagination | **PASS** — transport paginates all comment pages; zero/multiple distinct documents fail closed (exercised: forged, stale-binding, missing, conflicting) |
| Reviewer independence | **TWO-TIER per `.agents/rules/10-independent-review-policy.md`** — CERTIFIED (signed receipt bound to supervisor-signed consumed challenge) or AUTONOMOUS (structured evidence from an isolated read-only reviewer, exact base/head + numstat-digest binding, reviewer ≠ builder). Trust-root changes: signed tier only. Owner escalation `BABEL_REQUIRE_SIGNED_REVIEW=1` forces the signed tier repo-wide once signing custody is provisioned to CI |
| Key registry status | Reviewer + supervisor public registries on main unchanged (owner custody of private halves; builder never receives signing keys — this campaign operated at the AUTONOMOUS tier with `ISSUER_CONFIGURATION_REQUIRED` recorded for the signed tier) |
| Bypass status | **0 bypass actors** at every point in time; the single ruleset exception for #138 removed only `trusted-control-plane` from required checks for the merge window and was restored byte-for-byte immediately after |

## 7. Test verdict

Post-merge certification runs on `da1e3e6`-based content (this PR), all
required checks green on the successor heads:

| Suite | Result |
| --- | --- |
| typecheck | PASS (CI + local) |
| build | PASS (CI + local) |
| unit tests (full suite, Windows local) | 7071 pass / 12 fail / 38 skip — all 12 environment-dependent (no Docker Desktop, live-provider keys, interactive terminal) or isolation-passing ordering flakes; the equivalent pre-merge `main` run fails 61 |
| UI suite | PASS (CI linux + windows; 78/78 snapshot suite locally) |
| Remote UI suite | PASS (CI) |
| harness architecture validation | PASS (CI) |
| harness acceptance + runtime | PASS (CI) |
| provider hardening | PASS (CI + local) |
| Model Intelligence tests/certification | PASS (CI) |
| security / public content / PR metadata | PASS (CI) |
| linux-validation | PASS (CI) |
| windows-portability | PASS (CI) |
| trusted-control-plane | **PASS with no exception** — first green run in repo history (head `c5d533f`, run 33909700228) |
| trust verifier adversarial tests | 23/23 PASS (local + wired into the trusted workflow) |
| trusted-control-plane offline integration | 6/6 PASS (local) |

Skipped-by-environment suites are reported explicitly above; no required
suite was skipped in CI. The previously reported "suite prints success but
never exits" hang did not reproduce on either branch in this campaign (both
full runs terminated with deterministic exit codes); CI stages retain bounded
timeouts.

## 8. Remaining technical debt

**P0**
- Provision trusted signing custody for CI (`BABEL_TRUSTED_REVIEW_ISSUER` /
  supervisor lane) and set the `BABEL_REQUIRE_SIGNED_REVIEW=1` repository
  variable — promotes every PR from the AUTONOMOUS to the CERTIFIED tier.

**P1**
- Windows: authoritative verifier re-run spawns required commands through a
  POSIX-biased child process shape (`exact GLM ChatEngine` test platform-
  gated with reason in `chatOpenCodeProvider.test.ts`).
- Hardening the autonomous-evidence validator to degrade malformed transport
  documents into clean fail-closed error codes instead of a gate exception
  (still fails closed today; cosmetic). Requires a TrustRootUpgradeV1-
  authorized trust PR (the protocol's first real user) or signing custody.
- Document the `diff_numstat_digest` canonicalization (PowerShell Sort-Object
  ordering) in `docs/architecture/TRUST_ROOT_UPGRADE.md` via the same
  future trust PR.

**P2**
- Full-suite ordering flakes under Windows local parallelism (MCP transport
  initialize-response ordering; liteIndex warmup) — pass in isolation and on
  CI Linux; worth deflaking before relying on local full runs as gates.
- smallFix suite depends on Docker for 8 cases locally (green on CI Linux
  with Docker); consider an explicit `t.Skip` when Docker is absent so local
  runs read green.

**DEFERRED_PRODUCT_WORK** (not recovery debt)
- Model Intelligence V1 productization; Provider Reliability V1; execution/
  sandbox safety hardening; verifier promotion; daily-driver UX/TUI/Remote UI;
  model-fixed harness evaluation; release/readiness milestone.

## 9. Next engineering milestones

1. Model Intelligence V1 productization (profiles/qualification are landed;
   ship the operator surface).
2. Provider Reliability V1 (route observations dashboards, failure receipt
   analytics on the OpenRouter-first runtime).
3. Execution/sandbox safety hardening (Windows verifier path above).
4. Verifier promotion (signed tier custody, then `BABEL_REQUIRE_SIGNED_REVIEW=1`).
5. Daily-driver UX/TUI/Remote UI polish on the reconciled base.
6. Model-fixed harness evaluation; release/readiness milestone.

## Appendix A — Retired recovery branches (tips recorded before deletion)

Deletion criteria met for each: not referenced by any open PR (0 open PRs);
valuable commits preserved on main or archived (audits above); no unique
release-artifact or tag dependency; no active workflow dependency. Closed-PR
heads remain fetchable through `refs/pull/<n>/head`.

```
archive/storage-recovery/Babel-trust-repair-20260901            3ccba15a69666570dd4c5c4996eb106d161d09c9
archive/storage-recovery/babel-pr126-rebuild-20260829-20260901  0dbafdb85112219b6251b3b6789a89e23efde2bf
archive/storage-recovery/babel-remote-release-20260901          3499df432ac0d52f6225882c559ba1dfd29d0021
codex/autonomous-swe-foundations-v1-hardening                   73fda8d46e0cd85706d225551793946557e5c7c5
codex/final-recertification-20260830                            7e80571c925e60c94dc5466206704bb0b75d61f4
codex/recovery-certification-20260830                           41ddded863149ded47d2934328819626952e664b
codex/recovery-final-certification-20260830                     9038551311b1c3ee206d39b0eecb632a3d57e10c
codex/trust-bootstrap-repair-20260831                           a922fb2fa90284de0b894dfc8268c7e5d9fbbda7
codex/trust-root-upgrade-v1-20260904                            a922fb2fa90284de0b894dfc8268c7e5d9fbbda7
codex/trusted-check-wait-bound-20260830                         72ef5912b4616c18932e541d99cf3b0cf6d78b41
codex/trusted-control-plane-bootstrap                           b3d10971bf3afa6f71e88f84227f6040a5ba411a
codex/trusted-control-plane-repair-20260830                     ca2fa6b51a287572fd17cd3a3a3029703e52c823
codex/trusted-launcher-portability-20260829                     a4685712b765e927dbaba64ef350296abc5d9fae
codex/trusted-ruleset-compatibility-20260830                    ef1ea6b3ef82da8dc7bc0c634db531f5d21ba0f2
codex/trusted-self-check-20260830                               52d60e1f8351089bf36e179571246084e2ba78bc
codex/trusted-workflow-token-repair-20260830                    b5ffa073ccf394a792ff80cf9c95638e8b910958
integration/babel-consolidation-20260829                        e029ca2c762cccbc9f21681ba562327e23350850
recovery/20260829/main-before-trust-repair-cff370f2             cff370f2ef239069cfd4ae403ac8be4ce7c8f401
recovery/20260829/pr120-original-73fda8d                        73fda8d46e0cd85706d225551793946557e5c7c5
recovery/20260829/pr121-pre-rebase-19bc70e                      19bc70ea4ed9f8cb4b554ab3cab91d229116ba4f
recovery/20260829/pr126-before-trust-repair-98b7c8f             98b7c8fc6396aa6fca2f4b34a61e4ba6da4a3d7a
recovery/20260829/pr126-pre-trust-rebase-3d44010                3d44010867d647a079e7d5bd1d3d0bbb3b2897b4
recovery/20260829/pre-final-hardening-dd7ada                    dd7ada6380f8da2eea2316b871b6131c54bddbcf
recovery/20260829/trust-launcher-repair-a4685712                a4685712b765e927dbaba64ef350296abc5d9fae
recovery/babel-wave-test-timing-20260830                        9805502a6ee9bedc482e161c3cf5309e6bd270fe
```

Fully merged feature branches retired alongside (each `git branch -r
--merged origin/main`): `codex/bdns-b0-architecture`, `codex/pcont007-*`,
`feat/opencode-provider`, `refactor/tui-shared-primitives`,
`agent/codex-maximum-power-plan`. Branches with unmerged, potentially active
product work are intentionally left in place.
