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

Additional acceptance checks run after the original evidence record:

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test:progress-ablation` | PASS: deterministic; no false completes |
| Executor fault-injection harness | PASS: 30/30 fault/effect cases; 0 duplicate mutations |
| Daemon + verified-completion focused tests | PASS: 6/6 |
| Absolute-path SWE-Pro infra preflight | PASS: 1/1 checkout |
| Absolute-path mock SWE-Pro cell | INCONCLUSIVE: no completed campaign report within the bounded runner window |
| DeepSeek V4 Flash live cell | HONEST FAILURE: `test_patch_applied=true`, `collect_error`, no authoritative completion; campaign timed out before the remaining cells finalized |
| DeepSeek wire/continuity conformance | PASS: focused provider-message, reasoning-content, thinking/tool-choice, effort-normalization, and cache-split tests |
| Readiness receipt + verifier overlay | PASS: signed redacted receipt blocks provider spend when absent; detached overlay excludes the test patch and preserves the primary workspace |
| Fresh three-cell mock SWE-Pro revalidation | HONEST BLOCK: 3/3 infra cells passed; 2/3 cells reached signed readiness + detached verification but produced zero production edits and terminal `BLOCKED_POLICY`/`BLOCKED_EXTERNAL`; 1/3 remained `ENV_BLOCKED` because Python 3.10 lacks `typing.Required` |

The focused corpus covers verifier authority and false-complete rejection,
Chat completion payloads, SessionEventV1, tool settlement, progress and
ablation, workspace/effect reconciliation, evidence graph and independent
verification, server-owned sessions, daemon lifecycle/recovery, and
Chat/Plan/Deep kernel parity.

The fresh mock revalidation also confirmed native Windows `Scripts` venv
selection and short per-instance workspace paths. It did not produce a model
capability score: the ready mock cells exercised harness arbitration with no
production patch, while the remaining cell was blocked by the host Python
version before provider execution.

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

## Live benchmark disposition

The live lane used the explicit `deepseek-v4-flash` model ID with tool-compatible
thinking disabled and `BABEL_SWE_PRO_PASS_MODE=both`. The DeepSeek credential was
read only by the provider environment; no key or raw provider payload is part of
this record. The first completed cell produced an honest verifier collection
failure, not a false green. The three-cell current-vs-baseline campaign and
Wave-A promotion remain blocked until the campaign runner completes within a
repeatable outer timeout; the preflight and dependency/workspace lifecycle need
further bounded-runner investigation before spending more live budget.

Latest Wave 0 disposition: no live provider call was made during this
revalidation. The next parity step is a Linux/container-backed SWE-Pro
preflight (Python 3.11+ and a short `/app`-style workspace), followed by the
same three-cell mock gate and only then an explicitly authorized live canary.
