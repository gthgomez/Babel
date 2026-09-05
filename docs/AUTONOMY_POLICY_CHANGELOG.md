# Babel Autonomy Policy Changelog

> **Point-in-time record.** Authored against repository state
> `codex/final-recertification-20260830` @ `4fd9c35` (now part of `main`'s
> history). Section 11's test counts and the §9 runtime-debt table describe
> that snapshot, not current `main`; later PRs (#138–#141) paid part of the
> recorded debt (authority engine, autonomy enforcement, trusted execution
> supervisor, bounded CI repair). The ledger (AP-01…AP-18) remains the
> authoritative record of what this policy changed.

## 1. Executive summary

This change makes Babel's intended engineering behavior autonomous by default inside explicitly granted repository and mission scope. It removes broad approval friction for repository investigation, test selection, ordinary implementation, bounded recovery, local Git inspection, isolated worktrees, and continuation of routine engineering work.

It does not grant new runtime capabilities or weaken hard safeguards. Secrets, path and sandbox boundaries, pre-existing dirty work, unknown non-idempotent effects, destructive operations, production changes, privilege expansion, irreversible remote operations, provenance, audit logging, and verifier integrity remain protected.

The policy also makes an important limitation explicit: prompt changes do not create a durable mission supervisor, universal verification compiler, semantic recovery engine, GitHub/CI controller, or multi-agent supervisor. Those remain runtime debt.

## 2. Repository state

| Field | Value |
|---|---|
| Starting branch | `codex/final-recertification-20260830` |
| Starting HEAD | `4fd9c35ad3b4124a49318d530b5bf140114ffe59` |
| Final branch | `codex/final-recertification-20260830` |
| Final HEAD | `4fd9c35ad3b4124a49318d530b5bf140114ffe59` (no commit created) |
| Starting tracked changes | None observed |
| Pre-existing untracked state | `.worktrees/`, `artifacts/`, `babel-cli/effect-ledger.jsonl` |
| Remote | `https://github.com/gthgomez/Babel.git` |

Files modified: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `INTEGRATION.md`, `docs/README.md`, `.agents/rules/06-autonomous-goal-clearance.md`, `LLM_COLLABORATION_SYSTEM/RULES_CORE.md`, `LLM_COLLABORATION_SYSTEM/RULES_GUARD.md`, `LLM_COLLABORATION_SYSTEM/RULES_SHARED_ALL_MODELS.md`, `01_Behavioral_OS/OLS-v11-Core-Unified.md`, `03_Model_Adapters/Claude_AntiEager.md`, `03_Model_Adapters/Gemini_LongContext.md`, `03_Model_Adapters/Scout_Orchestrator.md`, `03_Model_Adapters/UltraTerse_Fallback.md`.

Files added: `docs/AUTONOMY_POLICY.md`, `docs/AUTONOMY_POLICY_CHANGELOG.md`.

Files removed: none.

## 3. Policy philosophy before vs after

| Area | Previous behavior | New behavior |
|---|---|---|
| Uncertainty | Often treated as a reason to stop, re-plan, or ask early | Investigate, test safe assumptions, record uncertainty, then continue when the choice is ordinary engineering judgment |
| Ordinary code changes | Several layers required explicit approval or an `ACT` token | Mission-authorized scoped work proceeds without step-by-step approval |
| Test selection | Frequently prompt-dependent | Agent responsibility; derive and run applicable checks, with runtime debt explicitly acknowledged |
| Recovery | Unexpected errors often forced STOP | Observe, classify, recover, replan, and verify before escalating |
| Git inspection | Instruction-driven | Autonomous default inside repository scope |
| Local commits | Allowed only through explicit delivery workflow | May proceed when the mission explicitly grants local commit authority and the ship set is deterministic; no repeated confirmation |
| Mixed dirty worktrees | Stop/ask broadly | Preserve unrelated work, isolate or classify it, and ask only if user intent is required |
| Destructive action | Approval required | Approval remains required |
| Secrets | Denied | Denied unless separately brokered and explicitly authorized |
| Deployment/production | Approval required | Approval remains required |

## 4. Complete rule-change ledger

| ID | File | Previous rule | New rule | Classification | Reason | Safety impact |
|---|---|---|---|---|---|---|
| AP-01 | `AGENTS.md` | “Safety over cleverness”; “propose before I impose”; propose every change before applying | Autonomous by default within granted scope; plan and verify, then act; ask only at authority boundaries | AUTONOMOUS_DEFAULT | Removed socialized approval friction while retaining evidence and reversibility | No hard boundary removed |
| AP-02 | `AGENTS.md` | G0–G3 execution stance was autonomous, but surrounding wording implied broad pre-approval | Clarifies that G0–G3 establish authority, context, plan, and verification; they do not require plan approval for ordinary work | CONSOLIDATE | Resolves internal tension with “No Approval Stalls” | G0 and hard stops remain |
| AP-03 | `CLAUDE.md` | Model-specific entry path and workflow rules did not point to one autonomy policy | Adds the canonical policy and states that local autonomy is bounded by runtime/authority rules | CONSOLIDATE | Gives all model sessions one policy reference | No authority expansion |
| AP-04 | `GEMINI.md` | Stage and commit new skills/catalog changes immediately | Commit only when mission authority and ship-set rules permit; never stage solely because files are new | REWRITE | Contradicted explicit delivery and dirty-work safeguards | Prevents accidental staging/commit |
| AP-05 | `INTEGRATION.md` | Runtime invocation guidance described resume/checkpoints but not autonomy boundaries | Links the canonical autonomy policy and distinguishes intended behavior from runtime capability | CONSOLIDATE | Prevents prompt policy from overstating runtime support | Preserves runtime caveat |
| AP-06 | `.agents/rules/06-autonomous-goal-clearance.md` | G1 required interpretations to be sufficiently explicit before execution | G1 requires an actionable goal; ordinary engineering details may be inferred, investigated, recorded, and verified | RELAX | Removes unnecessary clarification stalls | Product ambiguity still escalates |
| AP-07 | `.agents/rules/06-autonomous-goal-clearance.md` | G0–G3 pass then execute, but no explicit uncertainty recovery loop | Adds investigate → evidence → safest reversible decision → verify → continue; one consolidated escalation after safe paths | REWRITE | Makes autonomy behavior operational | G0 authority and G4 evidence remain |
| AP-08 | `RULES_CORE.md` | Planning and missing evidence language was not explicitly tied to autonomous investigation | Adds mission-authorized autonomy, evidence-first uncertainty handling, and bounded recovery semantics | MOVE_TO_AUTONOMOUS_DEFAULT | Removes prompt ceremony from routine engineering | Keeps unknown content and boundary checks |
| AP-09 | `RULES_GUARD.md` | ACT executed only “approved” actions; new unknowns stopped immediately | ACT executes mission-authorized actions; unknowns trigger evidence/replan, while hard boundaries still STOP | REWRITE | Aligns guard behavior with safe autonomy | Guard and integrity gates remain hard |
| AP-10 | `RULES_SHARED_ALL_MODELS.md` | Shared layer emphasized plan/approval-style gating and compensatory prompt behavior | Shared layer points to canonical autonomy policy and uses mission authorization rather than step approval | CONSOLIDATE | Prevents cross-model semantic drift | No security relaxation |
| AP-11 | `OLS-v11-Core-Unified.md` | ACT required an approved spec; unexpected errors required STOP; terminal handshake implied generic approval | ACT accepts mission-authorized execution; failures enter recovery before STOP; confirmation applies only to authority boundaries | RELAX / REWRITE | Removes broad approval dependency | Evidence, contract, and hard-stop rules remain |
| AP-12 | `Claude_AntiEager.md` | Explicit user approval and `ACT` were required for all implementation output; pause/confirm after every file | Scoped mission authority permits routine implementation; pause only at genuine boundary or unresolved product intent | REMOVE / REWRITE | This was the largest provider-specific autonomy bottleneck | Preserves safety, contract, and verification requirements |
| AP-13 | `Gemini_LongContext.md` | Explicit approval was required before code, commands, diffs, or execution | Mission-authorized execution is allowed; approval is reserved for authority boundaries | REMOVE / REWRITE | Removed provider divergence | Protected paths and hard gates remain |
| AP-14 | `Scout_Orchestrator.md` | Missing file in an underspecified task became an ambiguity note without directing investigation | Treat missing file as a discovery lead; lower confidence, search, and continue unless product intent remains ambiguous | REWRITE | Prevents routing from unnecessarily delegating discoverable facts | Routing confidence and evidence requirements remain |
| AP-15 | `docs/AUTONOMY_POLICY.md` | No concise canonical autonomy policy | Added canonical intent, uncertainty, discretion, recovery, evidence, and authority boundaries | ADD | Establishes one policy reference | Explicitly disclaims missing runtime capability |
| AP-16 | `docs/AUTONOMY_POLICY_CHANGELOG.md` | No review package for autonomy rule changes | Added complete ledger, contradictions, safety review, verification, and remaining debt | ADD | Makes policy changes auditable | No runtime behavior changed by the document alone |
| AP-17 | `03_Model_Adapters/UltraTerse_Fallback.md` | Fallback adapter required an `ACT` token before routine implementation | Fallback plans carry authority status; routine mission-authorized execution proceeds without ceremony | REWRITE | Removes the last active provider fallback approval ritual | Hard gates and mission/runtime authority remain |
| AP-18 | `docs/README.md` | New autonomy documents had no documentation index entry | Added links to the canonical policy and changelog | CONSOLIDATE | Makes the canonical policy discoverable without broad searching | Documentation-only |

## 5. Removed restrictions

The following restrictions were removed or weakened:

- mandatory user approval before ordinary implementation;
- mandatory `ACT` token before routine implementation for Claude and Gemini;
- mandatory pause and confirmation after every file;
- treating every newly discovered unknown as an immediate STOP;
- requiring the user to decide whether the agent should inspect, test, retry, resume, or reconcile routine work;
- staging or committing merely because a file is new.

The replacement is not unrestricted execution. The agent must have mission scope, repository access, safe tool preconditions, a verification plan, and no hard authority boundary.

## 6. Safety boundaries preserved

- protected instruction-file integrity gates;
- path jail, sandbox, and capability enforcement;
- credential and secret read denial;
- preservation of pre-existing dirty work;
- unknown-effect and non-idempotent duplicate prevention;
- explicit authority for deployment, production, merge, force-push, destructive Git, and irreversible remote operations;
- provenance and prompt-injection defenses;
- evidence integrity, audit logging, verifier integrity, and hard completion requirements;
- scope control, ship-set staging, branch protection, and required CI gates.

## 7. New autonomous defaults

Babel agents are expected to autonomously inspect repository state, discover files and commands, choose routine engineering tactics, create plans, implement scoped changes, add regression tests, run applicable verification, recover from ordinary failures, use isolated worktrees, preserve unrelated work, reconcile their own changes, and continue without repeated approval.

These defaults do not imply that the current runtime already implements durable mission continuation, universal test obligation discovery, GitHub CI control, or safe live multi-agent replacement.

## 8. Human-decision boundary

**AGENT_DECIDES:** which files to inspect; which local tests to run; implementation order; ordinary refactoring; whether to retry an idempotent command; whether to create an isolated worktree; how to fix a failing test; how to record and verify a reversible local change.

**USER_DECIDES:** new secrets; production deployment; destructive data or infrastructure changes; force-push or shared-history rewrite; irreversible remote operations; material unexpected cost; intentional security weakening; materially ambiguous product behavior; authority expansion.

## 9. Prompt-to-runtime debt

| Priority | Remaining debt | Future mechanism |
|---|---|---|
| P0 | No durable mission supervisor and restart continuation | Event-sourced mission state machine with leases and continuation worker |
| P0 | No universal verification-obligation compiler | Diff/risk/repository/CI-to-check compiler |
| P1 | Fragmented semantic state | Canonical mission ledger with projections |
| P1 | Recovery classification without general semantic action selection | Recovery state machine with reconciliation and replanning |
| P1 | Incomplete GitHub/CI lifecycle | Remote observer/controller with policy-bounded mutation |
| P1 | Multi-agent ownership and replacement | Scheduler, leases, scope graph, merge certifier |
| P2 | Provider/environment handoff | Capability negotiation and durable mission handoff bundle |

## 10. Contradictions discovered

1. `AGENTS.md` said “No Approval Stalls” while its identity and workflow prose said to propose before imposing. The rule now distinguishes planning from approval and limits approval to authority boundaries.
2. OLS, Guard, Claude, and Gemini layers required approval/`ACT` for ordinary implementation, contradicting the repository’s intended autonomous execution stance. Those gates now apply only to authority-boundary actions.
3. `GEMINI.md` instructed immediate staging and committing of new files, conflicting with ship-set and dirty-work protections. It now defers to mission authority and explicit ship-set logic.
4. The rule stack described resume and recovery as available while runtime evidence shows that general semantic continuation is incomplete. The canonical policy now discloses this gap instead of implying that prompt wording solves it.
5. The live behavioral OS is v11, while some adapter prose referenced v10. The edited autonomy language points to the active v11 state model without changing the typed runtime contract.

## 11. Verification

- Static validation: `git diff --check` passed; modified Markdown and YAML were inspected; no source schemas or runtime code were changed.
- Rule reference validation: changed references were checked against existing paths.
- Focused runtime suites: `npm run test:harness-acceptance`, `npm run test:portable-workflow`, and `npm run test:harness-runtime`.
- Existing results: 23 acceptance tests passed; 11 portable-workflow tests passed; `test:harness-runtime` reported 365 tests total, 361 passed, 3 failed, and 1 skipped. The three failures were the existing real-CLI PROC-01/02/03 cases timing out while waiting for `/exit`; in-process safety, authority, recovery, verifier, provider, and prompt-stack cases passed.
- Broader unit validation: `npm run test:unit` did not complete and was stopped after several minutes because spawned Node workers remained active. The isolated `src/agent/session.test.ts` run reported 8 tests: 4 passed and 4 failed; all four failures were the live-model policy refusing provider responses without observed model identity, an environment/fixture limitation unrelated to these documentation-only changes.
- Prompt/catalog validation: `npm run test:manifest-preview`, `npm run test:resolver`, `npm run test:orchestrator-routing`, and `npm run test:bounded-contract` passed. An earlier catalog-validation run passed with 195 entries, 0 warnings, and 0 errors; the final rerun was blocked before validation by the workspace PowerShell profile’s language-mode error, and the catalog/script were not modified.
- Instruction-loader tests: no dedicated loader suite was identified by the package scripts; this remains an uncertainty.
- Prompt snapshot tests: no dedicated snapshot suite was identified by the package scripts; this remains an uncertainty.
- Diff review: required after edits; pre-existing untracked paths must remain untouched.
- Diff review: required after edits; pre-existing untracked paths must remain untouched.

## 12. Risk assessment

| Change | New authority | New risk | Boundary | Mitigation | Rollback |
|---|---|---|---|---|---|
| Ordinary local implementation without repeated approval | Routine scoped file mutation | More autonomous edits | Current repo and mission scope only | Worktree/file guards, evidence, verification | Revert the policy diff; use worktree snapshots |
| Autonomous test/recovery choice | Local execution discretion | Repeated or costly commands | Bounded commands and budgets | Idempotency, timeouts, retry limits, evidence | Disable autonomy default or restore prior rule text |
| Local branch/commit maintenance | Local Git mutation | Wrong ship set | Explicit mission commit authority, non-main branch | Release map and staged-diff review | Revert commit or restore branch locally |
| Reduced provider-specific approval gate | Provider can execute routine work | Model may overreach | Runtime capability and hard policy still dominate | Guard, contract, secret, and effect gates | Re-enable adapter gate if regression appears |

## 13. Recommended next autonomy milestone

Implement the canonical durable mission state machine and continuation protocol. The rule layer now tells agents to investigate, recover, verify, and continue, but only a durable mission ledger can make those instructions survive process death, context loss, provider changes, and worker replacement.
