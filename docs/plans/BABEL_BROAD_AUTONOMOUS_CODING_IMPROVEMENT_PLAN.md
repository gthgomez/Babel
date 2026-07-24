# Babel Broad Autonomous Coding Improvement Plan

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
## Purpose

This document is the working plan for improving Babel CLI on broad autonomous
coding tasks, especially Terminal-Bench tasks that require algorithm choice,
hidden-test generalization, performance tuning, build/debug loops, or multi-file
state management.

It complements:

- `docs/plans/BABEL_AUTOMATED_BENCHMARK_LOOP.md` - inner/outer loop contract.
- `docs/plans/BABEL_DAILY_AGENT_RELIABILITY_PLAN.md` - daily reliability ladder.
- `docs/plans/BABEL_BENCHMARK_ITERATION_PROMPT.md` - Codex-managed loop prompt.

The main goal is not more command surface. The main goal is higher countable
reward on broad coding tasks without false `COMPLETE`.

## Current Evidence

Recent benchmark evidence shows a split profile:

- `log-summary-date-ranges` targeted smoke passed `1/1`.
  - Strength shown: exact-output/data-processing path can complete.
  - Caveat: the pass used deterministic exact-output repair after autonomous
    script generation did not fully converge. Count it as a guard-assisted pass,
    not proof of strong general coding.
- `largest-eigenval` targeted smoke failed `0/1`.
  - Babel halted honestly with `EXECUTOR_HALTED`, not false `COMPLETE`.
  - The verifier reported mathematical correctness failures and speed failures.
  - The executor repeated patch/test cycles after the recoverable failure budget
    reached `3/3`.
- Broad pilot baselines remain weak.
  - Known broad evidence includes `r39: 1/10`, `r40: 0/10`, and later full runs
    still around `1/10`.

The strongest current guardrail is honesty: Babel is increasingly able to fail
without claiming success. The next improvement target is competence: make it
choose better strategies, build better self-checks, and stop wasting turns when
a strategy is not working.

## North-Star Metrics

Primary metric:

- Full Terminal-Bench `pilot10` reward reaches at least `5/10`.

Secondary metrics:

- `0` false completes in full and targeted runs.
- At least `3/6` diverse canary tasks pass before a full pilot escalation.
- Repeated same-failure repair loops terminate, replan, or escalate before turn
  exhaustion.
- Every failed run emits an actionable work packet with the failure class,
  evidence paths, and likely owner.
- Benchmark tasks route to benchmark context, not unrelated workspace projects.

## Operating Rule

Babel CLI does not self-edit inside `benchmark loop`. The improvement loop stays
Codex-managed:

1. Babel CLI runs readiness and benchmark selection.
2. Codex runs the benchmark command.
3. Codex inspects artifacts.
4. Codex patches Babel source.
5. Codex verifies locally.
6. Codex reruns targeted canaries before broader pilots.

## Diverse Canary Pack

Use this pack to measure broad capability instead of overfitting to one task.

| Task | Capability Tested | Why It Matters | Promotion Signal |
| --- | --- | --- | --- |
| `log-summary-date-ranges` | exact output, file aggregation, schema discipline | Confirms data-processing and deterministic repair path | Must pass without false complete |
| `largest-eigenval` | numerical reasoning, complex eigenpairs, performance | Catches weak algorithm choice and shallow QA | Must either pass or halt early with strong diagnosis |
| `merge-diff-arc-agi-task` | Git bundles, merge conflict resolution, abstract pattern inference | Tests stateful workspace manipulation and reasoning | Must use Git-native steps and verify examples |
| `write-compressor` | binary/artifact generation, external executable validation | Tests tool use and exact artifact postconditions | Must validate decompressor round-trip |
| `pytorch-model-cli` | build, model inference, CLI artifact creation | Tests multi-language build/inference work | Must produce runnable `cli_tool`, `weights.json`, `prediction.txt` |
| `break-filter-js-from-html` | source inspection, adversarial/browser/security reasoning | Tests payload selection from evidence and custom verification | Must inspect sanitizer source and avoid fake/manual verifier |

Canary readiness before full pilot:

- Minimum: `3/6` pass.
- Required: `0` false completes.
- Required: no repeated same-failure loop after repair budget exhaustion.
- Required: benchmark routing is correct for every canary.

## Phase 1 - Benchmark Task-Risk Classifier

### Problem

Babel currently treats many coding tasks as normal implementation tasks even
when the task text contains clear high-risk signals: performance requirements,
hidden tests, complex math, build artifacts, Git state, or adversarial runtime
behavior.

`largest-eigenval` is the example: the task required non-symmetric complex
eigenpairs and faster-than-reference behavior. The planner selected a naive
power-iteration style path that QA allowed through.

### Research Before Implementation

Inspect:

- `src/services/modelEscalationRules.ts`
- `src/stages/taskShape.ts`
- `src/stages/benchmarkVerification.ts`
- `src/pipeline.ts` planner and QA prompt construction
- Recent artifacts for `largest-eigenval`, `write-compressor`,
  `pytorch-model-cli`, and `merge-diff-arc-agi-task`

Questions to answer:

- Which task-risk labels already exist?
- Which labels can be derived from task text alone?
- Which labels need file evidence from the task root?
- Which labels should force model escalation?
- Which labels should inject stricter QA/verifier requirements?

### Implementation

Add a benchmark risk classifier that returns structured labels:

- `numerical_performance`
- `hidden_test_generalization`
- `artifact_generation`
- `binary_or_compiler`
- `git_stateful_merge`
- `browser_or_security_adversarial`
- `dependency_sensitive`
- `many_file_aggregation`
- `exact_output_schema`

Each label should include:

- `confidence`
- `matched_terms`
- `required_plan_properties`
- `required_local_verifier`
- `recommended_model_tier`
- `qa_rejection_rules`

Example for `numerical_performance`:

- Match terms: `dominant eigenvalue`, `non-symmetric`, `complex`, `faster than`,
  `median time`, `benchmark`, `optimize`.
- Required plan properties:
  - discuss complex eigenpairs
  - include correctness verifier
  - include timing verifier
  - avoid unsupported claims of speed
- Recommended model tier: standard/escalated planner and QA.

### Acceptance Tests

Add unit tests proving:

- `largest-eigenval` classifies as `numerical_performance` and
  `hidden_test_generalization`.
- `merge-diff-arc-agi-task` classifies as `git_stateful_merge`.
- `write-compressor` classifies as `artifact_generation` and
  `binary_or_compiler`.
- `pytorch-model-cli` classifies as `artifact_generation`,
  `binary_or_compiler`, and `dependency_sensitive`.
- `break-filter-js-from-html` classifies as
  `browser_or_security_adversarial`.

### Audit Gate

Before proceeding:

```powershell
npm run typecheck
npm run test:unit
npm run build
node .\dist\index.js benchmark loop --readiness fast --json
```

Audit the generated planner/QA context for one task in each risk category and
confirm the label appears in the evidence bundle.

## Phase 2 - QA Must Reject Weak Technical Strategies

### Problem

QA currently catches many executor safety issues, but broad coding tasks need
technical feasibility review. A plan can be command-safe and still doomed.

For `largest-eigenval`, QA should reject:

- naive power iteration without complex-eigenpair handling
- no timing harness
- no dominance check
- no hidden-style random matrix checks
- performance claims without measurement

### Research Before Implementation

Inspect:

- QA prompt construction in `src/pipeline.ts`
- `collectBoundedContractViolations`
- `buildBenchmarkVerificationPromptLines`
- `src/stages/benchmarkVerification.ts`
- Existing QA rejection tests

Look for where task-specific QA rules are easiest to inject without expanding
the monolith further.

### Implementation

Add risk-label-specific QA requirements:

For `numerical_performance`:

- The plan must identify mathematical edge cases.
- The plan must include a local correctness verifier.
- The plan must include a timing verifier if speed is part of the task.
- The plan must reject algorithms that are known not to satisfy the task class.
- The plan must not rely on randomness without deterministic seeding or a
  fallback.

For `git_stateful_merge`:

- The plan must use Git-native commands.
- The plan must create/checkout the required branches.
- The plan must verify branch existence before merge.
- The plan must verify the final file and examples after merge.

For `artifact_generation`:

- The plan must name the required artifacts exactly.
- The plan must include executable or round-trip validation.
- The plan must not complete after writing only helper code.

For `browser_or_security_adversarial`:

- The plan must inspect visible sanitizer/filter source before choosing payload.
- The plan must include an executable verifier when official pytest is not
  available.
- The plan must not use manual browser confirmation as proof.

### Acceptance Tests

Add tests where QA rejects bad plans:

- `largest-eigenval` plan with naive power iteration and no timing verifier.
- `write-compressor` plan that writes `data.comp` but does not run the
  decompressor.
- `merge-diff-arc-agi-task` plan that writes `repo/algo.py` directly without
  fetching bundles.
- `break-filter-js-from-html` plan that chooses event-handler payload before
  reading `filter.py`.

### Audit Gate

Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
```

Then run a dry/targeted planner path or benchmark smoke that confirms
`largest-eigenval` no longer reaches executor with a naive no-verifier plan.

## Phase 3 - Local Verifier Synthesis

### Problem

Broad coding tasks need local checks that approximate hidden tests. Babel often
uses the provided visible evaluator, but it does not reliably synthesize extra
contract checks from the task text.

### Research Before Implementation

Inspect:

- executor helper prompt in `src/stages/executorHelpers.ts`
- benchmark verification logic in `src/stages/benchmarkVerification.ts`
- post-write verification in `src/stages/verification.ts`
- test capabilities in `src/config/toolCapabilities.ts`

Review benchmark tasks and identify required verifier shapes:

- Python correctness/performance script
- artifact round-trip script
- CLI smoke command
- Git branch/merge invariant script
- exact output schema checker
- browser/security custom verifier

### Implementation

Introduce a `BenchmarkVerifierSpec` concept:

```ts
type BenchmarkVerifierSpec = {
  taskName: string;
  riskLabels: string[];
  requiredChecks: string[];
  suggestedHelperName: string;
  command: string;
  successCriteria: string[];
  failureFingerprintHints: string[];
};
```

The planner and executor should receive these specs. The executor should prefer
creating a small local verifier helper when the task contract is broader than a
single visible command.

Verifier examples:

`largest-eigenval`:

- generate seeded random non-symmetric matrices
- check `A @ v` close to `lambda * v`
- compare absolute dominant eigenvalue to `np.linalg.eigvals`
- time candidate and reference on the same matrices
- report which invariant failed

`write-compressor`:

- compile or run `/app/decomp`
- run `cat data.comp | /app/decomp > out.txt`
- compare byte-for-byte with `data.txt`
- check `data.comp` byte size

`pytorch-model-cli`:

- confirm `cli_tool` exists and is executable
- run `./cli_tool weights.json image.png`
- confirm stdout is only one digit
- confirm `prediction.txt` contains the same digit

### Acceptance Tests

Add unit tests for generated verifier specs:

- Each canary task produces a non-empty verifier spec.
- Performance tasks include timing and correctness checks.
- Artifact tasks include exact artifact names and round-trip checks.
- Git tasks include branch and merge checks.

### Audit Gate

Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
```

Then run targeted canaries:

```powershell
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks largest-eigenval --max-tasks 1 --job babel-autonomous-pilot10-verifier-spec-largest-eigenval
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks write-compressor --max-tasks 1 --job babel-autonomous-pilot10-verifier-spec-write-compressor
```

Promotion from this phase does not require both tasks to pass. It does require
the verifier evidence to be present and to drive repair/halt decisions.

## Phase 4 - Failure-State Machine For Repair Convergence

### Problem

The executor currently can keep patching after the recoverable command failure
budget reaches `3/3`. This wastes turns and hides the key learning signal.

### Research Before Implementation

Inspect:

- `src/pipeline.ts` around `recoverableCommandFailures`
- `src/stages/executorHelpers.ts`
- `src/stages/executorHelpers.test.ts`
- `src/services/haltDiagnosis.ts`
- `src/services/benchmarkAnalysis.ts`
- checkpoint metadata in recent failed run directories

Questions:

- Where is the recoverable failure budget incremented?
- Why does the budget remain effectively capped in log text but still allow
  continued patching?
- Which artifact records the failed command, stderr, and next patch target?
- Can we restore or mark best checkpoints safely?

### Implementation

Replace simple recoverable failure counting with a failure-state machine:

- `new_failure`
- `patch_pending`
- `rerun_required`
- `same_failure_repeated`
- `strategy_exhausted`
- `needs_replan`
- `needs_model_escalation`
- `halted_with_diagnosis`

Track failure fingerprints:

- command
- exit code
- normalized stderr tail
- failing test id
- assertion summary
- touched files since last failure
- whether the latest patch changed the failure

Rules:

- After a failed verifier/test command, the next mutating patch must be tied to
  that failure fingerprint.
- After one patch, the exact failed command must rerun before unrelated work.
- If the same fingerprint repeats twice, force replan or model escalation.
- If the repair budget is exhausted, stop generating normal executor turns.
- If a later patch makes results worse, restore or recommend the best checkpoint.
- `EXECUTOR_HALTED` must include the final fingerprint and the best-known patch.

### Acceptance Tests

Add tests for:

- repeated same failure causes `needs_replan`
- repeated patch without rerun is blocked
- exhausted budget halts or escalates instead of continuing to turn 20
- changed failure fingerprint resets the repeated-failure counter
- benchmark analyzer surfaces the failure fingerprint in the work packet

### Audit Gate

Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
npm run check:dist
```

Then rerun `largest-eigenval`. Passing is not required for this phase. Required
evidence:

- no repeated patch/test loop after budget exhaustion
- halt/replan/escalation occurs before turn exhaustion
- analyzer work packet names the repeated failure fingerprint

## Phase 5 - Best-Candidate Tracking And Checkpoint Selection

### Problem

Broad tasks often improve partially. Babel should not only know the latest
candidate. It should know the best candidate so far.

For `largest-eigenval`, a candidate might pass correctness but fail speed, while
a later candidate might fail both. The loop should preserve the best partial
state.

### Research Before Implementation

Inspect:

- checkpoint creation and metadata
- `10_session_context.json`
- `src/services/benchmarkAnalysis.ts`
- any existing run stats or diff summaries

### Implementation

After each local verifier/test run, record:

- command
- exit code
- total tests
- passed tests
- failed tests
- failing test names
- runtime metrics when visible
- files changed since previous checkpoint
- semantic score, if known

Define a simple ranking:

1. official reward pass
2. local verifier pass
3. most visible tests passing
4. fewer failure classes
5. lower runtime for performance tasks
6. smaller patch surface

When a run halts:

- include `best_candidate_checkpoint`
- include why it is best
- include current-vs-best regression notes
- suggest restoring best checkpoint before next attempt if latest regressed

### Acceptance Tests

Add tests for:

- best candidate updates when pass count improves
- best candidate does not update when failure count worsens
- performance metrics break ties for performance tasks
- analyzer emits best-candidate metadata

### Audit Gate

Run the local verification ladder and one failing canary. Confirm the evidence
bundle includes candidate ranking.

## Phase 6 - Model Escalation For Hard Coding Tasks

### Problem

Babel used a cheap/default route on a task that required deeper technical
reasoning. Broad autonomous coding should escalate earlier when task risk is
high.

### Research Before Implementation

Inspect:

- `src/services/modelEscalationRules.ts`
- `docs/architecture/BABEL_CLI_STAGE_WATERFALLS.md`
- model policy config
- cost and usage artifacts from recent runs

### Implementation

Add escalation triggers:

- `numerical_performance`
- `hidden_test_generalization`
- repeated same failure fingerprint
- failed local verifier after two materially different patches
- tasks requiring compiler/build/Git state where initial QA confidence is low

Escalation should be stage-specific:

- Planner escalation for algorithm-heavy tasks.
- QA escalation for feasibility critique.
- Executor escalation only after evidence-backed failed repair attempts.

Escalation output must be visible in artifacts:

- trigger
- stage escalated
- previous model
- selected model
- estimated cost
- reason

### Acceptance Tests

Add tests proving:

- `largest-eigenval` recommends planner/QA escalation.
- repeated same failure recommends executor or replan escalation.
- low-risk exact-output tasks do not automatically escalate.
- escalation metadata is serialized in run artifacts.

### Audit Gate

Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
```

Then run one targeted hard canary and confirm the model policy evidence shows
the intended escalation or explicit non-escalation reason.

## Phase 7 - Benchmark Routing Isolation

### Problem

The `largest-eigenval` run reported `Project_Games` even though the target root
was a benchmark app mirror. That can inject irrelevant project context and
mislead the planner.

### Research Before Implementation

Inspect:

- manifest project detection in `src/pipeline.ts`
- `inferProjectRoot`
- `resolveProjectRoot`
- benchmark runner invocation
- project latest pointer behavior

### Implementation

Benchmark runs should route to a benchmark-specific context:

- `target_project: "global"` or `"terminal_bench"`
- `target_project_path: <trial app root>`
- no unrelated project overlay
- no latest pointer pollution for `Project_Games`, `Project_Android`, or SaaS
  projects

Add a guard:

- If task text starts with `Terminal-Bench` or execution profile is
  `benchmark_container`, project detection must not infer workspace project
  families from path substrings outside the target root.

### Acceptance Tests

Add tests proving:

- Terminal-Bench app roots do not resolve to `Project_Games`.
- benchmark run manifests preserve exact `target_project_path`.
- project-scoped latest pointers are not written for unrelated project names.
- normal project runs still resolve overlays correctly.

### Audit Gate

Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
```

Then run a targeted benchmark and inspect `babel-result.json` for correct
project routing.

## Phase 8 - Analyzer And Work Packet Quality

### Problem

When a benchmark fails, the next fix should be obvious. The analyzer already
emits work packets, but broad coding failures need richer technical diagnosis.

### Research Before Implementation

Inspect:

- `src/services/benchmarkAnalysis.ts`
- verifier logs and CTRF parsing
- recent `largest-eigenval` and `break-filter` artifacts

### Implementation

Enhance work packets with:

- risk labels
- failure fingerprint
- best candidate checkpoint
- repeated-loop detection
- likely owner:
  - planner
  - QA
  - executor repair
  - verifier synthesis
  - model policy
  - benchmark routing
- targeted unit tests to add
- targeted canary command
- stop condition for the next iteration

Example `largest-eigenval` owner split:

- planner: selected weak algorithm
- QA: failed to reject weak algorithm
- executor: repeated same failure until turn exhaustion
- verifier: missing task-specific local check before official verifier

### Acceptance Tests

Add analyzer fixture tests for:

- `EXECUTOR_HALTED` with repeated verifier failures
- verifier failure after `COMPLETE`
- honest halt before official verifier
- exact-output deterministic repair pass

### Audit Gate

Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
node .\dist\index.js benchmark analyze /workspace-root/benchmarks/runs/terminal-bench-2/babel-autonomous-pilot10-20260429-r69-largest-eigenval-capability-smoke --json
```

Confirm the work packet points at the right failure class and next owner.

## Phase 9 - Targeted Canary Loop And Promotion

### Problem

Fixes need to validate themselves against diverse tasks before a full pilot. A
single `log-summary` pass is too narrow.

### Implementation

After Phases 1-8, run the diverse canary pack:

```powershell
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks log-summary-date-ranges --max-tasks 1 --job babel-autonomous-canary-log-summary
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks largest-eigenval --max-tasks 1 --job babel-autonomous-canary-largest-eigenval
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks merge-diff-arc-agi-task --max-tasks 1 --job babel-autonomous-canary-merge-diff
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks write-compressor --max-tasks 1 --job babel-autonomous-canary-write-compressor
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks pytorch-model-cli --max-tasks 1 --job babel-autonomous-canary-pytorch-model-cli
node /workspace-root/benchmarks/scripts/run_babel_terminal_bench_pilot.mjs --suite pilot10 --tasks break-filter-js-from-html --max-tasks 1 --job babel-autonomous-canary-break-filter
```

Analyze each:

```powershell
node .\dist\index.js benchmark analyze /workspace-root/benchmarks/runs/terminal-bench-2/<job> --json
```

Promotion to full pilot requires:

- `3/6` canaries pass or show a strictly improved halt mode.
- `0` false completes.
- no repeated repair loop past budget.
- routing isolation correct.
- analyzer work packets useful for failures.

Then run:

```powershell
node .\dist\index.js benchmark loop --readiness full --json
```

If the loop gate selects a full pilot, run the generated command.

## Implementation Order

Do the phases in this order:

1. Benchmark task-risk classifier.
2. QA technical-strategy rejection.
3. Local verifier synthesis.
4. Failure-state machine.
5. Best-candidate tracking.
6. Model escalation.
7. Benchmark routing isolation.
8. Analyzer/work packet quality.
9. Canary pack and full-pilot promotion.

Reason for this order:

- Risk classification gives every later phase a shared vocabulary.
- QA rejection prevents doomed plans from entering execution.
- Verifier synthesis gives the executor better feedback.
- Failure-state machine prevents waste after feedback repeats.
- Best-candidate tracking preserves partial progress.
- Model escalation becomes evidence-backed instead of blanket spending.
- Routing isolation removes unrelated project context.
- Analyzer improvements make the outer loop faster.
- Canary promotion prevents overfitting.

## Definition Of Done

The broad autonomous coding improvement plan is complete when:

- local readiness passes:

```powershell
npm run typecheck
npm run test:unit
npm run build
npm run check:dist
node .\dist\index.js benchmark loop --readiness full --json
```

- the diverse canary pack has current evidence
- at least `3/6` canaries pass
- `largest-eigenval` no longer reaches turn exhaustion through repeated same
  failure loops
- benchmark routing no longer mislabels benchmark app roots as workspace
  projects
- full `pilot10` reaches at least `5/10`
- every failure produces a repair packet that names the failure owner and next
  targeted fix

## Anti-Goals

Do not:

- add more product commands instead of improving task completion
- count old targeted passes as current evidence
- make the CLI silently self-edit during `benchmark loop`
- promote from exact-output tasks alone
- solve one benchmark by adding a hidden special-case answer
- loosen completion checks to get green output
- spend more model budget without a risk label or repeated-failure trigger

## Daily Use Checklist

1. Run readiness:

```powershell
node .\dist\index.js benchmark loop --readiness fast --json
```

2. Analyze latest failure:

```powershell
node .\dist\index.js benchmark analyze latest --json
```

3. Pick one owner:

- planner/QA
- verifier synthesis
- executor repair
- model policy
- routing
- analyzer

4. Patch one failure class.
5. Run:

```powershell
npm run typecheck
npm run test:unit
npm run build
```

6. Run the targeted canary for that failure class.
7. Analyze the new canary result.
8. Only run the full pilot when the gate calls for it or the canary pack is
   current enough to justify it.
