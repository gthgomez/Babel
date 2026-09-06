# Auditable harness comparisons

The v2 runner keeps execution, independent verification, semantic correctness,
and causal interpretation separate. A faster wrong answer does not win.
Historical packets do not satisfy this new contract.

## Commands

From `babel-cli`:

```sh
npm run test:comparison
npm run benchmark:claude-babel:compare -- --contracts=pairs.json --preflight
npm run benchmark:claude-babel:compare -- --contracts=pairs.json --adapters=trusted-adapters.ts --output=new-campaign
```

Preflight uses no provider calls. An invalid cell is skipped; subsequent cells
continue. Output must be a fresh directory. Existing receipts, packets and
reports are never overwritten. The pilot and canary aliases use this same entry
point. Original legacy code remains available at the experiment baseline.

`PairContract` in `comparison-contract.ts` is the versioned machine contract.
`freezeEvaluator(taskId)` supplies the verifier ID, digest and command before
execution. Task instructions must match `fixturePrompt(taskId)` exactly; the
generated fixture Git SHA is checked before execution. Each contract binds the
experiment/pair/task, fixture/base/runner SHA, both harness identities, exact
provider/model, configuration digests, route and resource envelope. Babel's
version is a complete Git SHA. Claude's version must come from its executable.
The runner also checks its actual checkout SHA and the fixture repository base,
and retains a digest plus snapshot of runner/evaluator source bytes. Dirty state
does not trigger refusal; the snapshot preserves the exact observed source.

The trusted adapter module exports `adapters`, keyed by `claude-code` and
`babel-live`, implementing `ComparisonAdapter`. `describe()` observes effective
configuration and authority before execution. `execute()` receives the frozen
contract, an isolated generated fixture, an output directory and AbortSignal,
and returns `ControlledRun` with audit observations. Existing native harness
functions support frozen prompts and produce these observations. Adapter code
is evaluator-owned code, not a contestant-created module or receipt.

The generic runner enforces wall timeout and propagates cancellation. An adapter
that fails to settle receives PROCESS_HANG and is not evaluated. Each other
resource limit must be enforced and observed by the adapter; recording an
intended budget alone is insufficient. Do not claim readiness from a fabricated
`describe()` response. The deterministic tests use explicitly synthetic adapters.

## Effective authority and attribution

The effective capability manifest normalizes filesystem read/write scopes,
network access, process rights, environment assumptions and resource limits as
sets. Different tool names are permitted; unequal task-relevant authority is
`INVALID_CAPABILITY_MISMATCH`. Runtime description must match the preregistered
description and evidence references. Digests go into each new receipt.

The contract is an experiment boundary, not a new Babel authority mechanism.
It does not grant shell execution or alter the trust plane. Native Babel and
Claude capability parity still requires measured adapter evidence in the next
campaign. In particular, the historical Babel shell denial must not be hidden
behind nominal auto-approval settings.

Only `opencode-go` and `mimo-v2.5`, `longcat-2.0`, `deepseek-v4-flash` are accepted.
Observed identity must match requested identity, with `fallback=false`.
Explicit mismatches invalidate the affected comparison. Missing identity during
a timeout stays unknown and inconclusive; it is not counted as an observed
provider mismatch. Unknown fallback on a normally completed cell is invalid.

The native Claude adapter currently observes a shared proxy log. That is not
sufficient to establish per-invocation absence of fallback, so it reports
UNKNOWN. A correlated adapter/proxy receipt is required before scoring a live
Claude pair. Historical verified route architecture remains valid; this is a
limit on fresh cell attribution, not a requirement for the standalone OpenCode
CLI. No `opencode.exe` installation or human tooling approval is required.

## Independent evaluation

The evaluator executes its canonical complete test command, regardless of what
the contestant chose to run. It copies only allowed source into a separate
evaluator workspace, reconstructs frozen tests/package metadata, checks protected
fixture files, and runs Node directly with a minimal environment. Contestant
package scripts and test filters cannot satisfy it. Changed verifier material,
symlinks, early process exits and spoofed test output have negative tests.

Structural and semantic suites are separate. For example, hardcoding `add()` to
return 5 can pass the original structural case and fail independent arithmetic
cases. Semantic PASS covers the finite frozen cases. The evaluator is not an
adversarial same-user OS sandbox; subprocesses may have the runner's OS rights.

## Recovery and results

Every cell separately records EXECUTION_SUCCESS, VERIFIER_SUCCESS,
TASK_CORRECTNESS and HARNESS_EFFECT. Causal attribution stays INCONCLUSIVE until
independent evidence supports it; one matched result is not proof of superiority.

Failure diagnostics are correlated to model-facing tool observations. RETRIES
counts observed repeated identical tool/action pairs after failure: a lower bound
that excludes rephrased commands and provider retries. Recovery requires a
successful re-execution with no remaining tracked failed action and independent
semantic success. Missing actionable diagnostics or model cause identification
remain UNKNOWN. These counts must not be equated to complete reasoning traces.

Termination evidence distinguishes provider/harness/runner timeouts, cancellation,
budget exhaustion, process hangs, external interruption and unknown causes.
Non-normal execution never awards the opposing harness a win. Wall time, calls,
tokens and cost remain separate from correctness; absent values remain UNKNOWN.

JSON packets, side-by-side Markdown and aggregate Markdown/JSON are generated
from the same cell records. Reports link receipts, trajectories and frozen
verifier evidence. Invalid comparisons are excluded from wins/losses/ties.

## Historical custody

The reconciliation index under `benchmarks/claude-babel-astra-lab/reconciliation`
binds original evidence to a separate local Git archive. The archive has no
remote; preserve it alongside the experiment worktree. Public raw packets already
tracked before this mission remain intact. Their machine-local paths can block
public-content gates; no gate or raw evidence should be rewritten to conceal it.

Baseline: `03cf75163c5ad202e989c0fd47955b9f08c1d72e`.
Diagnostic candidate: `fdce643a4497791ca25feb27a8df4ac95fe7ba01`.
Retained post-dataset runner: `db8a797699ada6f92653bdf3488e78bd3decb920`.
Exact dataset runner: UNKNOWN because it was untracked and edited afterward.

The DeepSeek T2 mechanism is verified; behavioral effect remains unestablished.
Nine historical harness pairs remain inconclusive under v2. The six reported
suspect pair IDs were not mapped in retained evidence, so no mapping is guessed.

## Next experiment

After measured capability parity and correlated Claude attribution are available,
run one matched DeepSeek-v4-flash T4 failure/recovery pair. The frozen broken
`formatName` fixture and required test-first instructions produce the intended
failure; require evidence that it occurred in both arms before interpreting
recovery. Freeze the independent semantic verifier and compare through v2.
No live campaign was required to test this framework.
