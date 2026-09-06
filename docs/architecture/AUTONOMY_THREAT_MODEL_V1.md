<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-06
-->

# Babel Autonomy Threat Model V1

Adversarial model for **increasing autonomous engineering throughput** in
the solo-operator operating model: one human owner, AI agents as the primary
workforce, owner attention as the scarce resource. It exists so that autonomy
is widened only where the boundary model is explicit — never as an unmodeled
convenience.

Companions and boundaries:

- [TRUST_SIGNING_CUSTODY.md](./TRUST_SIGNING_CUSTODY.md) — threat model for
  the signing authorities themselves (custody, service, deployment). This
  document covers the engineering loop around it.
- [AUTONOMY_POLICY.md](../AUTONOMY_POLICY.md) — behavioral contract;
  `babel-cli/src/config/autonomyPolicy.ts` (Classes A–D) is the runtime
  authority for capability enforcement.
- [AUTONOMY_EVAL_MATRIX_V1.md](./AUTONOMY_EVAL_MATRIX_V1.md) — the
  adversarial evaluation matrix that tests the mitigations claimed here.
- [TRUST_ROOT_UPGRADE.md](./TRUST_ROOT_UPGRADE.md) — the signed tier for
  protected trust-root changes.

## Non-negotiable principles

These are campaign-derived invariants. Increasing autonomy must not weaken
them:

1. **A candidate cannot redefine its own admission test.** The merge gate is
   materialized from the *base* commit (`scripts/trusted-merge-gate.ps1`);
   candidate code is data, never the verifier. `pull_request_target`
   contexts check out the base SHA only and materialize the candidate as a
   detached data worktree.
2. **Normal CI and the trust verifier are different planes.** Normal CI runs
   candidate code in an unprivileged context with no sensitive secrets. The
   trust verifier runs base-controlled code and treats candidate artifacts
   as untrusted input. Arbitrary candidate-controlled code is never executed
   in a privileged context with secrets or write authority.
3. **Review independence comes from evidence channels, not reviewer count.**
   N approvals through the same conceptual lens are one review. Strong
   validation combines independent requirement interpretation, deterministic
   tests, runtime/behavioral evidence, and adversarial negative tests.
   Builder-authored tests alone are never sufficient evidence of
   requirement satisfaction.
4. **Ordinary review authority is machine-verified; root authority is
   owner-controlled.** The AUTONOMOUS tier is valid only for candidates that
   do not modify protected trust-root paths; trust-root changes require the
   signed CERTIFIED tier plus a supervisor-signed TrustRootUpgradeV1
   authorization bound to the exact base, head, protected path set, and
   protected diff digest.
5. **Security comes from structure** — least privilege, isolation, scoped
   credentials, protected refs, deterministic policy, independent evidence,
   audit trails, reversibility — never from confirmation dialogs.

## Threat register

Residual risk assumes the current `main` mitigations are active. "Owner
involvement" is the touch this threat currently forces on the human.

| # | Threat | Current mitigation | Residual risk | Desired mitigation | Owner involvement today |
| --- | --- | --- | --- | --- | --- |
| A1 | Malicious implementation agent smuggles backdoors into ordinary PRs | independent fresh-context review (AUTONOMOUS tier, reviewer ≠ builder), deterministic CI, exact-head binding | correlated reviewer blind spots; subtle logic backdoors passing tests | independent requirement/runtime evidence layer for significant changes (eval E3) | 0 (bounded by review quality) |
| A2 | Compromised or buggy worker corrupts a worktree or branch | isolated worktrees, non-main branches, ruleset protects `main`, force-push/non-fast-forward blocked | worker pollutes only its own lane | guarded worktree lifecycle + stale reaping (R2) | 0 |
| A3 | Reviewer/implementer collusion (same session, shared context) | reviewer must be a fresh-context isolated agent; reviewer_id ≠ builder_id enforced by the gate; evidence bound to exact base/head + diff digest | soft collusion via shared priors; copied narratives | review input = requirement + diff + evidence only, no builder narrative (rule 10 assurance-language section) | 0 |
| A4 | Correlated model error across reviewers | deterministic CI as a second evidence class; runtime/E2E evidence for significant work | same-family models failing on the same input | independent evidence channels doctrine (principle 3); frontier audit at milestones | ~1 prompt per milestone |
| A5 | Prompt injection from repository content (issues, PRs, file contents) | agents treat repo text as data; base-rooted gate never executes candidate-controlled content in privileged contexts | indirect instruction-following inside agent sessions | untrusted-content discipline in agent prompts; sandboxed tool classes (A–D) | 0 |
| A6 | Malicious PR executes candidate code in privileged CI | `pull_request_target` checks out base SHA only; candidate materialized as data; gate scripts run from base (`scripts/trusted-merge-gate.ps1`, `scripts/materialize-independent-review-receipt.ps1`) | new workflow files are not trust-root-protected on `main` (pre-existing gap; #144 protects the three required-check workflow files) | post-#144: workflow-file protection + new-file impersonation follow-up | 0 (fail-closed) |
| A7 | Check-name or workflow impersonation (fake "green" evidence) | gate resolves required checks per name+event+workflow bound to the exact PR head; "prefer latest successful per name" documented convention | pre-existing new-file impersonation variant (see A6 residual) | bind check authority to workflow path; post-#144 protected inventory covers required workflows | 0 (fail-closed) |
| A8 | Self-modifying verifier (candidate edits gate scripts to always pass) | gate scripts are protected trust-root paths; any modification forces the signed tier; verifier materialized from base; boundaries test asserts this | the bootstrap deadlock: the signed tier needs owner keys, so gate-improving PRs (#144) wait on the owner ceremony — accepted, deliberate | unchanged; the deadlock is the designed cost of non-self-authorizing change | explicit (owner key ceremony) |
| A9 | Secret exfiltration through privileged workflows | workflow permissions are `contents: read`, `pull-requests: read`; only the base-rooted transport receives the token; no checkout of candidate in privileged steps | token scope is repo-read — bounded blast radius | keep token scopes minimal; audit `pull_request_target` on every workflow change | 0 |
| A10 | Fake or forged review receipt | receipts require an Ed25519 signature verifying against the base-committed reviewer registry; challenge ledger with supervisor signature + state hash binding; unknown fields fail closed | registry write path itself is trust-root-protected (same as A8) | unchanged | explicit (key custody) |
| A11 | Forged or stale test evidence | evidence JSON bound to exact repository/PR/base/head + diff numstat digest; digest computed from the actual diff; transport stubs map to deterministic blockers (#144) | evidence content quality (an APPROVE from a shallow review) | evidence must cite executed checks; runtime evidence class for significant work | 0 |
| A12 | Merge-after-review drift (reviewed A, merged B) | gate checks exact head binding (PR head = reviewed head = local = remote) and base freshness; ceremony preflight fails closed on target-branch advance | queued-PR churn after every merge (cost, not safety) | merge-queue style batching (R4) | 0 |
| A13 | Unintended destructive command (reset --hard, rm, force push) | Class A–D tool classification + command semantics (`autonomyPolicy.ts`, `commandSemantics.ts`); sync exception has preconditions; untracked-file hazards documented in rule 05 | agent misjudgment inside its own lane | worktree lifecycle guards (R2) | 0 (lane-bounded) |
| A14 | Accidental production write / deploy | no production surface in this repo; deploy/publication is human-gated (campaign Phase 7; VISION scope rules) | future features adding deploy surfaces | keep deploy behind Class C/D + owner authority | explicit when applicable |
| A15 | Infinite retry / runaway loops | bounded-retry doctrine in AUTONOMY_POLICY (recovery must be semantic, not blind repetition); concurrency groups cancel in-progress runs | cost burn across many retries | retry budgets in the CI-repair loop (R5) | 0 |
| A16 | Runaway agent spawning / resource exhaustion | subagent delegation is bounded by rule 07; concurrency groups serialize gate runs | parallel fan-out without leases | lease registry (R2) bounds concurrent work per task | 0 |
| A17 | Duplicate task execution (two agents, same work) | no lease semantics on `main` today — path-exists collision check only | wasted parallel work, conflicting PRs | lease/registration (R2, eval E13) | 0 (waste, not danger) |
| A18 | Stolen GitHub token | token lives in the owner's environment; ruleset has zero bypass actors so a leaked token cannot skip required checks on `main`; protected tags enforced | token can push branches, comment, merge gate-green PRs | short-lived scoped tokens where feasible; consider a machine identity for merge with its own audit trail | explicit (credential rotation decision) |
| A19 | Stale worktree / mystery branches accumulate | none on `main` (removal manual) | confusion cost; disk cost | bounded cleanup exception (this campaign) + R2 reaping | 0 after cleanup automation |
| A20 | Branch confusion (work based on stale base) | `BASE_NOT_INVALIDATED` gate check; preflight expected-base-SHA check; serial landing discipline | rebase → re-review → re-evidence churn | coordinator auto-refresh (R4) | 0 |
| A21 | Evidence comment ambiguity (two distinct valid documents) | transport fails closed on `*_handoff_ambiguous` (>1 distinct bound docs) | wasted CI cycle | R1 tool replaces any prior comment for the same head (or refuses on conflict) | 0 |
| A22 | Missing/malformed evidence crashes the gate | pre-#144 `main`: strict-mode crash → `pr_gate_exception` fail-closed blocker; #144 makes handling deterministic (null-safe access + stub mapping + 44-case regression suite) | until #144 merges, HIGH-tier PRs without evidence produce an opaque blocker | merge #144 via its bootstrap path; R1 tool prevents the no-evidence case | 0 |
| A23 | Trust-root replacement by an agent (silent rekey) | impossible without owner custody: registries are protected paths, signature verification is base-rooted, recovery requires the break-glass protocol with ruleset snapshot/restore + bounded exception | social-engineering the owner via a crafted ceremony request | owner instructions always include never-paste-private-material guidance; verify tooling rejects wrong bindings | explicit (`OWNER_REQUIRED`) |
| A24 | Untrusted evidence transport (comment manipulation by any PR participant) | evidence comments are read as untrusted data; signatures and exact bindings decide; only distinct bound documents stage; ambiguous/missing fail closed | none beyond A10/A11 residuals | unchanged | 0 |

## Autonomy-increase gate

Before any workflow transition moves from `OWNER_REQUIRED` or
`EXCEPTION_APPROVAL` to autonomous operation, the change must demonstrate,
in review:

1. the threat register rows touched by that transition have their
   *desired* mitigation in place (not just the current partial one);
2. the operation is reversible or lane-bounded (cannot touch `main`
   directly, shared history, credentials, or other owners' work);
3. a deterministic check or eval (see the eval matrix) covers the failure
   mode that motivated the old human gate;
4. the residual risk is recorded in this document and accepted in the
   ledger as `AUTOMATABLE_NOW` rather than silently reclassified.

Anything that cannot satisfy all four stays at its current classification.
Weakening a security or evidence boundary to reduce owner touches is a
policy violation, not an optimization.
