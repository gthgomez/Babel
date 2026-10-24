# Provider-switch fixture qualification

Use a trusted checkout of `provider_switch_qualification.mjs` and the shipped
fixture outside the candidate's write authority. No runner for this fixture
existed when it was introduced; the manifest alone did not enforce its criteria.
This runner checks the small fixture; it does not launch a paid campaign.

1. Run `node /trusted/babel-cli/scripts/provider_switch_qualification.mjs --prepare ABS_WORKSPACE ABS_EVIDENCE GATEWAY MODEL`.
   Both parent directories must exist. The workspace must be new. Evidence must
   be external to both the workspace and shipped fixture. Preparation freezes
   the evaluator, oracle, pristine project and exact expected route before any
   candidate execution. GATEWAY is `openrouter` or `commandcode`; MODEL is the
   resolved provider model ID, supplied explicitly.
2. Give Babel the manifest task with `ABS_WORKSPACE` as the project root. Only
   the workspace contents are materialized; do not give the candidate evaluator
   paths or answers. Capture the canonical `session-events.jsonl` in host-owned
   storage outside candidate write authority. Keep the challenge and trusted
   runner outside that authority too. No production budget overrides are needed.
3. Run `node /trusted/babel-cli/scripts/provider_switch_qualification.mjs --verify ABS_EVIDENCE ABS_SESSION_EVENTS`.
   All paths are absolute; invocation cwd is irrelevant, including spaces and
   Unicode paths. A fresh cell is required for another verdict. `--plan` always
   returns `pass: false` and `authoritative: false`.

`functionalPass` requires a real ledger edit, unchanged project tests and other
protected inputs, passing project tests, and independent mixed, debit-only,
zero, empty, fractional and input-preservation cases. It accepts equivalent
implementations. Candidate imports and project tests execute in bounded child
processes with restricted environments, output limits and failure handling.

`providerCellPass` additionally requires fresh, workspace/task/session/turn-bound
host-captured events: at least two distinct dispatched requests with delivered
results and a completed tool call with a matching start between dispatches.
Every dispatched request must use the expected route and have a matching delivered
result; mixed routes and unsettled requests fail qualification.
Missing trace never qualifies a provider cell. The test suite's synthetic trace
only tests this validator; it is not a live qualification receipt.

The runner compares the frozen inputs before and after execution and binds the
verdict to a fresh nonce, ledger hash and evaluator/oracle hashes. Self-hashing
alone provides no independent protection. A raw evaluator result always has
`authoritative: false`; only the external runner qualifies it. Child processes are not an OS
security sandbox: a hostile program with the same account's filesystem rights
could attack external evidence or restore files after tampering. Use actual
host isolation for hostile candidates; this runner cannot attest evidence
supplied from candidate-controlled storage. Do not call a functional fixture
pass an original-task, terminal-truthfulness or live-provider success.

Run deterministic controls with
`node --test --test-concurrency=1 babel-cli/scripts/provider_switch_qualification.test.mjs`
from the repository root. Tests use disposable copies, preserve the shipped
pristine ledger/tests, and include the hardcoded repair that passes project
tests but fails the independent oracle.
