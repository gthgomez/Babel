# Parallel reliability roadmap — 2026-11

This is one coordinated engineering campaign **using many reviewable PRs**, not one giant code PR. Every finding has a single W01–W14 primary owner in [FINDINGS_INDEX.csv](FINDINGS_INDEX.csv). Original audit claims are pinned to public source `198193b1`. The register records source dispositions against `854f842e` and names the evidence for each row. Independently establish current-head behavior before changing a code path.

## Critical dependencies

```text
W04 independent grader / frozen fixtures ─┬─> W01 admission / obligations ─┐
                                        └─> W02 final revision + kernel ───┼─> W03 terminal truth
W05 context/children ────────────────────────────────┘       │
W06 tool contracts ──────────────────────────────────────────┤
W07 provider route + budgets ──────────────┐                ├─> W11 Desktop/Deep integrations
W08 OS permission boundaries ──────────────┼─> W10 CLI/TUI ─┘
W09 MCP stdio + redaction (independent) ───┘
W12 deterministic CI (independent) ───────────────────────────┐
W13 release/package prep (independent) ───────────────────────┤─> exact-artifact qualification
W14 audit/ownership (continuous) ─────────────────────────────┘
```

Arrows are **integration dependencies**, not permission to block independent fixture discovery or safe isolated code reviews. W02 owns the shared completion/receipt decision; W01 owns admission and criterion lineage; W03 owns terminal output projections. Schema changes require a single interface contract, compatibility tests, and serialized integration when files overlap.

## Wave A — launch independent work as capacity permits

- W04 freezes positive **and** wrong-patch/stale-revision/empty-output negative controls, held outside the candidate workspace.
- W01/W02 start as a **coordinated contract pair**: independent test preparation, but one integration owner for shared authority schema. Protect the fail-closed kernel.
- W05 instruction retention/child adoption, W06 tool catalog/adapter parity, W07 offline/provider/budget, W08 OS boundary/security, W09 MCP standard/redaction, W10 first-use PTY, W12 deterministic CI, W13 artifact/advisory inventory and W14 program stewardship can each work on mostly separate source seams.
- W11 can validate #520's now-merged Desktop fix and prepare installed tests, avoiding simultaneous edits to #516's overlapping worker files.

**Control concurrent writes by touched paths and source ownership, not arbitrary agent count.** Prefer one branch/PR per coherent repair or short stack. Do not launch more heavy CI jobs than capacity or expected benefit justifies.

## Wave B — integrate shared contracts and restore user journeys

- W01+W02 produce a jointly reviewed versioned contract: original objective/non-goals, admitted permissions, candidate/revision identity, relevant verifier witness and tool settlement.
- W03 consumes that contract to make shell/NDJSON/TUI/Desktop/remote agree. W11 then integrates Desktop-specific handlers; W10 aligns CLI/TUI explanations.
- W07 route/budget and W08 actual profile authority must agree on before-task disclosure. W06/W09 must preserve intentionally restricted tool permissions.
- Rebase candidate parts of #515/#516/#517/#519 **once** on the tested integration head; reuse or supersede existing work explicitly, without reimplementing #518/#520.
- A non-successful but useful edit stays visible and recoverable, and a failed provider turn cannot erase the latest red check.

## Wave C — release qualification and independent comparison

- W13 tests actual candidate npm tarball and installed Windows native package (and Linux AppImage only if a supported release is planned); artifact bytes and source SHAs are recorded.
- W04/W12 run frozen no-key suites and exact-head required checks with independent held-out artifact scoring. Any new false-success or stale-proof case blocks a reliability claim.
- Separately authorize and cap any OpenRouter and CommandCode *real-model* trials. Compare paired externally graded tasks with a minimal harness under equivalent environment, model and permissions; report uncertainty, cost per solved task and all blocked/invalid denominators.
- Publish or merge only through `AGENTS.md`-required independent review, trusted exact-head policy and explicit owner authorization. A docs PR, issue completion or passing mock by itself is **not release approval**.

## Program review cadence and closure

Each W issue should list its owner, current base/head SHA, in-progress PR(s), risks and required exact-artifact tests. #521 tracks inter-stream dependencies. At PR review/merge, update only owned finding rows; record `audited | reproduced_on_head | historical | disproven | coded | reviewed | merged | package_qualified | closed`. An old issue or closed draft does not imply the underlying behavior is fixed. Preserve prior accepted evidence and older session compatibility when introducing new schemas.

**First integration gate:** without paid calls, demonstrate that a multi-criterion correct repair reaches verified completion, unrelated-green wrong repair fails, read-only stale check fails, Deep late write fails, and exit/JSON/UI all agree for one frozen candidate. The broader platform work proceeds in parallel, but this gate is the central dependency for daily-use claims.
