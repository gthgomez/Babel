# Babel Reliable Executor Acceptance Evidence (2026-08-02)

<!--
status: ACTIVE
scope: acceptance-validation
-->

This is an evidence record for the landed W3–W7 executor slices. It does not
promote a wave to complete: the roadmap still requires live benchmark,
fault-injection, restart/git, and deterministic cross-mode evidence.

## Local verification

| Check | Result |
| --- | --- |
| `cd babel-cli && npx tsc --noEmit` | PASS |
| Roadmap acceptance corpus (35 files) | **261 pass, 0 fail, 2 TODO; 263 tests** |
| Daemon integration standalone | PASS: lifecycle + clean restart/recovery |
| Verified-completion artifact validation | PASS: schema/example contract |
| Full `npm test` | INCONCLUSIVE: exceeded 180-second local timeout without a result |

The focused corpus covers verifier authority and false-complete rejection,
Chat completion payloads, SessionEventV1, tool settlement, progress and
ablation, workspace/effect reconciliation, evidence graph and independent
verification, server-owned sessions, daemon lifecycle/recovery, and
Chat/Plan/Deep kernel parity.

## Changes made during acceptance closure

- Added the published verified-completion schema and example required by the
  W6 validation contract.
- Made the daemon TCP port configurable through `BABEL_DAEMON_PORT` so tests
  can coexist with another local Babel daemon.
- Hardened daemon integration timing and shutdown waits for Windows/tsx load.

## Remaining wave-exit evidence

- W1: adversarial corpus plus fresh benchmark-worktree revalidation.
- W2: kill/resume fault injection for every effect class.
- W3: fixed-baseline ablation metrics and end-to-end terminal arbitration.
- W4: restart/git patch reality and partial-failure integration.
- W5: real-daemon replay/resume/cancel matrix.
- W6: fresh revision-bound proof wired on every production completion path.
- W7: deep/lite bypass closure and deterministic Chat/Plan/Deep E2E.
