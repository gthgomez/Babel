<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-06
-->

# Autonomy Campaign Record — Solo-Operator Engineering System

Execution record for the autonomy campaign ("one human owner, AI agents as
the primary engineering workforce, owner attention as the scarce resource").
North star: validated useful work per minute of owner attention. This record
is factual state as of its last verification date; merge outcomes land in the
verification log below and in
[DAILY_DRIVER_CAMPAIGN_STATUS.md](./DAILY_DRIVER_CAMPAIGN_STATUS.md).

## STARTING_STATE (reconciled from live GitHub + repo, 2026-09-05/06)

- `main` = `9657344729f8b9b79c929b12bb57b7c34d036685`; PR #144 (trust-plane
  fail-closed evidence + comment-triggered re-evaluation) open, MERGEABLE,
  blocked on the signed CERTIFIED tier: both registered authorities are
  `LEGACY_UNPROVEN_AUTHORITY` with proof-of-possession history `NOT_FOUND`
  and custody `AUTHORITY_STATUS_UNKNOWN` — a genuine owner boundary
  ([TRUST_SIGNING_CUSTODY.md](../architecture/TRUST_SIGNING_CUSTODY.md)).
  #144 is NOT weakened by this campaign; it stays on its bootstrap path.
- Ruleset `protect-main`: active, zero bypass actors, six required checks,
  review-thread resolution required.
- Local: five dead campaign worktrees, several stale remote `agent/*`
  branches, no worktree lease semantics, no evidence tooling.

## CURRENT_TRUST_MODEL (verified, unchanged by this campaign)

- Ordinary PRs: base-rooted `trusted-control-plane` gate materializes the
  verifier from the base commit; candidates are data. HIGH/CRITICAL tiers
  require independent review satisfied by a signed CERTIFIED receipt or — for
  non-trust-root candidates — AUTONOMOUS evidence bound to exact base, head,
  and diff numstat digest.
- Trust-root path changes: always the signed tier plus a supervisor-signed
  TrustRootUpgradeV1 authorization; a candidate can never redefine its own
  admission test.

## HUMAN_TOUCH_BASELINE

Full ledger: [AUTONOMY_HUMAN_TOUCH_LEDGER_V1.md](../architecture/AUTONOMY_HUMAN_TOUCH_LEDGER_V1.md).
Highest-ranked automation debt at campaign start: hand-built review evidence
JSON + close/reopen retrigger ritual (per PR, error-prone); no worktree
lifecycle; no branch cleanup authorization.

## ARCHITECTURAL_DECISIONS

1. Reconcile rather than duplicate: the Tier 0–5 model maps onto the enforced
   runtime taxonomy (Classes A–D) and gate RiskTier instead of forking them
   (`docs/AUTONOMY_POLICY.md` §Risk-tiered missions).
2. Routine review stays machine-verified (AUTONOMOUS tier); root-of-trust
   transitions stay owner-controlled — the distinction is now explicit in
   policy, the ledger, and the threat model.
3. Independence doctrine: independent evidence channels over reviewer count;
   the autonomy-increase gate in
   [AUTONOMY_THREAT_MODEL_V1.md](../architecture/AUTONOMY_THREAT_MODEL_V1.md)
   defines when a workflow transition may lose its human gate.
4. Automation increment R1 (evidence tooling) imports the gate module rather
   than copying digest semantics, so gate/tool parity is structural and
   survives future gate changes (including #144's canonical-ordering work).
5. Merge authority for Tier 0–2 is bounded-authorized by policy (rule 05
   amendment) with the deterministic gate as enforcement; trust-root merges
   remain owner authority.

## IMPLEMENTED_CHANGES

- #148 — policy core: risk tiers + human-touch discipline (policy), ledger,
  threat model + autonomy-increase gate, eval matrix E1–E16, frontier
  milestone review process, rule 05 bounded merge/cleanup authorization,
  doc registration (READMEs, CLAUDE.md Quick Traverse).
- #149 (this PR) — `scripts/agent-pr-evidence.ps1` + 29-assertion hermetic
  suite + evidence-transport documentation in the git operations guide.

## TESTS_AND_EVALS

- `pwsh tools/tests/test-agent-pr-evidence.ps1` — 29 passed, 0 failed
  (field bindings, gate-module digest parity, diff-binding sensitivity,
  stale-digest rejection, all fail-closed refusal paths).
- `tools/check-public-content-policy.ps1` — pass on both PRs.
- `npx tsc --noEmit` (babel-cli) — pass (#148 tree).
- Independent adversarial reviews: #148 round 1 — 2 blocking findings
  (classification-vocabulary inconsistency; E11 cited #144-only test as
  current coverage) — both repaired; #149 round 1 — 1 blocking finding
  (refusal advertised an unimplemented `-Replace`; `reviewed_at` made the
  idempotent path unreachable) — repaired (`-Replace` implemented;
  equivalence excludes `reviewed_at`), plus accepted notes (ASCII-only
  sources, gh exit-code checks, live-mode draft enforcement, comment-id
  reporting, guide wording).
- Eval matrix rows touched: E4 (review→fix loop exercised for real), E8/E14
  (evidence tooling covered), E11/E2/E3/E13 recorded honestly as PARTIAL/GAP.

## PRS_CREATED

- #148 — docs(autonomy) policy core. Risk tier 0.
- #149 (this PR) — feat(tools) evidence builder/transport. Risk tier 1.

## PRS_MERGED

Recorded after merge in the verification log below and in
[DAILY_DRIVER_CAMPAIGN_STATUS.md](./DAILY_DRIVER_CAMPAIGN_STATUS.md).

## DEFERRED_ITEMS (roadmap input, ledger-ranked)

- R2 worktree lease/registration + guarded reaping (eval E13 is a GAP).
- R3 retire close/reopen from documented practice after #144 lands.
- R4 merge-queue-style serial-landing relief (see
  [MERGE_CONTROL_PLANE_V1.md](../architecture/MERGE_CONTROL_PLANE_V1.md)).
- R5 deterministic CI-failure classification with bounded auto-retry.
- R6 `babel status`-shaped operator surface per
  `docs/architecture/operator-status-taxonomy.md`.
- Post-#144: workflow new-file impersonation residual (threat A6/A7).

## OWNER_ONLY_BOUNDARIES (unchanged and preserved)

Trust-root mutation, authority replacement, key-loss recovery, destructive
production operations, spend, legal/public commitments (Tier 5). The #144
merge waits on the owner key ceremony; nothing in this campaign bypasses or
weakens that boundary.

## HUMAN_TOUCH_AFTER (steady-state, per PR)

Routine/significant PR: 0 owner touches — branch, implement, verify, PR,
independent review, evidence (now tooling-assisted), retrigger, gate-green
merge, cleanup are all agent-executable under the amended rule 05. Milestone:
~1 adversarial frontier review prompt
([FRONTIER_MILESTONE_REVIEW_V1.md](../architecture/FRONTIER_MILESTONE_REVIEW_V1.md)).

## RESIDUAL_RISKS

- #144 unmerged: HIGH/CRITICAL PRs without evidence still hit the opaque
  `pr_gate_exception` on `main`'s base-side gate (fail-closed); the evidence
  tool makes this unlikely, not impossible.
- Check authority binds to check name + event + workflow, not workflow path:
  pre-existing new-file impersonation residual (recorded, threat A6/A7).
- Merge/cleanup actions run under the owner credential — account-level audit
  trails cannot distinguish operator from agent (ledger T1/A18).

## NEXT_HIGHEST_VALUE_ACTION

Merge #148 and #149 through the full gate, refresh #144 onto the new `main`
(fresh exact-head review + regenerated manifest) so the owner key ceremony
applies to current coordinates, then start R2 (worktree lease/lifecycle).
