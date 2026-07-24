<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel CLI Command Contract

Date: 2026-06-05 (amended 2026-06-07)

This document is the canonical user-facing command contract for the simplified Babel CLI.

Target product identity:

```text
Babel default       = daily coding path
Babel plan          = approval-first planning and apply
Babel deep          = critique/refine/governed execution
Babel chat-headless = CI/testing path with JSON output
```

## Active Entry Path

```text
babel
-> babel-cli/bin/babel.js
-> babel-cli/dist/index.js
-> babel-cli/src/index.ts
-> rewriteArgv()
-> deprecation shim for removed surfaces
-> babel-cli/src/commands/workflowCommands.ts
```

Removed bins (`bl`, `babel-lite`) and removed verbs (`lite`, `ask`, `do`, `fix`, `full`, `propose`, `patch`, `review`) exit `1` with stderr hints. Bare `babel "<task>"` rewrites to hidden `daily` → `AgentSession`.

## Target Commands

| Command | Target behavior | Mutation policy | Current status |
| --- | --- | --- | --- |
| `babel "..."` | Default daily path that routes by intent. | Safe by default; read-only requests stay read-only, clear implementation requests may mutate after plan and verification gates. | Implemented via bare task routing and the Lite/full intent contract. |
| `babel plan "..."` | Produce an implementation plan, run a separate review agent (warn only), ask for approval, then apply and verify in the same flow after approval. | No mutation before approval. | Implemented via plan lane, `planReviewLane`, and approval-first terminal flow. |
| `babel deep "..."` | Run the heavier critique/refine/governed path for higher-risk work. | May mutate after governed plan and verification gates. | Implemented via governed pipeline execution. |
| `babel undo` | Restore the last checkpoint or show recovery state. | Mutates only through explicit restore behavior. | Implemented via `undoLane` → `restoreCheckpoint`. |
| `babel resume [run]` | Resume a retryable run. | May continue a prior mutation lane. | Implemented. |
| removed `bl`, `lite`, `ask`, `do`, `fix`, `full`, `propose`, `review`, `patch` | One-release shim only. | N/A | Exit `1` with stderr hints; not executable. |

## Execution Modes: Demo vs Real

The default implementation path supports distinct execution modes. Docs and JSON output must keep them separate.

| Mode | Trigger | Scope | JSON signal | Daily-worker proof? |
| --- | --- | --- | --- | --- |
| **Offline demo** | compatibility fix path with `--provider mock` or `BABEL_LITE_OFFLINE=1` | **Fixture/demo repos only** (e.g. `lite-trust-demo` scenario) | `execution_mode: offline_demo` when mock active | No — validates checkpoint/verify/undo plumbing only |
| **Real daily fix** | Default `babel "fix ..."` with provider credentials | Ordinary repo tasks | `execution_mode: live` (or omitted when live is default) | Yes — requires provider-backed pass on non-fixture work |
| **Failure recovery** | Network/credential failure during live fix | Any repo | `LITE_FAILED`, `recoverable`, actionable `next` | N/A — honest degradation, not success |

Rules:

- `--provider mock` and `BABEL_LITE_OFFLINE=1` are **fixture/demo scope only**. They must not be documented as the default daily path or as proof of arbitrary-repo fix without keys.
- Mock/offline success must not upgrade `claims-matrix.md` "daily worker" wording.
- Provider failures must return structured `next` steps (credential check, `babel undo`, retry guidance).

## Required Output Shape

Every Lite command should expose the same human and JSON result categories:

```text
Status
Mode / selected lane
Route decision metadata in JSON/artifacts:
  - selected_lane
  - route_reason
  - complexity
  - risk_signals
  - model_tier_recommendation
  - full_babel_equivalent
  - intent.task_kind
  - intent.write_intent
  - intent.write_confidence
  - intent.mutation_allowed
Provider or offline mode when applicable
Scope
Files inspected
Files changed
Verification
Checkpoint / restore command when mutation occurred
Artifacts
Usage
Next command
```

No user should need to open raw run JSON just to learn whether a Lite command succeeded, mutated files, skipped verification, or wrote a recovery artifact.

## Artifact Target

The target Lite artifact layout is:

```text
runs/babel-lite/<run-id>/
  manifest.json
  request.json
  response.md
  plan.md
  proposal.diff
  patch.diff
  changes.diff
  verification.json
  checkpoint.json
  cost_ledger.json
  failure.json
```

Not every command writes every file. The important contract is predictability:

- ask writes answer evidence (provider-backed ask may also keep detailed pipeline evidence under repo `runs/`; plan/propose/review/undo use `runs/babel-lite/`)
- plan writes plan evidence under `runs/babel-lite/`
- propose/diff/patch writes proposal evidence under `runs/babel-lite/` and does not mutate source files
- fix writes change, verifier, checkpoint, `changes.diff`, and failure/recovery evidence as applicable (mutation evidence may remain under repo `runs/` for small-fix compatibility)

## Non-Negotiables

- `babel plan` must not edit files before explicit approval.
- `babel "<task>"` must route ambiguous tasks to a read-only or plan lane.
- `babel "<task>"` must keep questions, comparisons, audits, diagnostics, recommendations, and explicit no-write requests out of mutation lanes.
- Complex read-only default-path planning may run read-only critique, but the lead lane remains read-only unless the user explicitly requests deeper governed execution.
- Clear implementation requests through `babel "<task>"` may route to the implementation path or `babel deep` when risk warrants it.
- `babel "<task>"`, `babel plan`, and `babel deep` must expose routing and intent metadata in JSON/artifacts. Default human output should stay concise and show only user-actionable route notes.
- `--lite-only` must refuse truly Full-required work instead of silently widening scope.
- Provider failures must produce an actionable next step.
- Verification failure must not be reported as success.
- Mutation without checkpoint must be refused or explicitly reported as unrecoverable.
- `babel plan` must succeed without Manual Bridge (`babel apply`, clipboard handoff, or `manual/plan.json`).
- full `babel run` remains for advanced pipeline controls under `babel advanced`.

## Fresh-Clone Proof Commands

Run from a fresh checkout in PowerShell after `npm install`:

```powershell
npm --prefix .\babel-cli run build
npm --prefix .\babel-cli run test -- --test-path-pattern="agent|workflowCommands|argv|liteUsability|checkpoints|ciReview"
node .\babel-cli\dist\index.js benchmark lite --json
node .\babel-cli\dist\index.js benchmark production --json
npm run test:public-release
```

Expected Lite benchmark: `8/8` scenarios routed through `babel "<task>"`, `babel plan`, and `babel undo` with daily intent classification (`ask`, `plan`, `patch`, `fix`, `undo`), `fail: 0`.

Quick manual smoke after build:

```powershell
babel "what does this repo do?"
babel plan "outline a safe refactor"
babel "what should we implement next?"
babel deep "harden the implementation plan"
babel "fix a failing test"   # optional; requires a scoped failing fixture
babel undo                   # after a fix run with checkpoint
```

`babel plan` must exit success with artifacts under `runs/babel-lite/` and must not mutate tracked source files before approval. Production benchmark must keep `claim_ready: true` for the scoped DeepSeek-backed governed lane.

Excluded from this proof batch: mutating live subagents, universal mandatory verifiers.

## Permission Presets

Daily Lite work should be described with user presets, not internal pipeline mode names.

| Preset | Maps to | Behavior |
| --- | --- | --- |
| `--read-only` | execution profile `read_only_audit`, approval `suggest` | No file edits or shell execution; read-only tools only |
| default | execution profile `safe_repo`, approval `auto-edit` | Safe workspace writes; implementation runs require checkpoint evidence |
| `--ask` | execution profile `safe_repo`, permission policy `ask_before_mutation` | Prompt before mutating actions |
| `--auto` | execution profile `safe_repo`, approval `full-auto` | Trusted auto-edit with sandbox and policy gates still active |

Pipeline modes (`direct`→`chat`, `verified`→`deep`, `manual`→`plan`, `autonomous`→`deep`, `parallel_swarm`→`deep` with swarm) are advanced-only controls on `babel run`. Default `babel --help` must not surface them.

## Consolidated User Surface (locked 2026-06-10)

Daily teaching surface:

```text
babel "<task>"
babel chat-headless "<task>"
babel plan "<task>"
babel deep "<task>"
babel undo | babel resume | babel doctor
babel advanced
```

Removed compatibility verbs exit before Commander dispatch and print stderr hints pointing to the canonical commands.

Human terminal output uses plain Mode labels (for example "Read-only answer", "Scoped fix", "Governed deep execution") instead of internal lane ids (`lite_fix`, `deep_lane`).

Pipeline modes and execution profiles are **advanced-only** on `babel run` (via `babel advanced`). `babel plan` and `babel deep` use safe defaults internally.

## Old Provider-Contract Lite Status

`babel-cli/src/commands/liteCommands.ts` and `babel-cli/src/lite/` contain an older provider-contract implementation. It has useful behavior, especially provider-backed ask/patch artifacts, but it is not the canonical first-use contract.

Roadmap target: rename or absorb this older path as an internal text-provider lane. It should not define the product meaning of Lite.

## AgentSession (Accelerated Core Requirement)

`runLiteCommand` dispatches through one `AgentSession` loop. The multi-turn observe→act loop is a **core product requirement**, started in parallel with trust/fix work — not deferred until all verb lanes are complete. Target convergence:

```text
build repo context
-> ask provider for normalized action
-> validate action against permission policy
-> execute through sandbox/tool executor
-> return observation
-> repeat until done, blocked, or verifier/recovery gate fires
```

Provider APIs are reasoning engines inside this loop. They do not get direct authority over files, commands, network, checkpoints, or verification.

## Parity benchmark (Wave 6)

Measured parity is separate from daily-worker trust demos. Use:

- `npm --prefix .\babel-cli run parity:run-babel` — repeatable Babel cells for parity tasks `small_bug_fix` and `failing_test_repair` (offline_demo fixture scope).
- `node .\babel-cli\dist\index.js benchmark parity --fixture <path> --json` — merge measured cells before parity claims.

See the Parity Benchmark guide in docs/guides/. `claim_ready` stays false until all 24 matrix cells are externally measured.
