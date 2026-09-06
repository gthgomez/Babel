<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-06
-->

# Babel Autonomy Human-Touch Ledger V1

Measurable ledger of every point in the engineering loop where the human
owner currently interacts (or where agent-only friction is large enough to
cost owner attention). It exists to make the north-star metric —
**validated useful work per minute of owner attention** — auditable, and to
rank automation debt by owner time saved rather than by process elegance.

Relationship to other authority documents:

- [AUTONOMY_POLICY.md](../AUTONOMY_POLICY.md) — behavioral contract this
  ledger refines. The runtime taxonomy
  (`babel-cli/src/config/autonomyPolicy.ts`, Classes A–D) remains
  authoritative for capability enforcement; this ledger classifies
  *workflow* touch points, not tool capabilities.
- [TRUST_SIGNING_CUSTODY.md](./TRUST_SIGNING_CUSTODY.md) — governs the
  signing-authority touch points (root-of-trust transitions) referenced
  below.
- [AUTONOMY_THREAT_MODEL_V1.md](./AUTONOMY_THREAT_MODEL_V1.md) — the
  boundary model that constrains which touch points may be automated.

## Classification vocabulary

Each touch point is classified exactly one of (state — what the touch point
is today):

| Classification | Meaning |
| --- | --- |
| `OWNER_REQUIRED` | Genuine authority or judgment the system cannot safely grant itself. Keep; make rare, consolidated, and well-prepared. |
| `AUTOMATION_DEBT` | Routine or friction cost with no authority content. An engineering defect; schedule it. |
| `UNNECESSARY_PERMISSION_GATE` | A policy or habit that asks the owner for permission where bounded autonomy plus deterministic evidence would be safer and cheaper. |
| `INTENTIONALLY_MANUAL` | Deliberate human involvement for judgment, ceremony, or enjoyment value. Declared, not accidental. |

Every `AUTOMATION_DEBT` and `UNNECESSARY_PERMISSION_GATE` item additionally
carries exactly one automation disposition (what to do about it):

| Disposition | Meaning |
| --- | --- |
| `AUTOMATABLE_NOW` | The [AUTONOMY_THREAT_MODEL_V1.md](./AUTONOMY_THREAT_MODEL_V1.md) autonomy-increase gate is satisfiable with current mechanisms; schedule the work. |
| `AUTOMATABLE_LATER` | Automation is possible but depends on a missing mechanism or a prerequisite landing (recorded in the item's notes). |
| `KEEP_MANUAL` | Stays manual for a documented authority or safety reason that justifies the recurring cost. |

Any recurring manual task is presumed `AUTOMATION_DEBT` with disposition
`AUTOMATABLE_NOW` unless a documented authority or safety reason establishes
a different classification or disposition.

## Ledger (audited against `main` @ `9657344`, 2026-09-05/06)

| Id | Trigger | Current mechanism | Classification | Frequency | Notes |
| --- | --- | --- | --- | --- | --- |
| T1 | gh credential provisioning on a machine | outside repo surface (`docs/guides/AGENT_GIT_OPERATIONS.md` documents the repo-local helper swap) | `INTENTIONALLY_MANUAL` | per machine | Machine-level bootstrap; not automatable by the repo itself. |
| T2 | Worktree/branch creation | `scripts/agent-worktree.ps1` (`create`/`list`) | `AUTOMATION_DEBT` (agent-side) | per task | No owner touch. No lease/registration semantics; collisions surface only as path-exists errors; no stale detection. Disposition: `AUTOMATABLE_LATER` (R2; prerequisite: post-#144 landing). |
| T3 | Commit-time secret/path screening | `.githooks/pre-commit.ps1` (optional locally; CI authoritative) | `AUTOMATION_DEBT` (agent-side) | per PR | All failure modes agent-fixable. |
| T4 | Push preflight (content policy, secret scan, typecheck, ratchet warning) | `.agents/rules/05-github-workflow.md` minimum local preflight; `tools/preflight-ratchet.ps1` | `AUTOMATION_DEBT` (agent-side) | per PR | Agent-fixable. |
| T5 | PR creation | draft-by-default + PR body contract; `public-pr-metadata` check | `AUTOMATION_DEBT` (agent-side) | per PR | Over-budget PRs (>1,500 lines / 30 files) require semantic split or `EXCEPTION_APPROVAL` — keep; it is a review-quality gate, not a permission ritual. |
| T6 | Independent-review evidence for the merge gate | agent hand-builds `autonomous_review_evidence_v1` JSON (numstat digest, exact base/head binding, strict field allow-list) and posts it as a PR comment; no repo tooling builds or posts it | `AUTOMATION_DEBT` — **highest-ranked** | once per head SHA (every push invalidates) | A schema mistake costs a full CI cycle. Eliminating this is the top automation item (R1). Disposition: `AUTOMATABLE_NOW` — implemented in this campaign (`scripts/agent-pr-evidence.ps1`). |
| T7 | Gate re-evaluation after evidence lands | close + reopen the PR (fires `reopened` → fresh `pull_request_target` run re-reads comments at execution time) | `AUTOMATION_DEBT` | 1–3× per PR | #144 replaces this with an `issue_comment` trigger; until it merges, close/reopen is the sanctioned ritual. A failed-run re-run is expected to work as a mechanical retrigger (the transport re-reads comments at execution time) but is not yet verified empirically; close/reopen is the verified ritual. |
| T8 | Draft → ready conversion | gate blocks drafts (`NO_DRAFT`) | `AUTOMATION_DEBT` (agent-side) | per PR | Sequencing rule: ready → evidence → retrigger. |
| T9 | Merge of a gate-green ordinary PR | required checks green at exact head + threads resolved + review evidence valid; merge is then a normal `gh pr merge` (ruleset requires 0 approvals, no bypass actors) | `AUTOMATION_DEBT` (disposition `AUTOMATABLE_NOW` — resolved by the [rule 05 amendment](../../.agents/rules/05-github-workflow.md) in this change set) | per PR | Merge authority for Tier 0–2 is policy-authorized; Tier 3 additionally requires the frontier review record; trust-root merges stay `OWNER_REQUIRED`. |
| T10 | Trust-root path changes | signed CERTIFIED receipt + supervisor-signed `TrustRootUpgradeV1`; signing custody currently unresolved (`AUTHORITY_STATUS_UNKNOWN`) | `OWNER_REQUIRED` — genuine boundary | rare | The owner key ceremony is the legitimate unlock. Open PR #144 waits on it. Never weakened from inside a candidate. |
| T11 | Branch/worktree cleanup after merge | previously blocked by the blanket no-delete rule; now covered by the bounded cleanup exception | `AUTOMATION_DEBT` (was `UNNECESSARY_PERMISSION_GATE`) | per PR | Stale branches and worktrees accumulated under the old rule (several stale remote `agent/*` branches and five dead worktrees observed 2026-09-05). |
| T12 | Local `main` sync / backup branch retirement | documented sync exception; backup branches kept until owner confirmation | `INTENTIONALLY_MANUAL` (conservative) | per campaign | Backup deletion touches shared-looking refs; keeping owner confirmation here is proportionate. |
| T13 | Milestone judgment (major feature, release candidate, architecture migration) | frontier review packet + one owner prompt to Sol/Astra ([FRONTIER_MILESTONE_REVIEW_V1.md](./FRONTIER_MILESTONE_REVIEW_V1.md)) | `INTENTIONALLY_MANUAL` | per milestone | Target: approximately one adversarial review prompt per milestone. |
| T14 | Root-of-trust transitions (key replacement, recovery, authorized identities) | owner cryptographic ceremony per [TRUST_SIGNING_CUSTODY.md](./TRUST_SIGNING_CUSTODY.md) / [TRUST_ROOT_RECOVERY.md](./TRUST_ROOT_RECOVERY.md) | `OWNER_REQUIRED` | rare, by design | The system must prepare everything else so the owner act is a single consolidated step. |

## Ranked automation debt (roadmap input)

Ranked by owner-time saved × frequency × feasibility:

1. **R1 — Evidence assembly + retrigger tooling** (T6/T7/T8): a repo script
   that builds `autonomous_review_evidence_v1` with gate-identical
   validation (importing the gate module rather than duplicating digest
   semantics), posts it, and retriggers the gate. Eliminates the most
   error-prone per-PR ritual. Implemented in this campaign
   (`scripts/agent-pr-evidence.ps1`).
2. **R2 — Worktree lease/registration + stale reaping** (T2/T11): task
   registry preventing duplicate concurrent work, safe guarded removal,
   stale detection. Post-#144 (the worktree helper is not a protected path
   on `main`, but the trust-plane refresh should land first to avoid
   avoidable base churn).
3. **R3 — Post-#144 lifecycle simplification** (T7): after the
   comment-triggered re-evaluation merges, retire close/reopen from
   documented practice; keep evidence-then-rerun as the fallback.
4. **R4 — Serial-landing cost** (stale-base churn): merge-queue-style
   batching or a coordinator that rebases + re-evidences queued PRs
   automatically. Larger item; design note in
   [MERGE_CONTROL_PLANE_V1.md](./MERGE_CONTROL_PLANE_V1.md) (merge-train
   state machine).
5. **R5 — CI failure classification loop**: extend the ci-triage skill into
   a deterministic classifier (real defect / test defect / flake / infra /
   stale base / policy block) with bounded auto-retry for infra flakes.
6. **R6 — Status surface** (`babel status`-shaped): one command answering
   what is running, blocked, ready to merge, and what genuinely needs the
   owner, per `docs/architecture/operator-status-taxonomy.md`.

## Metric definitions

Measured from observable artifacts (PR comments, workflow runs, merge
records, ref states) — never from agent self-report:

| Metric | Definition |
| --- | --- |
| `owner_touches_per_pr` | count of owner-originated actions (comments, clicks, approvals, ceremony steps) attributable to a PR, from audit trails |
| `owner_minutes_per_milestone` | sum of owner-attributed interaction durations across a milestone's PRs |
| `autonomous_completion_rate` | share of work items reaching merged-with-green-gates without `OWNER_REQUIRED` escalation |
| `review_fix_cycles` | reviewer-finding → fix → re-review iterations per PR |
| `ci_repair_rate` | share of red CI runs repaired without owner input |
| `reopen_rate` | close/reopen retriggers per PR (target: near zero after #144) |
| `post_merge_regression_rate` | post-merge main check failures attributable to a merged PR |
| `agent_restart_recovery_rate` | share of interrupted tasks resumed from persisted state without work loss |
| `stale_worktree_count` | worktrees with no active lease and no open PR (target: zero after R2) |
| `duplicate_work_rate` | tasks started twice concurrently for the same logical work item |
| `frontier_review_blocker_rate` | blocking findings per frontier milestone audit |
| `time_from_ready_to_merge` | elapsed time from all-gates-green to merge |

## Steady-state targets

| Work class | Owner touches |
| --- | --- |
| Routine PR (docs, formatting, small fixes) | 0 |
| Ordinary/significant engineering PR | 0 |
| Major milestone | ~1 (frontier adversarial review prompt) |
| Trust-root or credential-recovery event | explicit owner act, consolidated |
| Financial / legal / destructive external action | explicit owner act |
