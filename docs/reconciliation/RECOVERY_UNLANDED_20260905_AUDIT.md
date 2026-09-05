# Recovery Audit — Unlanded Work of 2026-09-05

<!--
status: ACTIVE
last_verified: 2026-09-05
-->

Reconciliation record for the unlanded recovery-era work discovered in the
local checkout during the 2026-09-05 tree cleanup, preserved as
`recovery/unlanded-20260905` @ `f0d38614196799b4e8e5ed63f40a42fdc8211b70`
(stash `0d48c6e93160daf41b2ff5ffc2252d9176d1b4b7`, base `213e7469…` — an
ancestor of `main`; index parent `a06cb9d7…`; untracked parent `32e31208…`).
Independent backups: git bundle + source ZIP with SHA256 checksums in the
local recovery workspace `babel-recovery-20260905` (never published to the
public repository). Tree-equality proof: `git diff 0d48c6e9 f0d3861` is
exactly the 14 untracked files as additions, zero tracked-file drift.

Authorities applied, in order: (1) current GitHub `main`; (2) merged history
and trust policy; (3) recovered work as salvage source only. Every recovered
component was classified on evidence from a three-way reconstruction
(recovery delta vs base, base vs current main, recovery vs main), not on
filename similarity.

## Executive outcome

- Nothing in the recovery set was already landed or superseded by `main`:
  `git diff 213e7469 origin/main` is empty for every recovered path, and no
  equivalent functionality exists under other names (verified per file below).
- The recovered work splits into three clean value streams, landed/reviewed
  as three PRs with distinct authority boundaries:
  - **Recovery & Campaign Integrity (PR-A)** — autonomy/review policy
    documents, rules and adapter alignment, campaign-record corrections,
    epistemic-honesty invariants, campaign-state drift guard,
    test-environment repairs.
  - **Recovered Ordinary Runtime Value (PR-B)** — Acceptance V0 engine
    hardening + its CI wiring (closes a real coverage hole: the acceptance
    engine never ran in CI), and the builder-side independent-review
    coordinator CLI (the missing requesting half of the trust plane).
  - **Trust-Root Hardening (PR-C)** — the missing-evidence gate crash fix +
    regression matrix + lifecycle/assurance corrections. Protected paths →
    TrustRootUpgradeV1 authorization required; engineering prepared, merge
    blocked on legitimate signing authority.
- The temporary stash is retained (not dropped) until all three PRs land
  and the backups are re-verified.

## Preservation Matrix

### Recovered untracked files (14)

| Recovered file | Semantic intent | Main equivalent? | Conflicts | Trust implications | Verdict | Destination |
| --- | --- | --- | --- | --- | --- | --- |
| `.agents/rules/10-independent-review-policy.md` | Canonical independent-review routing: reviewer classes, blocker taxonomy (`MISSING_REVIEWER`…`VERIFICATION_FAILURE`), `babel review certify --pr` production path, custody rules | None on main — but `TRUST_ROOT_UPGRADE.md:155`, `BABEL_CANONICAL_RECONCILIATION_FINAL.md:106`, and this status doc **dangling-reference** it | None; predates the AUTONOMOUS tier | Doc-only; not a protected path. Semantics match the implemented CERTIFIED tier; extended with the implemented AUTONOMOUS tier + trust-root exclusion before landing | **MISSING_CANONICAL** (restored with adaptation) | PR-A |
| `docs/AUTONOMY_POLICY.md` | Prose autonomy contract: agent-owned routine engineering, user-reserved authority boundaries, security invariants | None; main enforces the same contract via `babel-cli/src/config/autonomyPolicy.ts` (Classes A–D) which the prose never mentions | None textual | None | **DOC_ONLY_VALUE / SALVAGE_ADAPT** — landed with an enforced-counterpart cross-reference so the prose and enforced canons point at each other | PR-A |
| `docs/AUTONOMY_POLICY_CHANGELOG.md` | 18-entry review ledger (AP-01…AP-18) matching the rules diff exactly; runtime-debt disclosure | None | Describes state @ `4fd9c35` (on main's history); test counts/§9 debt stale vs current main | None | **DOC_ONLY_VALUE / SALVAGE_ADAPT** — landed with a point-in-time header note | PR-A |
| `babel-cli/src/services/reviewProvenance.ts` | ed25519 `ReviewExecutionAttestation` signing/validation (canonical-JSON digest, reviewer≠builder, all-false capability profile, freshness window); holds no keys | None | None | None — takes a caller-provided key; no custody | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/services/reviewServiceTransport.ts` | Process-boundary JSON transport for trusted roles (`shell:false`, timeout); builder never receives keys | None | None | Implements the custody boundary the policy mandates | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/services/reviewSupervisor.ts` | Challenge-lifecycle interface (issue/get/revoke); backend-injected, frozen | None | None | None — interface only, no signing backend | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/services/independentReviewBroker.ts` (+`.test.ts`, 4 tests) | Certification state machine: exact 40-hex base/head, read-only reviewer invocation, verdict binding (reviewer≠builder, PASS⇒no blockers), attestation-required-then-issuer, blocker taxonomy | None — main has only the verifier/gate half (scripts/), not the requester half | None; compiles against main's already-landed `src/evidence/independentReview.ts` (blob-identical between base and main) | Builder-side coordinator; cannot mint gate-valid receipts (gate re-verifies against base-rooted keys) | **MISSING_CANONICAL** | PR-B |
| `babel-cli/src/services/independentReviewProvider.ts` | Live reviewer lane: exact PR/diff resolution, untrusted-input prompt hardening, execution attestation with all-false capability profile | None | Reviewer runs in-builder via `runWithPrimaryOnlyFallback` unless an external provenance signer is configured — documented caveat | None (unsigned verdicts can never be certified) | **SALVAGE_ADAPT** (caveat documented in-code) | PR-B |
| `babel-cli/src/services/trustedReviewIssuer.ts` (+`.test.ts`) | Certification adapter: re-validates attestation cryptographically, PASS-only, challenge TTL matching main's gate, mint via injected authority | None | `createFileBackedTrustedReviewAuthority` is the only key-adjacent export — pass-through to main's `createIndependentReviewAuthorityV1`, doc-fenced to trusted service processes, unused in the builder path | Custody model consistent with main; fenced export documented | **SALVAGE_ADAPT** (guard comments kept explicit) | PR-B |
| `babel-cli/src/commands/independentReviewCommands.ts` | `babel review certify --pr <number>` CLI wiring; trusted roles configured via env-injected external processes; fixture-only `--candidate` guard | None | None | None | **MISSING_CANONICAL** | PR-B |
| `babel-cli/src/acceptance/architecture.test.ts` | Patch-blindness as architecture: planner/compiler import-scan invariant + synthesis family assertions | None (not runnable against main — imports three symbols main lacks) | Requires the engine delta | None | **SALVAGE_EXACT as a bundle with the engine delta** | PR-B |
| `babel-cli/src/acceptance/hardening.test.ts` | Risk-scaled sufficiency profiles, exact-state binding, verifier-authority admission, escrow isolation invariants (5 tests) | None (same dependency) | Same | None | **SALVAGE_EXACT as a bundle** | PR-B |

### Recovered tracked modifications (26)

| Recovered file | Semantic intent | Main equivalent? | Conflicts | Verdict | Destination |
| --- | --- | --- | --- | --- | --- |
| `babel-cli/src/acceptance/types.ts` (+87) | Risk vocabulary, 9 new oracle kinds, evidence-influence ladder, isolation/synthesis families, preregistered `SufficiencyProfileV1`, `AcceptanceExactStateBindingV0`, provenance fields | None — main byte-identical to base | None; `git apply --check` clean | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/validation.ts` (+81) | Zod mirror of the new vocabulary (strict schemas) | None | None | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/artifacts.ts` (+27) | Risk + provenance propagation into frozen, hash-covered snapshots/links | None | None | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/evidenceAdmission.ts` (+85) | Influence derivation; 4 new rejection reasons; verifier authority must be explicit (not merely not-false); BDNS admission hardening | None | Existing `acceptance.test.ts` expectations preserved (verified against symbol usage) | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/sufficiency.ts` (+197) | Frozen risk-scaled sufficiency profiles; "supported" now requires profile satisfaction (independent + distinct + bound evidence), never implementor-controlled sole support | None | None | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/oraclePlanner.ts` (+110) | Patch-blind counterexample synthesis from the frozen snapshot (H1 seam), family-tagged, command-free | None | None | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/escrow.ts` (+57) | Restricted-oracle isolation capability: build-time throw + validation code `restricted_boundary_not_isolated` | None | None | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/acceptance/index.ts` (+1) | Export escrow | None | None | **SALVAGE_EXACT** | PR-B |
| `babel-cli/package.json` (+1) | `test:acceptance-v0` script | Main has the fixture script but no suite script | None | **SALVAGE_EXACT** — closes a real CI hole: `src/acceptance/acceptance.test.ts` (1,093 lines) never executes in any CI workflow today | PR-B |
| `.github/workflows/typecheck.yml` (+6) | Wire "Run required Acceptance V0 suite" into both validation jobs | None | None (different hunks than the PR-A drift-guard step) | **SALVAGE_EXACT** | PR-B |
| `babel-cli/src/commands/workflowCommands.ts` (+2) | Register `registerIndependentReviewCommands` | None | **Build-breaker if landed without the review feature files (F1)** | **SALVAGE_ADAPT** — lands with PR-B's feature set | PR-B |
| `babel-cli/src/runners/deepInfraApi.ts` (~3) | Drop hardcoded `messages: []`; guard envelope-message passthrough | None | None; self-contained | **SALVAGE_EXACT** | PR-B |
| `AGENTS.md` (+7/−4) | "Safe autonomy over ceremony" value; uncertainty-as-investigation; autonomy-policy pointer; rule-10 layout entry; failed-checks-are-repair-work stance | None on main; main's own `ciRepair.ts` runtime already enforces the repair stance | Requires rule-10 + AUTONOMY docs in the same set (else dangling links) — landed together | **SALVAGE_EXACT** | PR-A |
| `CLAUDE.md` (+3) | Autonomy-policy lookup row + "does not create capabilities" clause | None | Bundle dependency on AUTONOMY docs | **SALVAGE_EXACT** | PR-A |
| `.agents/rules/06-autonomous-goal-clearance.md` (+3/−2) | G1 = infer ordinary criteria from repository evidence; Uncertainty loop; one-question rule reserved for real authority boundaries | None textual; main's `taskClarity.ts` already enforces the semantics | None | **SALVAGE_EXACT** | PR-A |
| `GEMINI.md` (±1) | Stage only the deterministic ship set (fixes an immediate-commit contradiction) | None | None | **SALVAGE_EXACT** | PR-A |
| `INTEGRATION.md` (+4) | Autonomy-contract pointer | None | Bundle dependency | **SALVAGE_EXACT** | PR-A |
| `LLM_COLLABORATION_SYSTEM/RULES_CORE.md` (+8/−2) | Canonical-policy pointer; planning is not approval; "Uncertainty and Recovery" ladder | None | Bundle dependency | **SALVAGE_EXACT** | PR-A |
| `LLM_COLLABORATION_SYSTEM/RULES_GUARD.md` (+5/−3) | ACT = mission-authorized minimal actions; STOP reserved for hard boundaries | None | None | **SALVAGE_EXACT** | PR-A |
| `LLM_COLLABORATION_SYSTEM/RULES_SHARED_ALL_MODELS.md` (+4/−2) | Autonomous-by-default canon above Compensatory Agency | None | None | **SALVAGE_EXACT** | PR-A |
| `01_Behavioral_OS/OLS-v11-Core-Unified.md` (+7/−5) | Autonomy inside granted scope; recover-before-STOP; handshake wording | None | None | **SALVAGE_EXACT** | PR-A |
| `03_Model_Adapters/Claude_AntiEager.md` (+18/−27) | Remove ACT-token ceremony; evidence-over-assumption discover-first; **fixes two stale `OLS-v10` references → v11** | None (v10 files still exist so refs are not dangling, but v11 supersedes v10) | None | **SALVAGE_EXACT** | PR-A |
| `03_Model_Adapters/Gemini_LongContext.md` (+8/−10) | Same pattern for the Gemini adapter | None | None | **SALVAGE_EXACT** | PR-A |
| `03_Model_Adapters/Scout_Orchestrator.md` (±1) | Discover-don't-ask for file location | None | None | **SALVAGE_EXACT** | PR-A |
| `03_Model_Adapters/UltraTerse_Fallback.md` (+4/−8) | Authority line replaces hardcoded ACT plan-ending | None | None | **SALVAGE_EXACT** | PR-A |
| `docs/README.md` (+2) | Links to the two autonomy docs | None | Bundle dependency | **SALVAGE_EXACT** | PR-A |

### Classification totals

SALVAGE_EXACT 24 · SALVAGE_ADAPT 5 · MISSING_CANONICAL 4 · DOC_ONLY_VALUE 2
(some items carry two labels where a doc is both missing-canonical and
adapted; every recovered file is accounted for exactly once by destination:
PR-A 17 files, PR-B 23 files (11 untracked + 12 tracked) — all 40 recovered files accounted for; PR-A additionally carries its own authored additions on two of those files (CLAUDE.md invariants 7-9, the typecheck.yml drift-guard step), declared in the PR body). No recovered item was
classified REJECT and none was silently discarded; the two adaptations are
recorded above with their rationale.

## Deep-audit highlights (evidence)

1. **The independent-review set is the requesting half of the trust plane,
   not a rival authority.** Main (PR #138) landed the verifier/gate side;
   the recovered broker/issuer/provider/supervisor/commands are a
   builder-side coordinator for *obtaining* review. No component holds or
   generates production keys; the issuer adapter never receives a private
   key (public key only) and refuses PASS-with-blockers or builder-impersonating
   reviewers; the gate re-verifies everything against base-rooted owner
   key registries, so a builder driving the CLI with its own services
   yields at worst a locally-advisory status string.
2. **Acceptance V0 CI gap is real.** `test:unit` is referenced by no
   workflow, its glob excludes `src/acceptance/*`, and
   `test:acceptance-v0-fixture` is unwired; the 1,093-line acceptance engine
   suite therefore never ran in CI. The recovered delta both hardens the
   engine and wires it into both validation jobs.
3. **The recovered rules bundle resolves three dangling references on main**
   (`10-independent-review-policy.md`) and one live doc bug (stale v10
   adapter references), while matching main's enforced runtime
   (`taskClarity.ts`, `ciRepair.ts`, `autonomyPolicy.ts`) better than the
   prose it replaces. The one contradiction it exposed — rule 05's
   stop-on-failed-checks vs the repair stance — is resolved in PR-A.
4. **Non-acceptance stray fix:** the `deepInfraApi.ts` hunk removes a
   hardcoded `messages: []` that forced all callers through the fallback
   path — self-contained and applies cleanly.

## Disposition (Phase 17)

| Item | Disposition |
| --- | --- |
| Autonomy/review policy + rules/adapter docs | **Landed** (PR-A) |
| Campaign record + history corrections + drift guard + epistemic invariants + test-environment repairs | **Landed** (PR-A) |
| Acceptance V0 engine + tests + CI wiring + deepInfraApi fix | **Landed** (PR-B) |
| Independent-review coordinator CLI + services + tests | **Landed** (PR-B) |
| Gate missing-evidence crash fix + regression matrix + lifecycle + assurance docs | **Engineered; trust-authorization pending** (PR-C) — protected paths require TrustRootUpgradeV1 |
| Temporary stash `0d48c6e9` | **Retained** until PR-A/PR-B/PR-C reach terminal state and backups re-verify; not the sole preservation mechanism (branch + bundle + ZIP exist) |
