<!--
status: ACTIVE
last_verified: 2026-08-15
-->
# Babel CLI Command Contract

Date: 2026-06-05 (amended 2026-06-07; reconciled against runtime 2026-08-15)

This document is the canonical user-facing command contract for the Babel CLI.

Target product identity:

```text
Babel default       = daily coding path (chat)
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

Bare `babel "<task>"` rewrites to `babel run "<task>" --mode chat` and executes through
ChatEngine — the default daily lane. `babel` with no arguments opens the interactive TUI/REPL.

### Removed surfaces (exit 1 with hints)

The following product surfaces are **removed**: `bl`, `babel-lite`, `lite`, `l`, `full`,
`daily`. They exit `1` with stderr hints pointing at the canonical commands
(`babel "<task>"`, `babel plan "<task>"`, `babel deep "<task>"`). See
`babel-cli/src/cli/deprecation.ts`.

Legacy verb-shaped words from the old Lite surface (`ask`, `do`, `fix`, `propose`, `patch`,
`review`) are **no longer registered as commands**; they are treated as task text
(e.g. `babel "fix this bug"` is a chat task, not a `fix` verb).

Legacy argv **mode aliases** remain accepted with deprecation warnings:
`default`→`chat`, `verified`→`deep`, `manual`→`plan`, `direct`→`chat`,
`autonomous`→`deep`, `parallel_swarm`→`deep` (`babel-cli/src/cli/constants.ts`).

## Target Commands

| Command | Target behavior | Mutation policy | Current status |
| --- | --- | --- | --- |
| `babel "..."` | Default daily path: conversational coding agent loop (ChatEngine). | Read-only requests stay read-only; clear implementation requests may mutate subject to gates and approval. | Implemented — `run --mode chat`. |
| `babel plan "..."` | Prepare an implementation plan, run a separate review agent, ask for approval, then apply and verify in the same flow after approval. | No mutation before approval. | Implemented — plan lane. |
| `babel deep "..."` | Governed pipeline: orchestrate → plan → review → execute (Stage 4 executor) with verification. | May mutate after governed gates. | Implemented — governed pipeline. |
| `babel chat-headless "..."` | Same ChatEngine as chat with JSON/headless output for CI and scripting. | Same as chat; hard verifier gate under `required`/`strict`. | Implemented — stable mode alias (also `babel chat --headless`). |
| `babel undo` | Restore the latest checkpoint from the most recent recoverable run. | Mutates only through explicit restore behavior. | Implemented. |
| `babel resume [run]` | Resume a retryable run and take the next action. | May continue a prior mutation lane. | Implemented. |
| `babel doctor` | Run Babel workspace health and integrity checks. | Read-only diagnostic. | Implemented. |
| `babel run "..."` | Advanced pipeline lane for explicit modes, audit output, and tool/model controls. | Governed by explicit options (`--mode`, `--execution-profile`, `--ask`, `--yes`, `--read-only`). | Implemented — advanced surface. |
| `babel mcp` | Read-only control-plane server for other tools. | Read-only. | Implemented — not the everyday coding entrypoint. |

## Execution Profiles (default `safe_repo`)

Execution profiles control tool posture and whether shell execution expects Docker isolation.
Default profile is **`safe_repo`**: Docker isolation required when the profile is active;
without a Docker daemon + configured image (`BABEL_BENCHMARK_DOCKER_IMAGE`) shell execution
**fail-closes** unless the operator explicitly escalates (`BABEL_ALLOW_HOST_FALLBACK=1` or
`BABEL_DOCKER_DISABLE=true`). **`dev_local`** is the host-oriented daily alternative
(`dockerSandbox: false`).

Profiles (see `babel-cli/src/config/executionProfiles.ts`): `safe_repo` (default),
`dev_local`, `read_only_audit`, `benchmark_container`, `bench_local`, `scaffold`,
`babel_research`, plus legacy/enterprise aliases.

Normative isolation rule (H13): [architecture/HARNESS_ARCHITECTURE_V1.md](./architecture/HARNESS_ARCHITECTURE_V1.md) §6.9.

## Permission Presets

Permission presets map user-facing flags to enforcement posture
(`babel-cli/src/agent/policy.ts`):

| Preset | Behavior |
| --- | --- |
| `workspace_write` (default) | Safe workspace writes; implementation runs require checkpoint evidence and verification gates. |
| `read_only` | No file edits or shell execution; read-only tools only. |
| `ask_before_mutation` | Prompt before mutating actions. |
| `auto_safe` | Trusted auto-edit with sandbox and policy gates still active. |

CLI flags map onto these and related controls: `--read-only` (auto-deny mutating writes),
`--ask` (approve before any mutating tool), `--yes` (auto-approve standard operations),
`--execution-profile <profile>`.

## Completion Honesty

A model "I'm done" answer is **not** completion. Completion is decided by the harness:

1. The model may request `VERIFIED_COMPLETE`.
2. The honesty gate (`completionGatePolicy.ts`) and the kernel
   (`executorKernel.completion.decide`) evaluate write evidence, verifier evidence, and
   adversarial signals (`tests_deleted`, `shortcut_noop`, `hardcoded_fixture`,
   `flaky_green`, `verifier_def_tampered`).
3. `VERIFIED_COMPLETE` requires verifier + proof compliance; otherwise the outcome is
   downgraded to `UNVERIFIED_PATCH` or a non-passing outcome.

Terminal outcomes (`TerminalOutcome` in `babel-cli/src/schemas/agentContracts.ts`):
`VERIFIED_COMPLETE`, `UNVERIFIED_PATCH`, `BLOCKED_EXTERNAL`, `BLOCKED_POLICY`,
`BUDGET_EXHAUSTED`, `CANCELLED`, `INFRA_FAILURE`, `AGENT_FAILURE`,
`NO_CHANGE_REQUIRED`, `INVALID_TASK`, `NEEDS_HUMAN_DECISION`.
A generic model or benchmark `pass` is never described as equivalent to verified completion.

## Non-Negotiables

- `babel plan` must not edit files before explicit approval.
- `babel "<task>"` must keep questions, comparisons, audits, diagnostics, recommendations,
  and explicit no-write requests out of mutation lanes.
- Clear implementation requests through `babel "<task>"` may route to the implementation
  path, or to `babel deep` when risk warrants it.
- `babel "<task>"`, `babel plan`, and `babel deep` must expose routing/intent metadata in
  JSON/artifacts. Default human output stays concise and shows only user-actionable route notes.
- Verification failure must not be reported as success.
- Mutation without checkpoint must be refused or explicitly reported as unrecoverable.
- Credential access denies by policy; destructive/public/costly operations gate or deny;
  model self-report is non-authoritative; verification is controller/kernel-owned.

## Fresh-Clone Proof Commands

Run from a fresh checkout in PowerShell after `npm install`:

```powershell
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js benchmark lite --json
node .\babel-cli\dist\index.js benchmark production --json
npm run test:public-release
```

Quick manual smoke after build:

```powershell
babel "what does this repo do?"
babel plan "outline a safe refactor"
babel "what should we implement next?"
babel deep "harden the implementation plan"
babel undo                   # after a mutating run with checkpoint
babel doctor
```

`babel plan` must not mutate tracked source files before approval.

---

## Historical Context — Lite era (2026-05 → 2026-07)

The following material is preserved for history and evidence. It describes the retired
"Lite"/"Full" product split and is **not** current product/runtime authority.

- **Demo vs real execution modes.** The Lite era distinguished offline-demo
  (`--provider mock`, `BABEL_LITE_OFFLINE=1`, fixture repos only, `execution_mode:
  offline_demo`) from real daily fixes and failure recovery (`LITE_FAILED`,
  `recoverable`, actionable `next`). Mock/offline success never upgraded public evidence
  wording for the daily worker; provider failures returned structured `next` steps
  (credential check, `babel undo`, retry guidance).
- **Lite artifact layout.** The retired Lite artifact target was `runs/babel-lite/<run-id>/`
  with `manifest.json`, `request.json`, `response.md`, `plan.md`, `proposal.diff`,
  `patch.diff`, `changes.diff`, `verification.json`, `checkpoint.json`, `cost_ledger.json`,
  `failure.json`. Current runs write per-run evidence under `runs/<run-id>/` with the
  evidence-bundle layout defined by the harness spec.
- **AgentSession loop.** `runLiteCommand` dispatched through one `AgentSession` loop
  (build repo context → ask provider for a normalized action → validate against permission
  policy → execute through the sandbox → return observation → repeat until done, blocked, or
  a verifier/recovery gate fires). The loop idea survives as the ChatEngine multi-turn loop;
  the AgentSession class and Lite verb lanes do not.
- **Old provider-contract Lite status.** `babel-cli/src/commands/liteCommands.ts` and
  `babel-cli/src/lite/` contain an older provider-contract implementation (provider-backed
  ask/patch artifacts). It is not the canonical first-use contract; the commands it registers
  are not part of the main CLI entrypoint.
- **Parity benchmark (Wave 6).** The parity benchmark measured Babel cells for
  `small_bug_fix`/`failing_test_repair` (offline-demo fixture scope) via
  `npm --prefix .\babel-cli run parity:run-babel` and
  `node .\babel-cli\dist\index.js benchmark parity --fixture <path> --json`.
  Measured parity was separate from daily-worker trust demos; `claim_ready` stayed false
  until externally measured.
