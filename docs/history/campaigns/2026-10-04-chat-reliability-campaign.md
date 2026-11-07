# Babel Chat Reliability: Executable Architecture and Campaign Specification

> **For the implementing agent:** Execute the campaign packets in Section 12 in dependency order. Use the active harness's planning, test-driven repair, and independent-review workflow. Where Superpowers is available, use `executing-plans` or `subagent-driven-development`; these are workflow aids, not new repository instruction authorities. Read the current root `AGENTS.md` before repository work.

**Goal:** Make the ordinary, clean-installed Babel Chat coding path produce a useful, correctly verified result—or a truthful, recoverable non-success—on a narrowly declared operating scope.

**Architecture:** Preserve Babel's in-process coordinator, mode controllers, executor, authority, context, evidence, and completion machinery. Add only the measurement/launch seams needed to exercise the installed artifact, then repair production behavior only in response to a reproduced qualification failure. The campaign observer measures outcomes; it never grants execution or completion authority.

**Technology:** Existing Babel TypeScript/Node ESM runtime, npm artifact tooling, current scripted-provider seams, real subprocess tests, Docker-backed `safe_repo`, existing clean-room grading, and current CI/review gates. No new orchestration framework or required third-party evaluation service.

**Spec and plan:** This file contains both the architecture contract and its execution plan. Recommended repository location: `docs/campaigns/2026-10-04-chat-reliability-campaign.md`. Do not create a second normative campaign document or another `AGENTS.md`.

**Prepared:** October 4, 2026.

**Source inspected:** `gthgomez/Babel`, `main` at `cf17c00da3c51678fd010ed645224686dcea94b0`, tree `ed77955f882bd4e7560c7ba3277a8747679b1137`.

**Status - October 4, 2026, implementation checkpoint:** The original-source Windows x64/Node 24.13.1 consumer-artifact build/pack/install and scripted mechanics passed. The explicit G01 variation's trusted host baseline/reference and handwritten grading controls passed. Local source repairs address reproduced Chat Go-route, secondary-critic identity and ordinary read-only admission failures; their controlled regressions are separate from installed-product proof. A repaired artifact has not yet been built or qualified. Product `safe_repo` controls and live task cells have not run: Docker remains unavailable, and the selected Go transport still requires a caller-owned budget, Windows-compatible durable reservations and known pricing under the native accounting policy. No full campaign qualification is claimed. Private campaign evidence retains artifact identities, controls, every failed attempt and these prerequisite observations. This specification itself grants no host execution, security changes, push, merge, publication, or deployment authority. Preserve and reuse valid, applicable owner grants rather than requesting them again.

**Owner amendment — October 4, 2026, 17:39:08 UTC:** The owner message relayed by the campaign manager authorized the existing OpenCode DeepSeek route after exact model confirmation and directed that implementing agents add no campaign/per-cell monetary ceilings or turn/request/repair limits. Its message provenance is retained in private campaign evidence. The operative clauses and authorization example below incorporate that direction. Record normal production CLI settings and resolved native limits without modifying them for this campaign. Retain the fixed task cohort, installed-artifact identity, ordinary authority/approval behavior, Docker-backed `safe_repo`, no host fallback, truthful unknown costs, and all other invariants. A campaign watchdog is an observation aid; it must not be injected as a product limit. This amendment grants no credential, security, merge, publication, or deployment authority.

**Owner model selection — October 4, 2026:** Use exact OpenCode Go `deepseek-v4.1-flash` for future live cells. The current [Go catalog](https://opencode.ai/zen/go/v1/models), [Go documentation](https://dev.opencode.ai/docs/go/) and [DeepSeek release](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) identify this version; the older `deepseek-v4-flash` is not a silent substitute. Record this as an experiment revision while preserving prior artifact/preflight results. Its existing transport requires a caller-owned durable budget and explicitly rejects native Windows reservations. Those prerequisites remain unresolved; neither model registration nor controlled older-model mechanics establishes the selected live path.

---

## 1. The decision

The campaign's governing rule is:

> Freeze a coding-loop experiment. Run the actual installed product. Use the observed failure to choose the smallest repair. Rebuild, reinstall, and rerun the unchanged experiment. Broaden only after the simple path works.

The freeze lasts through the declared qualification campaign, not merely until the first pass or failure. A first success demonstrates that a path exists. A small repeated matrix establishes only the explicitly tested qualification scope—not general reliability across models, repositories, operating systems, or arbitrary code.

The work order is:

1. Establish exact source, artifact, environment, authority, and measurement validity.
2. Reuse installed scripted mechanics; obtain a valid default-profile execution environment.
3. Use an optional, separately authorized host diagnostic only when it will isolate a real uncertainty.
4. Complete the installed, real-model Chat Golden Run under `safe_repo`.
5. Repair reproduced causes and rerun the same experiment.
6. Pass the seven-case contract matrix and the bounded live coding cohort on the final candidate.
7. Check ordinary interactive projection and issue a scoped qualification report.
8. Consider Plan/Deep reuse and further product work through a separate, evidence-informed decision.

A host diagnostic is not a prerequisite when `safe_repo` is already executable. Creating a host qualification profile must not become another project delaying the product proof. Nor is extending the runner mandatory before the first attempt: if the installed CLI plus existing capture/grading helpers can already produce valid evidence, execute that path directly and defer unnecessary runner changes.

**Initial target scope:** Windows x64, a pinned currently supported Node 24.x patch, the installed CLI in Chat/headless and ordinary native-terminal use, and a pinned Docker-backed `safe_repo` environment. Preserve existing Linux CI and process regressions. A Linux-only result is useful but cannot satisfy the Windows target; macOS, other architectures and other model routes require their own later qualification. Prefer the already-approved supported toolchain over introducing a toolchain upgrade for this campaign.

### Global constraints

- Babel only. Do not expand this campaign into other repositories or portfolio work.
- Preserve existing work, grants, safety gates, architecture budgets, and protected policy.
- Root `AGENTS.md` remains the sole repository contributor-instruction authority.
- Chat is the acceptance target. `chat-headless` is its installed noninteractive test surface, not a new orchestration mode.
- `safe_repo` remains the default product execution profile; no implicit host fallback.
- Do not weaken `dev_local` or `bench_local` to manufacture a passing run.
- Do not resurrect `AgentRunCoordinator` or make the daemon a universal authority owner.
- No new runtime, event ledger, memory system, agent framework, or acceptance engine.
- No live spending without a valid route-specific owner grant and valid native product admission. Record normal production limits and the owner's direction against added campaign ceilings; do not require or invent an additional numeric budget.
- No source-checkout runtime imports, automatic source rebuilds, or injected test-only permissions in a product-qualification cell.
- Preserve failure evidence; do not silently retry until a pass replaces the history.
- No claimed success from a skipped test, zero-test command, stale receipt, model prose, or an unobserved effect.

### Review focus

The highest-risk conditions are: accidentally launching the source build instead of the installed artifact; benchmark/test permissions leaking into product runs; a checker succeeding without exercising the required behavior; late cancellation/results affecting a successor task; and a correct patch being promoted despite incomplete verification, persistence, or shutdown. Each has an explicit test owner below.

## 2. Current-source grounding and corrections

These are observations from the inspected revision, not claims that the paths were executed during preparation.

| Observation | Consequence for this campaign |
|---|---|
| The CLI package is `babel-harness@0.1.1-preview.20261004`, with `babel-harness` and `babel-agent` launchers. [S2] | Use the actual package metadata and installed launcher. Do not revive older provisional names or the unrelated global `babel` command. |
| `runtime/coordinator.ts` already coordinates mode adapters and turn ownership; it explicitly does not verify, decide completion, mutate policy, or compile prompts. [S3] | Preserve the split. Coordination is not a replacement acceptance or authority engine. |
| `dev_local` is described as intrinsic host inspection only, with project-code tests/builds denied; `bench_local` also says project-code tests/builds are denied even though its tool list includes `test_run`. [S4] | A tool advertisement is not effective execution permission. Trace admission and the actual executor boundary before selecting a lane. |
| `test:consumer-artifact` already builds, packs, clean-installs, tests the installed CLI/TUI, and drives installed ChatEngine mechanics. [S5, S6] | Reuse it. Do not build another pack/install framework. |
| `installed_mechanics.mjs` uses scripted providers, real tools, an explicit disposable `dev_local` lease, benchmark flags, and host fallback. It exercises read-only denial, real red/green verification, cancellation, fresh-task isolation, and resume. [S7] | This is valuable installed mechanics evidence. It is not an ordinary-profile/live-provider proof. Its exceptional settings must not leak into the product lane. |
| `eval/canary/liveCell.ts` currently calls a source-oriented launcher, uses `ensureDist: true`, source-root cwd, and explicitly sets `BABEL_ALLOW_HOST_FALLBACK=1`. [S8] | The unmodified live canary cannot establish the proposed installed/no-fallback product proof. Add a narrow explicit runtime-target/boundary input or reuse an equivalent existing seam discovered at execution. |
| The live CLI matrix already has stable case IDs and distinguishes live, deterministic-stub, injected-failure, and harness attempts, but resolves a checkout `dist/index.js` by default. Its `--profile` means `fast/full`, not `safe_repo/dev_local`. [S9] | Reuse case machinery selectively; do not run the entire default matrix blindly or confuse matrix selection with execution policy. |
| Existing canary C01 is the one-file subtract-versus-add task. C02 inspects multiple files but its reference repair changes one. [S10] | Reuse C01 for the first proof. Do not count C02 alone as proof of a genuine two-file edit. |
| Root `AGENTS.md` requires exact-head review, current gates, explicit Git ownership, focused checks, and truthful evidence. [S1] | This campaign complements those controls; it does not introduce a competing merge mechanism. |

Old August/September roadmap checkpoints and earlier agents' local run reports are useful leads, not current implementation status or proof. Refresh relevant source and issue discussion, particularly the reliability hub #217, before fixing an old reported defect. An open issue may be a hypothesis or an already-addressed implementation awaiting acceptance evidence.

## 3. Scope and freeze

### Included

Installed launch and resource identity; provider-route admission; task/root/permission correctness; actual prepared requests; file inspection and mutation; targeted verification; failure classification and bounded repair; cancellation and owned-process settlement; fresh-task isolation; crash/resume; evidence capture; completion and exit truth; and client projection of those outcomes.

### Paused unless a reproduced campaign failure requires them

New Repo Hunt capabilities, Desktop/TUI features or redesigns, package-size optimization, installer/updater/signing projects, broad file moves, repository splitting, daemon consolidation, additional orchestration or agent features, new memory systems, broad prompt pruning, new providers, Plan/Deep enhancements, and speculative assurance implementation.

The freeze is not permission to ignore an active security/data-loss defect. Such a defect may stop the campaign and receive a bounded repair. Packaging or client fixes are allowed when they block the declared installed/interactive path. Otherwise record the opportunity and leave it out.

## 4. Architecture: preserve responsibilities, verify composition

### 4.1 Production flow

```text
Installed CLI / ordinary interactive client / existing protocol client
                            |
             Runtime coordinator + prepared turn
               (one active turn owner/generation)
                            |
                   Existing Chat controller
                            |
       Task + instruction/context projection + provider route
                            |
                  Actual prepared model request
                            |
                    Model proposes actions
                            |
        Existing authority/admission and execution policy
                            |
             Executor + owned process/tool attempts
                            |
          Settled observations + workspace revision + receipts
                            |
             Chat diagnosis / repair / next model request
                            |
            Existing honesty/completion decision boundary
                            |
              Durable terminal record + client projection
```

This is a responsibility map, not an instruction to create corresponding new classes or move files into new directories.

### 4.2 Ownership contract

| Responsibility | Existing owner family / inspected anchors | Required boundary |
|---|---|---|
| User input and display | CLI/interactive/protocol; Desktop as a consumer | Show runtime facts. Do not infer verification from text or process exit. |
| Turn coordination | `src/runtime/coordinator.ts`, existing mode adapters | Select one controller; fence stale owners; request cancellation; release ownership only through the established settlement path. |
| Task and permissions | TaskContract, instruction/authority/admission components | Trusted task and effective grants are not rewritten by summaries, model text, or the campaign runner. |
| Model behavior and repair decisions | ChatEngine and `agent/codingLoop/` | Models propose; controller enforces budgets, delivery, progress/recovery rules, and task lifecycle. |
| Context preparation | Existing prepared-request, compaction, P11/thread reconstruction paths | Budget the actual request; preserve task/authority identity and tool-result delivery through compaction/resume. |
| Physical execution | Existing tool executor, sandbox/process-ownership paths | Own the actual process attempt, output, cancellation and effect uncertainty. A requested cancellation is not proof of exit. |
| Evidence and verification | Existing session events, verifier receipts, revision binding and evidence coverage | Record what ran against which state. Unavailable or incomplete evidence cannot become qualifying evidence. |
| Completion | Existing honesty layer and `executorKernel.completion.decide` integration | Decide only within declared task/verifier scope. Keep process status, verification and task outcome distinct. |
| Hosting | Existing daemon when a surface uses it | May host IPC, queues and owned processes. Must not absorb policy, verification, or completion authority. |

### 4.3 Campaign observer

The observer is outside the worker's decision authority. Reuse the existing canary/consumer/matrix tooling to:

- create a disposable task workspace from a frozen fixture;
- launch the selected installed target with the selected environment;
- observe real tool/process effects and retained runtime events;
- capture baseline and final fixture bytes independently of the worker's changed-file list;
- grade the candidate with the frozen external behavioral oracle;
- compare runtime, client, and external observations;
- record the exact result, failure, and scope.

It must not write verifier receipts, replace completion decisions, grant capabilities, fabricate tool results, quietly patch the task, or replay unknown mutating commands.

The external grader must not defeat P isolation by executing model-modified candidate code directly on the host. A temporary directory or a helper named “clean room” is not evidence of OS-level isolation. Audit the existing grader execution boundary; reuse the approved isolated executor/container for P candidate grading. If that narrow path is unavailable, record the limitation and repair it or leave the product proof blocked rather than silently widening host execution. Baseline/reference controls contain trusted frozen code, but candidate output is still treated as untrusted execution.

For the deliberately small fixture, independent capture means enumerating and hashing all declared fixture inputs and resulting files, plus detecting unexpected additions/deletions/type changes. Exclude only explicitly declared runtime-output locations. This bounded observer does not implement or claim general whole-repository independent measurement under issue #280.

## 5. Mandatory invariants

| ID | Invariant |
|---|---|
| I01 | The executable, installed package, source SHA, dependencies, runtime, target root, mode, route, profile, grants, and test definition are known for every counted cell. |
| I02 | No new action may be admitted under a superseded task/turn owner. Late results stay attached to the attempt that produced them. |
| I03 | Model text, repository content, external tool output and compacted summaries cannot mint permissions or change trusted task authority. |
| I04 | A tool ID, logical operation, execution attempt and physical process are not interchangeable. Preserve existing identities; extend only when a reproduced collision requires it. |
| I05 | Tool failure/timeout/cancellation does not establish that no side effect occurred. Unknown effects are not blindly replayed. |
| I06 | Verification is bound to the current relevant workspace bytes, verifier identity/command, scope and environment. Later relevant mutation invalidates the applicable evidence. |
| I07 | Running an arbitrary successful command, finding zero tests, skipping required checks, or printing “PASS” is not qualifying verification. |
| I08 | Completion, verification, execution failure, budgets, cancellation, persistence and shutdown remain distinguishable. |
| I09 | Cancellation stops new admission, signals owned work, observes settlement or explicitly records unknown state, and cannot cancel a successor task. |
| I10 | Resume restores the correct physical root, task, current applicable permissions, durable evidence and unresolved attempts. It does not recreate authority from a summary. |
| I11 | New-task state does not inherit the previous task's failures, writes, verifier receipt, repair budget or cancellation owner as current truth. |
| I12 | Progress recognizes new evidence, legitimate inspection, changed hypotheses, useful edits and verifier movement. No-change requests do not have to mutate. |
| I13 | Actual request contents and delivered tool results are observable. Read deduplication respects file content, ranges and context epochs. |
| I14 | Unknown usage/cost/route metadata stays unknown. Provider failures are not implementation-repair attempts. |
| I15 | All failed and interrupted attempts are retained. A later pass does not replace the earlier result or establish a different artifact. |
| I16 | Clean exit includes the owned work that the surface promises to settle. A harness watchdog killing a hung product is a failed product exit, not successful cleanup. |

All “zero” targets later in this document mean **zero observed violations in the declared test cohort**; they do not guarantee behavior outside that cohort.

## 6. Result and state contracts

### 6.1 Separate dimensions

Use current runtime schemas as the source. The following are campaign projection fields, not a mandate to replace Babel's runtime enums:

```text
execution_status   running | completed | failed | cancelled | interrupted | unknown
verification       not_run | passed | failed | unavailable | stale | inconclusive
product_outcome    original authoritative Babel outcome, or null
failure_class      original cause plus campaign classification, or null
settlement         settled | not_started | outcome_unknown | cleanup_incomplete
qualification      pass | fail | blocked | inconclusive | not_run
```

A product may correctly return `BLOCKED` and pass an intentionally blocked scenario. The same outcome fails the success criterion for a solvable Golden Run. Track useful task success and truthful handling separately so the agent cannot improve the score by refusing everything.

A valid patch with passing tests but a process that hangs at exit is `patch/verification successful; product journey failed`. Preserve both facts. A subsequent turn cap must not erase actual patch/test evidence, but it must not count as a clean completed journey either.

### 6.2 Completion eligibility

For a Golden Run success, require all of the following:

1. The task and expected production edit are actually satisfied.
2. All required visible checks executed on the final relevant revision, with the expected test inventory and no required skips.
3. Babel's authoritative verification/completion records agree with the tool evidence.
4. The external frozen behavioral oracle accepts the candidate.
5. No prohibited fixture/oracle/package/config mutation occurred.
6. Runtime terminal event, durable record and public result agree within their declared schema meanings.
7. Owned processes settle, handles close and the installed command exits within the frozen watchdog bounds.
8. Required evidence can be inspected after the run.

The external grader does not retroactively authorize Babel's claim. A grader pass cannot rescue missing runtime verification. Conversely, a runtime receipt establishes only its declared check scope; it is not universal correctness. A hidden failure on an explicit task requirement fails campaign task acceptance even if a narrower visible test passed.

### 6.3 Cancellation and recovery

The cancellation sequence is: fence admissions; signal the current owner; settle or retain uncertain attempts; persist the outcome; release resources; project the final state. Internal acknowledgments may say cancellation was requested; clients may not present that as confirmed shutdown.

A resumed unknown action must first be reconciled through permitted observation. If its outcome cannot be established, stop that action with an explicit unknown outcome and preserve the work. Do not claim exactly-once behavior for arbitrary external effects. The fixture establishes only that its one controlled append was not replayed and its ambiguous history was not misrepresented.

## 7. Qualification lanes and environment policy

| Lane | Purpose | What it can establish | What it cannot establish |
|---|---|---|---|
| M: installed scripted mechanics | Existing `test:consumer-artifact` plus focused installed fault cases | Real installed modules/tools/persistence respond correctly to controlled provider events | Real-model task quality, ordinary grants, default isolation or general security |
| D: optional live diagnostic | Same installed artifact and task under an explicitly authorized, disposable diagnostic boundary | Helps isolate model/controller/tool behavior from a particular environment boundary | Default `safe_repo` qualification; equivalent isolation; general host execution safety |
| P: product | Installed launcher, real provider, ordinary Chat, default `safe_repo`, verified Docker/image, no fallback | Scoped live product path on the declared platform/model/environment | Other models/platforms, arbitrary repositories, Deep reliability, universal correctness |

### 7.1 Profile selection rules

First inspect existing admission and executor semantics. Current `bench_local` is **not** an assumed shortcut: its description denies project-code execution. `test_run` visibility does not overrule the lower execution policy.

Existing mechanics fixtures deliberately use `dev_local` plus explicit test-only grants and host fallback. That is an exception with a known purpose, not evidence that ordinary `dev_local` permits all project tests. Keep these settings local to their child process. Do not copy them into live product runs.

Use an existing authorized diagnostic mechanism only if it can exercise the real verifier without weakening product policy and without leaking authority into another cell. If no appropriate mechanism exists, record `DIAGNOSTIC_UNAVAILABLE` and continue toward P when possible. A new host-execution profile is a separate, explicitly authorized security design decision, not automatic campaign work.

### 7.2 `safe_repo` preflight

Verify the actual Docker server is usable by the selected user; the configured image exists and its digest is recorded; the workspace mount and working directory are correct; the declared interpreter/package manager exists inside it; and the verifier runs in that environment. A missing image/server/toolchain is an environment prerequisite outcome—not evidence of a coding defect and not permission for fallback.

Before inference, run the fixture's verifier on its known-buggy baseline and its known-good reference in separate disposable copies. The baseline must fail for the intended assertion; the reference must pass. Failure of either control invalidates the experiment and blocks live spending on that cell.

### 7.3 Differential diagnosis

Keep task, oracle, artifact, model and budgets matched when comparing D and P. Record unavoidable differences, including filesystem, grants, PATH, interpreters and tool output.

- D passes/P fails: prioritize investigation of the differing boundary; do not declare the environment proven guilty from one stochastic sample.
- Both fail similarly: investigate shared paths and shared setup as well as model behavior; this is not automatic proof of a controller bug.
- P passes/D fails: do not delay product qualification to perfect an optional host lane.
- Neither can execute the reference verifier: fix measurement/environment setup before diagnosing an agent.

Use trace alignment or a controlled provider replay where needed to distinguish an environment hypothesis from model variance.

## 8. Frozen experiment and provenance

### 8.1 Identity model

Maintain two distinct immutable identities:

**Experiment definition:** task text, fixture baseline, visible/hidden oracle versions, expected obligations, environment requirements, route policy, budgets, trial counts, fault triggers and scoring rules.

**Candidate:** source SHA/tree, package bytes/hash/manifest, installed dependency inventory, launcher identity, effective runtime configuration and selected environment.

A repair creates a new candidate. It must not alter the experiment to make the candidate pass. An intentional task/oracle/budget/environment change creates a new experiment revision with its rationale, and old results remain visible.

Freeze the baseline before execution. Do not derive “baseline SHA” from a Git query performed only after the worker has run. Store physical fixture snapshots as well as Git identity.

### 8.2 Required manifest contents

The frozen per-cell manifest records:

- campaign, experiment, candidate, cell and replicate IDs;
- exact source SHA, tree SHA, package name/version/SHA-256 and package manifest;
- installed package root, launcher, executable hash and installed dependency inventory hash;
- host platform/architecture, Node executable/version, Git executable/version;
- task/workspace physical identity, baseline file hashes, task hash and oracle hashes;
- requested model/route plus normalized/sent/observed identities when reported; unknown observed identity remains null;
- lane, execution profile, effective relevant grants, authority reference, environment allowlist and digest;
- Docker image digest, mount mapping, in-container toolchain and verifier argv/cwd for P;
- current native production limits, observational watchdogs, fixed cohort and cost authorization, including the explicit no-added-ceilings owner direction;
- fault trigger, expected outcome, expected test count and replicate plan;
- allowed artifact/state/cache roots outside the task's production files;
- evidence collection/redaction policy, source of each measurement and required fields.

Do not read or export credential files. Use the configured resolver and credential-presence checks; preserve secrets outside the fixture, source checkout, logs and manifests.

### 8.3 Budgets

Resolve the existing native production limits for the selected task and record them. Add no campaign/per-cell monetary ceilings or turn/request/repair limits. Do not copy the mechanics fixture's `maxTurns: 8` into a live run or remove normal product limits. Any owner-directed change to native settings creates a changed experimental input; it must be declared rather than introduced after observing a failure.

Proposed observer watchdogs for tiny fixtures are 600,000 ms per cell and 10,000 ms to observe owned cancellation after the cancellation request. They are observation bounds, not injected product limits, performance promises or permission to weaken native controls. A watchdog intervention is retained as a failed or interrupted product journey, including any earlier patch/test success. A platform-specific observer override must be declared before the cohort, not invented after a timeout.

Record the actual native model-request, output, repair, cost and wall settings, including any genuinely unlimited or unknown native setting. Record actual, estimated and unknown usage/cost separately; a conservative estimate is not an actual charge. The owner explicitly authorized no additional campaign monetary ceiling, so its absence does not block live calls. Missing route-specific authority, failed native admission, or an unresolved setting required by native policy still blocks dependent calls. Preserve source inspection and offline preparation while those dependencies are blocked. Stop on native product exhaustion or an applicable owner revocation; do not continue by weakening the product's controls.

### 8.4 Execution authorization record

Resolve this record from actual applicable grants before live execution. These are field names for the campaign record, not a new runtime permission system:

```json
{
  "authorization_reference": null,
  "provider_route": null,
  "model_id": null,
  "owner_amendment_reference": "owner amendment at 2026-10-04T17:39:08Z; provenance retained privately",
  "additional_monetary_ceiling": "none_owner_directed",
  "additional_turn_request_repair_limits": "none_owner_directed",
  "native_limits_record_path": null,
  "cell_watchdog_ms": 600000,
  "cancel_settlement_watchdog_ms": 10000,
  "watchdog_role": "observer_only",
  "product_execution_profile": "safe_repo",
  "product_host_fallback": false,
  "planned_live_task_cells": 12,
  "resolved_from_existing_authority": false
}
```

The null authority reference, route, model and native-limits record are unresolved execution inputs, not defaults or permission to proceed. This example must fail live preflight until those fields are resolved from actual owner authority and installed product configuration, and ordinary admission succeeds. The explicit `none_owner_directed` added-limit fields are resolved owner choices; they must not be rejected for lacking numeric ceilings. Native settings may themselves be finite, unlimited or unknown as the product reports, but native policy requirements must be satisfied. These unresolved live dependencies do not block offline design or deterministic authorized tests. The 12 planned live task cells exclude an optional route-health probe or diagnostic cell; separately list any additional inference under the existing applicable authority and native controls without adding a campaign spending cap.

### 8.5 Artifact validity

Build once for a candidate, capture the tarball and manifest, and reuse those exact bytes for its cells. Every source repair requires rebuilding/reinstalling a new artifact. A same-version filename is not an identity.

The runner must not load Babel runtime code from the source checkout, auto-rebuild it, or fall back to a global binary. The contributor-side driver and grader may live in the checkout, but the evaluated Babel executable and its runtime dependencies must come from the selected installation. Show this separation in the evidence.

## 9. Golden Run G01

### 9.1 Reuse the existing task

Start with C01 from `src/eval/canary/tasks.ts`: `src/add.js` subtracts where it should add. Use its existing workspace materialization and grading helpers. This is deliberately an easy integration proof, not a capability benchmark or navigation challenge.

Freeze this task text for the campaign variation:

> Fix `add(a, b)` so it returns the sum for the finite numeric inputs covered by this repository's tests. Inspect the implementation and tests, make the smallest production-code repair, run the required tests, and report the changed files and actual verification result. Do not change the tests, package scripts, or unrelated files. Do not install dependencies or use project network access.

Production baseline:

```javascript
export function add(a, b) { return a - b }
```

The frozen visible test contains four named cases: positive values, zero, negative operands and a negative result. The external oracle contains nine total named cases: those four repeated plus five additional checks for zero-zero, two mixed-sign outcomes and two exact binary-fraction outcomes. Use Node's built-in assertion module; no fixture package installation is necessary. The reference repair is addition. Define and hash the actual test bytes before the first trial.

This is an explicit C01 campaign variation, not a silent modification of historical C01 results. Keep original C01 intact and record the variation's fixture/oracle identity.

### 9.2 Grader validity controls

Before counting any run, the grader must reject four variants: the original buggy implementation; a comment-only "fix"; a hard-coded visible-case answer; and a deleted production file. It must accept one reference repair. These are five grading controls: four rejecting and one accepting. The two visible baseline/reference controls bring the preparation control total to seven. Verify that the hidden oracle is not present in the worker workspace or its supplied context.

Frozen visible tests and package scripts are task constraints. The observer must detect their modification even if the worker's changed-file list omits them. An external clean-room result protects scoring, not the worker's original verifier custody; record both.

### 9.3 Required observed sequence

The partial order is:

```text
valid setup and frozen authority
  -> relevant inspection
  -> approved production mutation
  -> real required verification on final relevant bytes
  -> authoritative terminal decision
  -> durable/public outcome agreement
  -> bounded clean exit
```

A baseline red test is useful and the external baseline control is mandatory. G01 does not require a model to make a bad first edit or to perform arbitrary rereads. Post-edit failure-and-repair is tested separately in R03.

G01 passes only with a correct bounded diff, required visible verification, a current runtime verifier receipt, external oracle acceptance, honest public/durable completion, retained evidence and no owned-process leak.

### 9.4 Progress instrumentation, not a new forced-edit policy

Capture time to first relevant read, first edit, first verifier and terminal outcome; calls before first edit; repeated action signatures; verifier movements; and context sizes.

An action signature should use operation, canonical target, relevant content revision, read range, context epoch and pertinent prior result—not just the tool name. A reread after mutation, a new range, or a post-compaction reread can be legitimate. A transient read-only retry after a provider/tool error can be legitimate.

Flag three equivalent no-new-information actions or a bounded planning stall for diagnosis. Reuse current controller limits to intervene; do not immediately add a universal “three reads then edit” rule. Observe whether existing recovery controls caused the stall before changing them. Fixing prompts is allowed when actual prepared-request evidence identifies a prompt defect; it is not excluded on principle.

## 10. Seven-case qualification matrix

The seven cases are contract families. Keep their evidence labels explicit. Scripted provider faults establish deterministic handling, not natural live-model behavior.

| Case | Fixture / trigger | Required acceptance | Main existing seam to reuse |
|---|---|---|---|
| R01 Single-file repair | G01/C01 campaign variation | Correct production edit, final real check, fresh receipt, truthful completion, clean exit | Canary tasks/live cell; installed mechanics |
| R02 Genuine multi-file repair | Two independent exported behaviors are wrong across two source files | Both behaviors repaired, both files appropriately changed, full declared behavioral checks pass, no unrelated edits | Canary task representation and clean-room grader |
| R03 Red verifier then repair | Controlled provider proposes an inadequate first edit; real verifier fails; next proposal must use observed failure and repair | Observed post-edit red -> discriminating evidence -> changed repair -> final green; no stale receipt or repeated identical mutation | S07/installed mechanics; recovery/localization/verifier receipt tests |
| R04 Legitimate no-change | Already-correct fixture; explicit read-only explanation request | No production mutation, useful answer, correct no-change outcome, no invented verifier or inherited stale receipt | Installed read-only/fresh-task cases |
| R05 Provider interruption | Controlled provider starts output, then fails before a complete response; also interrupt with a settled prior tool result | Typed provider failure, partial text not promoted, no invented complete call, settled work retained, clean shutdown | Provider-fault/Chat lifecycle tests |
| R06 Cancel during work | Real owned child with grandchild/heartbeat; cancel after an observed start barrier; then submit a fresh task | No new old-owner admission, owned work stopped/settled, no late-event pollution, fresh task unaffected | Process-tree, owner-fencing, Chat lifecycle tests |
| R07 Crash/unknown outcome/resume | A controlled append occurs, then the Babel parent dies before tool settlement; restart the same installed artifact | Unknown remains explicit; no replayed append; root/task/grants validated; work/evidence preserved; successor not contaminated | Existing crash-after-effect, resume identity and settlement tests |

### R02 exact behavioral requirements

Use a small, dependency-free range-filter fixture:

- `src/range.js` exports `isInRange(value, lo, hi)` with inclusive endpoints for valid finite numeric inputs.
- `src/filter.js` exports `filterRange(values, lo, hi)` preserving input order and returning the in-range values without mutating the input.
- Baseline `isInRange` incorrectly excludes endpoints.
- Baseline `filterRange` incorrectly ignores the upper bound.

Test both exported APIs directly, plus the combined behavior. This ensures actual repair across two modules without using lexical assertions about implementation style. Reuse the existing canary fixture representation; do not create another fixture engine. No requirement for arbitrary refactoring or a specific import statement.

### R03 live interpretation

Do not force a live model to make an erroneous patch solely to obtain a red-then-green trace. Use deterministic scripted proposals to verify the post-edit recovery branch with real filesystem/tool execution. Separately run a live failing-test task, such as the existing C04 variation, to show the model can diagnose an actual red test and repair it. Label whether a red result occurred before or after the model's first mutation. Do not claim measured natural live post-edit recovery unless it was observed.

### Embedded negative variants

Keep these within the relevant seven cases rather than launching more architectural tracks:

- R01/R03: missing verifier; zero-test exit 0; test modification; stale green receipt after a second edit; public “complete” with missing durable verification.
- R04: provider attempts a denied write; a prior task's red test/write/receipt must not create current mutation pressure.
- R05: provider quota/timeout must not consume implementation-repair allowance; incomplete tool JSON must not execute.
- R06: cancel-before-dispatch, cancel-after-dispatch, stale cancel against a successor, and normal exit with an owned daemon where that surface starts one.
- R07: wrong physical root/case-sensitive identity; missing/corrupt durable evidence; changed permissions; forced compaction/resume using existing fixtures. Do not disable default compaction in product cells to avoid the case.

Use deterministic barriers on observed lifecycle events, not guessed sleeps, to inject faults. Test watchdog cleanup must be separately recorded from successful product cancellation. Operate only on fixture-owned processes and disposable files.

## 11. Failure taxonomy and repair policy

### 11.1 Classification

| Class | Examples | Next action |
|---|---|---|
| EXPERIMENT_INVALID | Wrong artifact, faulty oracle, leaked hidden test, wrong launcher, missing baseline/reference control | Fix the measurement/launch setup before blaming the product; preserve invalid row |
| ENVIRONMENT_PREREQUISITE_MISSING | Docker/image/interpreter/toolchain unavailable | Restore the declared setup under existing authorization; do not weaken profile |
| ENVIRONMENT_EXECUTION | Mount/cwd/permissions/PATH/Windows pipe failure | Reproduce with the reference command and matched environment |
| AUTHORITY_POLICY | Needed operation actually denied, stale grant, profile mismatch | Distinguish intentional denial from defect; do not grant by retrying |
| PROVIDER_ROUTE | Wrong normalized/sent model, unexpected fallback, unsupported tool protocol | Repair route/admission or correct explicitly frozen setup |
| PROVIDER_SERVICE | Rate/quota, stream interruption, timeouts | Preserve typed cause; bounded transport policy; no code repair merely for quota |
| TASK_CONTEXT | Wrong intent, lost task, duplicate/conflicting instructions, missing delivered result | Inspect actual request and trusted task projection |
| NAVIGATION_PROGRESS | Repeated stale reads, planning loop, no discriminating evidence | Repair the producing boundary; do not demand writes for read-only tasks |
| MUTATION | Patch application, scope, partial write or encoding issue | Reproduce exact bytes/path/boundary; preserve user work |
| VERIFICATION | Wrong/missing/stale/weak checker or false completion | Repair checker selection/receipt/eligibility at its owner |
| REPAIR_RECOVERY | Repeating same failed strategy, wrong localization, lost result | Repair current coding-loop producer/controller seam |
| LIFECYCLE_PERSISTENCE | Ownership, cancellation, unknown replay, lost logs, resume mismatch, hang | Repair owner/settlement/persistence boundary |
| UNKNOWN | Evidence cannot distinguish causes | Add the smallest missing observation; do not invent a diagnosis |

Multiple contributing classes are allowed. Record the earliest observed failed boundary, the final outcome and the confidence in the diagnosis separately.

### 11.2 Failure-driven repair loop

For each reproducible failure:

- [ ] Preserve the original transcript/events, artifact identity, relevant bytes, actual requests, commands, outcomes and first-failure signature.
- [ ] Decide whether the experiment was valid. Run the reference controls before modifying runtime behavior.
- [ ] Locate the existing owner, its callers, and the closest regression suite.
- [ ] Add a failing test at that boundary, with a production-path integration assertion when the issue is wiring.
- [ ] Show the test fails for the intended reason on the candidate/base; do not simulate the desired failure with a mirror implementation.
- [ ] Make the smallest repair. No unrelated cleanup or broad architecture expansion.
- [ ] Run the focused regression and required adjacent contracts.
- [ ] Build/install a new artifact; rerun the unchanged experiment.
- [ ] Obtain fresh review for the actual changed candidate and retain rejected/repair/re-review evidence.
- [ ] Update the existing issue or bounded failure record with source/confidence/candidate/evidence; create a new issue only for a genuinely distinct reproduced problem and only within current write authorization.

If three attempted repairs in one defect family fail, stop producing more variants of the same patch. Re-examine the ownership boundary and causal trace. That is a diagnostic escalation, not permission for a new runtime or a lower gate.

## 12. Campaign packets

### CP00 — Freeze source, authority and experiment

**Dependencies:** none.

**Read:** root `AGENTS.md`; current branch/PR state; #217 and relevant current discussions; `babel-cli/README.md`; `package.json`; execution profiles; installed-consumer scripts; canary and live-matrix launch code; relevant existing tests.

**Produces:** privately retained source map, effective authorization/budget inventory, selected candidate, frozen G01 variation and oracle controls, seven-case mapping, lane decision and required evidence inventory.

- [ ] Refresh remote main and open PRs through current permitted tools. Preserve all dirty/untracked/ignored work; create an isolated worktree through the existing helper when implementation is authorized.
- [ ] Pin source SHA/tree and identify any relevant in-flight work to reuse instead of duplicate.
- [ ] Record applicable grants with provenance. An old approval for another campaign does not authorize this campaign's live spending or host/security changes.
- [ ] Inspect effective execution policy for the exact verifier; distinguish profile text, advertised tools and actual admission.
- [ ] Map current test/case IDs to R01–R07. Mark missing behavior explicitly, not merely missing test names.
- [ ] Materialize baseline/reference fixtures and demonstrate the intended red/green oracle controls without inference.
- [ ] Freeze experiment inputs, proposed watchdogs, real production limits and repetition plan before live calls.

**Exit:** experiment and candidate identity are known; offline controls are valid; blocked authority/environment is precisely named. Missing live authority blocks only dependent live steps.

### CP01 — Make existing qualification tooling address the installed product

**Dependencies:** CP00.

**Primary files to extend if current source still has the observed gap:**

- `babel-cli/src/eval/canary/liveCell.ts`
- `babel-cli/src/eval/canary/runner.ts`
- `babel-cli/src/eval/canary/types.ts`
- `babel-cli/scripts/run_coding_canary.ts`
- Existing tests adjacent to those modules.

**Only where needed for R05–R07:** extend `src/services/liveCliReliabilityMatrix.ts`, its CLI argument module, and existing installed mechanics/fault fixtures. Do not make all legacy matrix cases fit the campaign before G01 can run.

**Optional small new support file:** `babel-cli/src/eval/qualificationManifest.ts` and its colocated test, only if no existing validator can represent the frozen target/cell inputs. This is a contributor-side input validator; no execution, model calls, grants or completion decisions belong in it.

**Proposed interface additions—not present commands claimed as existing:**

```typescript
interface QualificationTargetV1 {
  schemaVersion: 1
  lane: 'installed_mechanics' | 'live_diagnostic' | 'live_product'
  runtime: {
    kind: 'installed'
    packageRoot: string
    launcherPath: string
    nodeExecutable: string
    sourceSha: string
    artifactSha256: string
    dependencyInventorySha256: string
  }
  execution: {
    profile: string
    hostFallbackAuthorized: boolean
    authorityReference: string
    environmentManifestPath: string
  }
  experimentManifestPath: string
}
```

Add a validated optional target input to the existing cell launcher/runner. Expose it to the contributor CLI as `--qualification-manifest <absolute-path>` only if a reusable equivalent is absent. The manifest references the frozen cell definition; it does not grant the powers described in it. Cross-check any task/model/profile CLI selection against the manifest and reject conflicts.

- [ ] Write tests rejecting missing target, hash mismatch, source fallback, unknown required fields, noninstalled paths and product host fallback.
- [ ] Test that the evaluated Babel runtime resolves from the selected installation even when the contributor checkout's `dist` differs.
- [ ] Route through the existing subprocess helper with the installed entry, `ensureDist: false`, task cwd and a sanitized per-child environment. Do not force source `BABEL_ROOT` into the product run.
- [ ] Remove benchmark auto-approval, dry-run, test leases, inherited host fallback and unintended model substitution from P; reject contradictory configuration rather than silently treating it as P.
- [ ] Keep M settings confined to the existing scripted fixture child. Do not alter its inference blocker to turn it into a live test.
- [ ] Capture pre-run baseline identity, observed execution boundary, actual route/request metadata, final runtime/durable outcome and artifact identity. Label configured versus observed values.
- [ ] Grade from current candidate bytes including deletions/unexpected fixture changes; require expected test execution, not generic exit 0.
- [ ] Test public/durable/grader disagreements and missing evidence. Do not simply expand legacy `claimed_complete` string matching and assume equivalence.
- [ ] Run focused tests, typecheck and consumer mechanics. Rebuild only the candidate being evaluated.

**Exit:** the minimum required launch/capture path can drive the actual installed artifact without source rebuild or boundary ambiguity. Scripted controls establish its truthfulness; no live success is yet claimed. If direct installed invocation already met this contract, record CP01 as reuse/no change; do not implement the proposed interface solely to check off the packet.

### CP02 — Execute the first valid Golden Run

**Dependencies:** CP00, valid reference controls and applicable live authorization. Use CP01 only to the extent existing direct installed invocation/capture cannot produce a valid proof; CP02 need not wait for a generalized runner or complete matrix support.

**Produces:** first valid installed real-model product attempt and a complete failure or success record.

- [ ] Run `test:consumer-artifact` and retain its tarball, SHA-256, manifest and observed results; classify platform omissions rather than inferring coverage.
- [ ] Install the selected artifact in a fresh prefix outside the checkout with isolated state/config/cache/evidence directories.
- [ ] Check installed version/help/setup/doctor and resolve the intended provider without dumping credentials. Provider presence is not authentication.
- [ ] Establish P environment readiness with the real Docker/image and baseline/reference verifier controls.
- [ ] Run D only when needed and authorized; otherwise record not required or unavailable. Never make a new host profile a prerequisite for P.
- [ ] Run exactly G01 through the installed `run --mode chat-headless` path with frozen model/task/root/budgets and normal P policy.
- [ ] Observe completion, evidence persistence and process exit; independently grade/capture the candidate.
- [ ] Classify the first break or record a first clean path success. Do not proceed to a larger live campaign while the experiment itself is invalid.

**Exit:** a valid product attempt exists; either G01 is clean or CP03 has an evidence-backed failure to repair.

### CP03 — Repair the first real blocker, not the roadmap

**Dependencies:** a CP02/CP04/CP05 failure.

**Files:** the source owner proven by the failure. Examples are `agent/codingLoop/*`, actual prepared-request/provider owners, completion/receipt owners, sandbox/process paths, or a client projection. File presence alone is not a reason to modify it.

- [ ] Follow Section 11.2's regression/repair/rebuild/rerun sequence.
- [ ] Preserve the model, task, oracle, environment and budgets for the comparison unless explicitly revising that experimental input.
- [ ] Recheck artifact and permission isolation after each launch-related change.
- [ ] Rerun G01 and affected contract cases on the new artifact.
- [ ] Stop on missing authority, irreversible-risk boundaries or exhausted native product limits; deliver a precise blocked handoff rather than weakening the gate.

**Exit:** the failure is repaired with boundary and installed-path evidence, or remains accurately blocked with preserved work. A code change alone is not completion.

### CP04 — Run the seven-case contract gate and live cohort

**Dependencies:** first clean G01; validated fault controls and remaining R01–R07 fixtures.

**Produces:** final-candidate deterministic matrix and limited live capability measurements, reported separately.

- [ ] Register missing cases through existing canary/matrix/installed mechanics representations. Implement R02 as a real two-file task; do not relabel C02 as two-file mutation evidence.
- [ ] Add deterministic lifecycle event barriers and real tools/processes for R03/R05/R06/R07; inject proposals/faults, not verifier receipts or completion outcomes.
- [ ] Execute three fresh replicates of each seven-case contract family on the declared primary product environment, using the appropriate controlled provider seam. Required negative variants must also pass.
- [ ] Execute three fresh live-product replicates each of R01, R02, R04 and a live failing-test repair task mapped to R03: 12 planned live task cells, subject to applicable owner authority, normal native product controls and the repository's current campaign gates; add no campaign limits.
- [ ] Preserve first and repeated failures. Do not run a default broad corpus, silently exceed current calibration gates, or retry a failed final cohort into a selectively reported success.
- [ ] Retain existing Linux/Windows CI coverage and platform-specific process tests. Qualification scope names only the environments actually tested; lacking native Windows evidence cannot be repaired by Linux success.
- [ ] Rebuild/restart the candidate cohort after a relevant repair. Reuse unaffected evidence only with an explicit unchanged-input basis.

**Exit:** all required contract cases/variants pass; no observed safety/honesty violation; all 12 planned tiny live cells satisfy their case's useful-success contract, or the scoped gate is blocked/inconclusive. This intentionally strict small-fixture gate is not a general benchmark target.

### CP05 — Ordinary user surface and scoped handoff

**Dependencies:** CP04 on the final candidate.

- [ ] Run a real installed interactive Chat task against the qualified fixture under P, followed by cancellation/exit observation through the actual client where supported.
- [ ] Use native terminal/PTY evidence for the platform being claimed; a pipe-only TUI startup test is not a complete terminal interaction proof.
- [ ] Verify public diff, verifier/evidence details and final result agree with durable events; inspect any launcher-owned daemon cleanup without redesigning daemon ownership.
- [ ] For Desktop, first determine whether existing runtime controls can run the same task/profile. Use a narrow parity check when it already can; otherwise record Desktop coding parity unqualified without starting a Desktop feature campaign.
- [ ] Run the required exact-head source/CI/review gates and preserve platform/persistence/permission caveats.
- [ ] Produce the final report and update the existing status/hub only within current write authorization. No new marketing or readiness claim beyond the tested scope.

**Exit:** a usable, reproducible scoped handoff—or a truthful incomplete/blocked report—with exact candidate, commands, evidence and next failure. Merge/publication remains a separate owner-authorized action.

### Deferred follow-through, not part of this exit gate

After scoped Chat qualification, identify proven mode-independent contracts and reuse them through existing Plan/Deep adapters. Plan remains non-mutating. Deep adds workflow choices, not a presumed reliability upgrade. Only extract code when duplication or a reproduced parity failure justifies it.

Then select trust-layer work by demonstrated risk, task need and measured benefit. Basic permission/verification honesty remains mandatory throughout; the full obligations, custody, delegated-authority and whole-worktree assurance roadmaps do not automatically become prerequisites. Never schedule issues merely because their numbers appeared in a prior review.

## 13. Command contracts and operator runbook

### 13.1 Existing commands, verified in the inspected source

Run these from an authorized, dependency-ready checkout. Installation/build commands can require approved package-network access. Help/list are discovery; a matrix invocation without those flags may run expensive work.

```sh
npm --prefix babel-cli run typecheck
npm --prefix babel-cli run test:consumer-artifact
npm --prefix babel-cli run reliability:matrix -- --help
npm --prefix babel-cli run reliability:matrix -- --list --json
npm --prefix babel-cli run benchmark:canary -- --plan --json --task C01 --provider mock --smoke
```

The consumer script writes its artifact identity under repository `artifacts/consumer-package/`, including `manifest.json` and `SHA256SUMS`. Keep these as local/approved evidence, not blindly staged repository content. The consumer script's network guard is not a claim of arbitrary child-process network isolation.

Use the installed package's `--help`/`run --help` to confirm flags on the exact candidate. The inspected canary currently invokes:

```text
run --mode chat-headless --model MODEL --json --project-root ROOT TASK
```

Its current `--yes` and host-fallback behavior must not be treated as permission. In P, approvals must come from the ordinary authorized path, not a benchmark exception. Use argv arrays and the repository's Windows launcher helpers; do not interpolate untrusted task text into shell commands.

For a locally supplied verified tarball, the documented install shape is:

```sh
npm install --prefix /absolute/disposable/install --omit=dev /absolute/path/to/verified-artifact.tgz
```

On POSIX the normal shim is `node_modules/.bin/babel-harness`; on Windows it is `node_modules/.bin/babel-harness.cmd`. Resolve paths from the actual installation instead of assuming a global executable.

### 13.2 Proposed command after CP01, not available by assertion

Only after the new optional manifest argument exists, has help/tests, and is validated on the candidate:

```sh
npm --prefix babel-cli run benchmark:canary -- \
  --provider live --i-authorize-live --task C01 --smoke \
  --model EXACT_APPROVED_MODEL_ID \
  --qualification-manifest /absolute/private/frozen-cell.json
```

The Boolean flag acknowledges a request; it does not establish owner spending authority. The frozen manifest and existing admission must agree. C01 selects the explicit campaign variation recorded in that manifest; reject silent task overrides. For three trials use the existing non-smoke selection with `--trials 3`; current smoke is exactly one C01 trial.

Do not automatically invoke the full live matrix or the entire canary suite. Select current stable case IDs returned by `--list`, and record any mapping to R01–R07.

### 13.3 Required manifest validation rules

A `frozen-cell.json` is generated from CP00's resolved configuration, not filled with guessed values. Reject it before inference when:

- an identity/hash, physical root, required environment input, applicable route-specific grant or native setting required for product admission is missing; the owner's explicit no-added-ceilings choice is valid and is not a missing finite limit;
- the selected launcher/package does not match the recorded artifact;
- `live_product` includes host fallback, benchmark permission flags, dry-run or a scripted provider;
- model/task/fixture/oracle selection conflicts with the experiment;
- credentials appear in manifest values;
- the P image/command controls were not demonstrated;
- the artifact or fixture changed after validation;
- a referenced grant is missing, expired, inapplicable or cannot be established.

Unknown observational metadata, such as a provider that does not disclose its backend model revision or actual cost, is recorded as unknown-not fabricated. Missing *required authority or native safety inputs* blocks the call; unavailable *optional observation fields* narrows the claim. Additional numeric campaign/per-cell ceilings and turn/request/repair caps are not required and must not be introduced.

## 14. Evidence package and scoring

Use existing output conventions where available. The logical contents below can be an index over existing files; do not copy the same raw transcript into multiple new ledgers.

```text
campaign evidence root/
  campaign.json                 frozen experiment, cohort and authorization references
  source-map.md                 audited owners/call paths and confidence
  artifact/                     tarball, hashes, pack/dependency inventory
  environment/                  redacted host/container/verifier readiness
  fixtures/                     baseline/reference/oracle identities; no secret data
  cells/<candidate>/<case>/<replicate>/
    launch.json                 actual argv, executable identity and sanitized environment
    result.json                 separated execution/verification/qualification dimensions
    trace-index.json            references/hashes to actual runtime events and raw logs
    observations.json           independent fixture/process/check observations
    diff.patch                  actual bounded candidate diff
    grader.json                 external behavioral result and checker identity
    failure.json                when relevant; original cause, confidence and repair link
  report.md
  results.jsonl                 one row for every attempted cell, including invalid/blocked
```

The worker must not have permission to rewrite the evaluator's hidden oracle or final campaign results. Retain raw request/response content only in a permitted private location after secret handling; public reports contain redacted summaries and safe identifiers. Hashes establish retained-byte identity, not trusted custody by themselves.

Each counted result includes source/artifact/experiment identities; lane; platform; requested/sent/observed route; actual checks/counts; outcome and reason; mutation/receipt revision; model/tool calls; repair episodes; compactions; wall time; known/estimated/unknown usage-cost basis; and process/evidence closure. Record excluded/skipped cells explicitly.

### 14.1 Fixed cohorts

There are separate denominators for deterministic contract handling, live useful task success, provider availability, and end-to-end product success. Honest refusal is not a successful coding result on a solvable task. Expected cancellation can be correct scenario handling without being task completion.

For the final candidate, preregister three live replicates per selected live case. Use the first scheduled valid cohort, not the best three successes. An invalid experiment remains in the attempt ledger but is not a valid capability measurement. A provider outage on a valid launch remains visible in availability and product-path results; it does not magically become a coding defect or disappear from all denominators.

A new candidate or explicitly changed environment/experiment can have a new cohort; retain the previous one and why it changed. Repeated attempts on unchanged inputs are attempts, not evidence of a repair.

### 14.2 Gate

A scoped qualification report may pass only when:

- all required installed mechanics and seven-case deterministic/real-tool contracts pass;
- the planned 12 tiny live task cells meet their useful success/no-change contracts under P;
- there are zero observed false verification claims, unknown-effect replays, cross-task contamination, permission expansion, or stale-evidence acceptance;
- required cancel/normal-exit/resume behavior settles as declared;
- the ordinary interactive check passes for the claimed platform;
- source, artifact, environment, oracle and final review/CI identities are current;
- no required row or evidence source is silently missing.

A failure is not a reason to relax this gate mid-cohort. If this proof is too expensive or the environment remains unavailable, finish with a narrower mechanics/live-path report or an explicit block. Do not advertise the full qualification badge.

The report wording should be of the form:

> Candidate [SHA], installed artifact [SHA-256], was qualified for the declared Chat tasks on [platform/runtime], [provider/model], under [profile/image], with [observed counts] and [limitations]. Scripted fault handling and real-model results are reported separately. Other environments, modes and broader production correctness remain unqualified.

## 15. CI, collaboration and change management

### 15.1 Test lanes

**Every relevant PR:** focused source regression, typecheck, installed-consumer mechanics, affected deterministic lifecycle contracts and the repository's current mandatory security/portability/metadata checks. No ambient provider inference. Do not duplicate the full legacy suite into a second workflow.

**Candidate qualification:** explicitly owner-authorized real-provider cells using normal native product settings, without added campaign limits, plus required platform/runtime validation. External-service flakiness belongs in a separately reported qualification result, not hidden inside a nominally deterministic unit gate.

**Client scope:** preserve required existing client checks; add only the interactive/outcome evidence necessary for this campaign. No visual redesign prerequisite.

### 15.2 Team shape

Use one campaign/integration owner and one writer for shared Chat/runtime code. Independent workers may handle the bounded fixture/measurement gap, environment reproduction, or read-only review on disjoint paths. Do not turn this into six parallel architectural workstreams.

A fresh reviewer can come from any available harness/model with real independent execution context. Reviewer prose does not grant Git permission. The managing owner performs authorized Git mutations under current repository policy; no fabricated review provenance or automatic merge bypass.

A useful split is three roles: integration/repair owner; qualification/fixture investigator; fresh independent reviewer. Run fewer when dependencies make parallelism wasteful.

### 15.3 Integration

Use current main or the explicitly authorized candidate as the base, preserve unrelated work and stage only known ship paths. Follow the existing preflight, public-content/secret scans, exact-head review and gate/merge wrappers. Do not infer current required checks from an old PR description.

Main moving during an experiment does not rewrite its historical identity. Refresh before integration and determine what changed. After a merge/rebase affecting the evaluated inputs, rebuild and qualify the resulting artifact; historical qualification may be reused only with a stated unchanged-input basis.

Publication, release tags, native installers, environment security changes and irreversible actions remain separately authorized. This document has not performed them.

## 16. Stop conditions and blocked handoff

Stop the affected execution lane when applicable route authority, credentials, required native admission inputs, a valid oracle, artifact identity or the required environment cannot be established. A missing assistant-added finite budget is not a stop condition under the owner's amendment. Stop on native product exhaustion, unexpected host fallback, data loss, unauthorized writes, inability to contain owned processes, compromised evidence, or a proposed change requiring new security authority.

Continue independent safe work when possible: source mapping, offline regression design, preserving evidence or validating the measurement path. Do not respond to one blocked live dependency by stopping all useful engineering; do not bypass it either.

The handoff must contain:

- exact branch/base/head and artifact identity;
- the experiment/cell that failed or is blocked;
- command/argv, exit/status, relevant trace reference and first failed boundary;
- observed versus inferred cause and remaining uncertainty;
- changed/excluded paths and preserved unrelated work;
- checks passed/failed/skipped, including their source/platform/environment;
- the next smallest authorized action;
- any genuinely missing grant/prerequisite and why it is needed;
- merge/publication state separately from cleanup state.

## 17. Acceptance checklist for the campaign itself

- [ ] Current source and relevant prior work reconciled; no duplicate runtime/framework/ledger.
- [ ] One frozen experiment definition with separate candidate identities.
- [ ] Existing consumer artifact path reused and installed target proven.
- [ ] `dev_local` and `bench_local` restrictions preserved; exceptional mechanics settings cannot leak into P.
- [ ] Host diagnostic either authorized/executed or explicitly not needed/unavailable.
- [ ] `safe_repo` verifier baseline/reference controls pass without host fallback.
- [ ] G01 completed by the installed real-model Chat path.
- [ ] Observed failures have boundary tests, minimal repairs and rebuilt-artifact reruns.
- [ ] Seven-case matrix and negative variants complete on the final declared scope.
- [ ] Preregistered live cohort reported without cherry-picked retries.
- [ ] Interactive outcome/exit check performed; Desktop scope separately honest.
- [ ] Known/unknown verification, costs, environment and recovery states remain separate.
- [ ] Required exact-head review and CI state recorded.
- [ ] Scoped report delivered; no unsupported readiness/parity/security claim.

## 18. Launch instruction for the implementing agent

> You own the bounded Babel Chat reliability campaign in this specification. Begin at CP00. Refresh current main, open work, `AGENTS.md`, and the existing qualification owners. Preserve grants, work and safety policy. Reuse installed consumer mechanics and the current canary/matrix tooling; correct only the installed-target/boundary measurement seam needed for the proof. `bench_local` advertising `test_run` is not evidence of permission. Do not weaken `dev_local`, auto-enable host fallback, resurrect `AgentRunCoordinator`, or redesign daemon ownership. A host diagnostic is optional and separately authorized; `safe_repo` is the product proof. Freeze G01 and its oracle before execution. When it fails, preserve the trace, reproduce the failed boundary, add a failing test, make the smallest repair, rebuild/reinstall, and rerun the same experiment. Do not widen the roadmap. Then execute the fixed seven-case contract gate and bounded live cohort, distinguishing scripted faults, live quality, truthful blocking and useful task success. Reuse valid authorizations without repeatedly asking; retain normal native settings and add no campaign monetary or turn/request/repair limits. Stop dependent actions where applicable authority, required native admission inputs or environment is genuinely missing, or native product limits are exhausted. Return exact source/artifact identities, all attempted results, evidence, remaining risks and the next smallest action. Do not claim completion from code presence, unit-test counts or one lucky run. No merge/publication or security change beyond the owner's applicable authorization.

## 19. Pinned source references

The source files below were inspected during preparation. Assertions about what exists are source observations; proposed interfaces, task variations, cohort counts, watchdogs and campaign packets above are design decisions, not already-shipped features.

- **S1 — Contributor policy and ownership:** `AGENTS.md`, inspected source [pinned file](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/AGENTS.md).
- **S2 — Package identity, scripts and runtime floors:** [package.json](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/package.json).
- **S3 — Runtime coordination boundary:** [runtime/coordinator.ts](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/src/runtime/coordinator.ts).
- **S4 — Execution profiles:** [config/executionProfiles.ts](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/src/config/executionProfiles.ts).
- **S5 — Installed preview/consumer documentation:** [babel-cli/README.md](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/README.md).
- **S6 — Clean install and artifact verification:** [scripts/verify_consumer_artifact.mjs](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/scripts/verify_consumer_artifact.mjs).
- **S7 — Installed scripted Chat mechanics:** [scripts/installed_mechanics.mjs](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/scripts/installed_mechanics.mjs).
- **S8 — Current live canary launch, provenance and grading:** [eval/canary/liveCell.ts](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/src/eval/canary/liveCell.ts).
- **S9 — Existing reliability matrix and CLI:** [services/liveCliReliabilityMatrix.ts](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/src/services/liveCliReliabilityMatrix.ts), [CLI argument contract](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/src/services/liveCliReliabilityMatrixCliArgs.ts), [script](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/scripts/live_cli_reliability_matrix.ts).
- **S10 — Existing coding fixtures:** [eval/canary/tasks.ts](https://github.com/gthgomez/Babel/blob/cf17c00da3c51678fd010ed645224686dcea94b0/babel-cli/src/eval/canary/tasks.ts).

**Original preparation provenance — October 4, 2026, supplied specification author:** The original author stated that no Babel build, package installation, provider inference, Docker task, live coding run, native Windows terminal test, Git mutation, PR or merge was performed while preparing the supplied specification. That statement describes the original preparation only. Subsequent implementation completed the consumer build/pack/install, installed scripted mechanics and trusted handwritten host controls described in the current status above. Docker-backed P controls, provider inference, live coding cells and native-terminal qualification remain not run; Git worktree/preflight operations occurred, but no staging/commit/push/PR/merge or publication occurred.
