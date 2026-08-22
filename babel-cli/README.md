# Babel CLI

`babel-cli/` is the only authoritative CLI package root.

Babel CLI is the local coding-agent runtime for **Chat**, **Plan**, and **Deep**.
The Prompt OS (catalog, resolver, typed contracts) is the inspectable control
architecture underneath that runtime.

This package is pre-1.0. Do not describe it as ready for unrestricted production
use, as a safe autonomous worker for arbitrary repositories, or as equivalent to
mature coding-agent CLIs. Evidence for live provider-backed governance remains
limited because those pipeline tests can require credentials and may be skipped
in normal local runs.

Deeper references:

- [CLI quickstart](../docs/CLI_QUICKSTART.md)
- [Chat mode](../docs/CHAT_MODE.md)
- [Harness architecture](../docs/architecture/HARNESS_ARCHITECTURE_V1.md)
- [CLI command contract](../docs/CLI_COMMAND_CONTRACT.md)

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

From a clone of this repository (not an npm registry package). Node.js 22.5+.

Windows PowerShell from the Babel repository root:

```powershell
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js doctor --json
$env:BABEL_EXECUTION_PROFILE = 'dev_local'
node .\babel-cli\dist\index.js interactive
```

Then talk to Babel. One-shot instead of the TUI:

```powershell
node .\babel-cli\dist\index.js "Explain this repository"
node .\babel-cli\dist\index.js plan "Split the auth module safely"
node .\babel-cli\dist\index.js deep "Harden the migration path and verify it"
```

`setup --json` still reports missing setup pieces. `context preview` remains a
safe no-mutation probe. Neither replaces starting a chat session.

## Model-Backed Smoke

Use `node .\babel-cli\dist\index.js models ping --json` to verify a configured
provider before a full pipeline run.

Deep dry-run smoke should keep mutations shadowed and avoid optional pruning unless explicitly enabled:

```powershell
$env:BABEL_DRY_RUN='true'
$env:BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS='120000'
node --env-file=.\babel-cli\.env .\babel-cli\dist\index.js run --project example_mobile_reference --mode deep --json "Read PROJECT_CONTEXT.md and create a new file named babel-deep-smoke.txt containing one sentence that says the smoke test passed."
```

- `BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS` is a per-request abort timeout; timed-out model calls cascade to the next configured backend. The default is `120000`.
- `BABEL_DEEPINFRA_REQUEST_MAX_RETRIES` controls retryable transport/HTTP attempts. The default is `4`.
- `BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS` controls how long a streaming response may stay silent before retry/failure. The default is `60000`.
- `BABEL_DEEPINFRA_STREAM_MAX_RETRIES` controls stream-idle retries. The default is `1`; set `0` to classify the first idle stream as failed.
- `BABEL_CONTEXT_PRUNING=true` enables model-backed context pruning. By default, pruning is skipped so smoke and release-gate runs avoid an extra provider call.

## Provider configuration

Use `babel-cli/.env` as the single optional local credential hub. Start from
`.env.example`; leave unused providers blank and never commit the populated
file. Host and CI environment variables win over values in the file.

The provider registry owns canonical provider IDs, protocols, and credential
variable names. The credential hub resolves keys only at transport boundaries,
while `ProviderEngine` selects the protocol-specific runner body. This keeps
one engine entry point without pretending that Anthropic, Gemini, and
OpenAI-compatible HTTP bodies are identical.

Canonical credential variables are `DEEPINFRA_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, and `GROQ_API_KEY`. Ollama is credential-free by default and
uses `BABEL_OLLAMA_BASE_URL` for an optional endpoint override. The `opencode`
provider targets OpenCode Zen (`https://opencode.ai/zen/v1`) with an optional
`BABEL_OPENCODE_BASE_URL` endpoint override.

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
node dist/index.js run "Solve benchmark task" --execution-profile benchmark_container --mode deep
node dist/index.js run "Audit this repo" --execution-profile read_only_audit
```

- `safe_repo` is the default guarded profile (`dockerSandbox: true`). After H13 it **fail-closes** without Docker daemon + image (`BABEL_BENCHMARK_DOCKER_IMAGE`) unless you escalate with `BABEL_ALLOW_HOST_FALLBACK=1` or `BABEL_DOCKER_DISABLE=true`.
- `dev_local` is host-friendly (`dockerSandbox: false`); permits common local build tools such as pnpm, yarn, cargo, go, gcc, make, uv, and dotnet while keeping shell wrappers and destructive commands rejected. Prefer this for host-only day-to-day work.
- You can also set `BABEL_EXECUTION_PROFILE=dev_local` instead of the CLI flag.
- `benchmark_container` is for Terminal-Bench style isolated tasks and relaxes benchmark-fixture QA posture without enabling host shell operators.
- `scaffold` is for new project creation.
- `read_only_audit` blocks writes and command execution.

Normative isolation (H13): `docs/architecture/HARNESS_ARCHITECTURE_V1.md` §6.9. Operator-facing chat notes: `docs/CHAT_MODE.md`.

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
