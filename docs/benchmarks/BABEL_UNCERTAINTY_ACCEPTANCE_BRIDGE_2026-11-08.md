# Babel uncertainty and evidence recovery notes — 2026-11-08

## Baseline and scope

This change set is based on `origin/main` at `139547454966aa55aa74d222d201b3ca4997197b`. It addresses three reproduced recovery seams and integrates the two scoped-instruction fixes already prepared on separate branches. It does not claim to reproduce the CommandCode run directly: its structured evidence was not present in the shared workspace; the only available description was “2/2 checks passed, outcome `UNVERIFIED_PATCH`.”

## Changes

1. A newly executed, host-admitted verifier result now clears accumulated completion-gate strikes, including a red result that gives Babel fresh diagnostics to work from. The signal comes from the existing durable progress receipt and is only emitted for an executed authoritative verifier with a new semantic signature. Reads, repeated results, and model-authored progress claims do not clear strikes.
2. A later successful retry of the exact same tool and target clears stale typed blocking evidence. A success on a different action does not clear it, and a later typed failure reestablishes the block. The classifier still requires a model `BLOCKED` declaration and typed host-observed failure evidence.
3. Edit-intent parsing now recognizes “hidden tests” as a scoped protected artifact and “other files” as a scoped exclusion. It also ends that exclusion clause before a following explicit test command. These clauses do not grant mutation intent by themselves; global no-edit directives and unrelated commands remain read-only.

## Verification

- Focused suites: 53 tests passed across `chatEngineTaskIntent.test.ts`, `progressEvidenceAlignment.test.ts`, and `r0TerminalAuthority.test.ts`.
- `npm run typecheck`: passed.
- Full `npm run test:unit`: started and exercised the modified suites successfully, but was interrupted after 5 minutes because the suite stalled without output. Before interruption, unrelated environment-sensitive failures were reported in background process-tree termination, offline plan-lane assumptions, and undo-lane fixtures. This is not a passing full-suite result.
- `pwsh scripts/agent-preflight.ps1` is unavailable because PowerShell is not installed in the execution environment.
- No provider inference was used.

## Acceptance evidence and remaining gap

Babel already binds required verifier commands to host-owned task/session/context and current workspace revision, and rejects stale, failed, skipped, or irrelevant receipts. A green test summary alone is not enough to establish `VERIFIED_COMPLETE`. The CommandCode report’s 2/2-but-unverified case cannot be diagnosed without its task contract, required verifier list, receipts, current revision, and terminal reason. Do not promote such a result based only on the count of green checks. The next concrete step is to replay that exact evidence bundle through the existing completion proof selector and determine which requirement is uncovered or which provenance field is missing.

The suspected broad `NEEDS_HUMAN_DECISION` behavior and requirement-to-verifier binding were not changed because the available evidence did not establish a safe reproducible false positive or a concrete missing-criterion mapping. Decision gates and fail-closed completion remain intact.
