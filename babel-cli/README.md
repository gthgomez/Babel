# Babel CLI

`babel-cli/` is the only authoritative CLI package root.

## Evidence Baseline

Babel CLI is an experimental governance-first Prompt OS / CLI runtime with tested deterministic reliability components. The current evidence supports claims about catalog validation, typed contracts, resolver/compiler behavior, terminal status normalization, rollback/worktree safety, verifier-contract handling, doctor diagnostics, and local tests.

Do not describe this package as ready for unrestricted production use, as a
safe autonomous worker for arbitrary repositories, or as equivalent to mature
coding-agent CLIs. Evidence for live provider-backed governance remains limited
because those pipeline tests can require credentials and may be skipped in
normal local runs.

## Known Limitations

- Evidence for live provider-backed PLAN -> QA -> ACT governance is limited.
- Provider-backed pipeline tests may require API keys and skipped live tests must be surfaced explicitly.
- `src/pipeline.ts` remains monolithic and needs decomposition.
- Verifier-gated completion is scoped to declared or inferred verifier contracts, not universal for every run.
- `doctor` and the reliability matrix need more cross-environment hardening.
- No public evidence supports comparative claims about other coding tools.

## Source of truth

- `src/` is the only authoritative source tree.
- `dist/` is generated output only.
- `bin/babel.js` launches the generated `dist/index.js`.

Do not hand-edit files in `dist/`. Make source changes in `src/`, then rebuild.

## Source Authority

This package is developed in the canonical `gthgomez/Babel` repository. Implement,
benchmark, review, and release CLI behavior here. Downstream consumer repositories may
exercise or extend the CLI through documented interfaces, but they do not publish
generated CLI source back into this package.

## First Five Minutes

Windows PowerShell from the Babel repository root:

```powershell
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js setup --json
node .\babel-cli\dist\index.js doctor --json
node .\babel-cli\dist\index.js context preview @file README.md --json
```

Expected shape:

- `setup --json` reports `status: "pass"` or names the missing setup piece plus `next_command`.
- `doctor --json` should report `status: "pass"` in a healthy workspace.
- `context preview` is the first safe no-mutation probe; it does not run a model or edit files.

## Model-Backed Smoke

Use `babel models ping --json --model qwen3-32b` to verify the DeepInfra key and model reachability before a full pipeline run.

Autonomous dry-run smoke should keep mutations shadowed and avoid optional pruning unless explicitly enabled:

```powershell
$env:BABEL_DRY_RUN='true'
$env:BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS='120000'
node --env-file=.\babel-cli\.env .\babel-cli\dist\index.js run --project example_mobile_reference --mode autonomous --json "Read PROJECT_CONTEXT.md and create a new file named babel-autonomous-smoke.txt containing one sentence that says the smoke test passed."
```

- `BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS` is a per-request abort timeout; timed-out model calls cascade to the next configured backend. The default is `120000`.
- `BABEL_DEEPINFRA_REQUEST_MAX_RETRIES` controls retryable transport/HTTP attempts. The default is `4`.
- `BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS` controls how long a streaming response may stay silent before retry/failure. The default is `60000`.
- `BABEL_DEEPINFRA_STREAM_MAX_RETRIES` controls stream-idle retries. The default is `1`; set `0` to classify the first idle stream as failed.
- `BABEL_CONTEXT_PRUNING=true` enables model-backed context pruning. By default, pruning is skipped so smoke and release-gate runs avoid an extra provider call.

## Daily Interactive Loop

```powershell
node .\babel-cli\dist\index.js interactive
```

Inside the REPL, the short path is:

- `/doctor` then `/status` before a real task.
- `/inspect`, `/checkpoint list`, and `/session` after a run.
- `/mcp`, `/plugins`, and `/agents` when checking integrations or delegation surfaces.

## Developer workflow

```bash
npm ci
npm run typecheck
npm run build
npm run benchmark:readiness
```

`npm run benchmark:readiness` writes a local readiness report under the ignored
runtime-results directory. The same harness is available from the compiled CLI as:

```bash
node dist/index.js benchmark readiness --json
```

The automated reliability loop is available from the compiled CLI:

```bash
node dist/index.js benchmark loop --json
node dist/index.js benchmark loop --json --skip-local-checks
node dist/index.js benchmark loop --readiness fast --json
node dist/index.js benchmark analyze latest --json
```

`benchmark loop` evaluates local readiness, reads benchmark history from a
configured results directory, and recommends the next targeted or full
benchmark command. Suite selection and promotion thresholds belong to the
calling environment rather than the public package documentation.

`--readiness fast|full|release` controls the local gate. Fast runs typecheck,
unit tests, and build. Full adds dist, doctor, Docker, and release-readiness checks.
Release adds source provenance.

`benchmark analyze` classifies the latest run or a provided run directory and
emits a repair report with the failure class, focus task, evidence paths, and
suggested verification commands.

Generated benchmark reports, state, event logs, and raw run output are local
runtime artifacts. They are ignored by Git and are not public release evidence
unless a maintainer deliberately publishes a sanitized, reproducible report.

The command is a readiness aid, not a self-editing daemon. Review its output and
verification evidence before changing source or making release decisions.

## Daily Agent Profiles

`babel run` supports opt-in execution profiles:

```bash
node dist/index.js run "Fix failing tests" --execution-profile dev_local
node dist/index.js run "Solve benchmark task" --execution-profile benchmark_container --mode autonomous
node dist/index.js run "Audit this repo" --execution-profile read_only_audit
```

- `safe_repo` is the default guarded profile.
- `dev_local` permits common local build tools such as pnpm, yarn, cargo, go, gcc, make, uv, and dotnet while keeping shell wrappers and destructive commands rejected.
- `benchmark_container` is for Terminal-Bench style isolated tasks and relaxes benchmark-fixture QA posture without enabling host shell operators.
- `scaffold` is for new project creation.
- `read_only_audit` blocks writes and command execution.

Project lifecycle commands:

```bash
node dist/index.js onboard-project . --json
node dist/index.js create node-cli ./scratch/hello-cli
node dist/index.js create python-cli ./scratch/hello-py --json
node dist/index.js create vite-react ./scratch/hello-web
```

`onboard-project` writes a report under `runs/onboarding/` and recommends an execution profile plus likely install/build/test commands. It writes `PROJECT_CONTEXT.md` only when `--write-project-context` is explicitly provided.

## Recovery surfaces

- `babel checkpoint list|inspect|restore` works against run-local checkpoints.
- `file_write` checkpoints restore captured target files; `shell_exec` and `test_run` checkpoints restore bounded filesystem diffs while skipping cache/dependency/secret paths.
- `babel session resume <run-id> --json` reports checkpoint counts plus the executor model-context artifact (`10_session_context.json`) when a run reached Stage 4.

## External Context

- `@file` and `@directory` references can be attached from task prompts; Babel keeps them inside the project root, applies git-aware filtering, and writes `00_context_injections.json` for real runs.
- `babel context preview @file README.md --json` previews context attachments without starting a pipeline run.
- `web_search` and `web_fetch` executor tools return source metadata, citations, run-local cache paths, size-limit metadata, private-network fetch guards, and untrusted-content labels.
- MCP v2 read surfaces are available through executor tools and CLI commands: resources, prompts, and bounded tool search.
- `babel mcp doctor --json` checks configured stdio transports, auth hints, timeout policy, and lazy schema-loading policy without starting a pipeline run.

## Event Stream

- `babel run "task" --events-jsonl ./runs/events.jsonl` writes a schema-versioned JSONL stream for local IDE/webview prototypes.
- Event envelopes include `source`, monotonic `sequence`, namespaced `event_type`, and `payload`.
- Interactive mode can use the same stream by setting `BABEL_EVENTS_JSONL` before launch.

## Stats

- `babel stats run latest --json` derives waterfall latency, tool counts, cache hits, token/cost totals, and session-context state from evidence artifacts.
- Interactive `/stats` shows current in-memory session cost plus the latest run-bundle stats when available.

## CI Review

- `babel ci review --json` writes deterministic read-only review evidence under `runs/ci-review/`.
- The report includes changed files, risk flags, missing-test signals, and PR-draft summary text.
- It does not commit, push, open PRs, or run model-backed review.

## Git Drafts

- `babel git diff-summary --json` writes changed-file and diffstat evidence under `runs/git-drafts/`.
- `babel git commit-draft --json` drafts a commit subject/body without committing.
- `babel git pr-draft --json` drafts PR title, summary, test plan, and review notes without opening a PR.

## Schedules

- `babel schedule create daily-review ci_review --project-root .` creates a local read-only schedule entry.
- `babel schedule run-now daily-review --json` executes one schedule immediately and writes evidence under `runs/schedules/`.
- Local schedules do not start a daemon and do not commit, push, create branches, or open PRs.

## Runtime Plugins

- `babel plugins list|inspect|enable|disable|doctor` manages manifest-based runtime plugins behind the explicit `runtime_plugins_enabled` gate.
- Plugin manifests can contribute governed `plugin_tool` executor tools, prompt skills, `/plugin` slash/custom commands, MCP server bundles, and declarative hooks.
- `sample-readonly` demonstrates a read-only tool and command; `sample-format-hook` demonstrates a local-mutating post-`file_write` formatting hook that works against live files or dry-run shadow roots.

## Agent Teams

- `babel agents list|run|inspect|merge` manages first-class subagent team specs.
- Each subagent declares `role`, `task`, `allowed_tools`, `disallowed_tools`, `write_scope`, `evidence_path`, and `merge_strategy`.
- Mutating agents default to copy isolation and merge only through `babel agents merge`; `--isolation git_worktree` is available for repo-backed isolation when the target repo is suitable.
- Reviewer/read-only agents can be enforced with `merge_strategy: "review_only"` plus `allowed_tools`/`disallowed_tools`.

## Guardrails

- `npm run build` removes `dist/` first, then rebuilds it from `src/`.
- `npm run check:dist` snapshots `dist/`, rebuilds, and fails if the rebuild changes `dist/` again.
- `npm run check:source-provenance` fails if `src/` contains unexpected `.js` source files or if the approved JS inventory drifts.
- `prepublishOnly` runs `npm run check:source-provenance` and `npm run check:dist`.

## Source provenance debt

Some files in `src/` remain `.js` because they were recovered from live runtime output during normalization and no original `.ts` source existed in the repo snapshot.

That inventory is tracked in [source-provenance.json](./source-provenance.json). New `.js` files under `src/` should not be added silently; update the provenance inventory only when there is an explicit reason.

## Legacy package note

The old `-DestinationRoot/babel-cli/` package is legacy archive material and is not part of the active build workflow.
