# Babel CLI

`babel-cli/` is the only authoritative CLI package root.

Babel CLI is the local coding-agent runtime for **Work**, **Plan**, and **Work with thorough review** (internal controllers remain Chat/Plan/Deep).
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

## Install from npm

The public npm package is [`babel-harness`](https://www.npmjs.com/package/babel-harness).
Install the current stable release globally, or use `--prefix` to keep it in a
separate directory:

```sh
npm install --global babel-harness@latest
babel-harness --version
babel-harness setup
babel-harness doctor --json
```

The package also provides the compatible `babel-agent` command. These names
avoid the unrelated BabelJS `babel` executable. With a local prefix, run
`<prefix>/node_modules/.bin/babel-harness` on macOS/Linux or
`<prefix>\node_modules\.bin\babel-harness.cmd` on Windows. Target files resolve
from the current directory or explicit project arguments. Node **22.19.0+ in the 22.x line, or 24.13.1+ in the 24.x line**, is
required for unflagged WebAssembly module imports as well as `node:sqlite` and its extension API.
The Node 24 floor includes the [upstream non-ASCII path deletion fix](https://github.com/nodejs/node/pull/61108),
released in [24.13.1](https://nodejs.org/en/blog/release/v24.13.1). Other Node release lines and older Node 24 releases are unsupported.
Consumer CI checks 22.19.0, 24.13.1 and latest Node 24 on hosted Linux, Windows, and macOS; the artifact records the
actual OS/architecture and result. These checks qualify tested runner platforms,
not every computer. Native `sqlite-vec` support depends on available platform
binaries and may degrade to non-vector search. SQLite still emits an experimental
warning on Node 22.19.0.

Bundled prompts, defaults, and license are immutable. Installed commands use
`~/.babel/config` for user configuration, `~/.babel` for state (including `runs/`),
and `~/.babel/cache` for caches. Override these with `BABEL_CONFIG_DIR`,
`BABEL_STATE_DIR`, and `BABEL_CACHE_DIR`; `BABEL_RUNS_DIR` independently overrides
run evidence. An installed package ignores `BABEL_ROOT` for resource discovery.
An optional user configuration file is `~/.babel/config/.env`; ordinary provider
environment variables also work. Set credentials securely outside the checkout;
Guided setup uses masked credential entry in the private profile. Setup and doctor never print keys or contact inference providers. Configure one
supported provider for model-backed tasks; presence alone is not authentication.
A local Ollama route needs its service and selected model available.

Read-only help, context preview, and stack resolution need no provider. The
**default `safe_repo` profile requires a running Docker server** for execution;
doctor reports missing Docker and never enables host fallback. Contributor
`learn`, `skill`, `benchmark`, `smoke`, `test`, and `audit` utilities require a source
checkout because they manage source-library artifacts. Use
`setup --contributor` and `doctor --contributor` for contributor diagnostics.

From a clone, `npm run test:consumer-artifact` in `babel-cli/` builds, packs, installs
only production dependencies into a fresh prefix outside the checkout, runs the
installed CLI/TUI and scripted ChatEngine journey, and checks immutable install,
Unicode/space paths, user/project boundaries, and uninstall/reinstall. Outputs
include tarball, SHA-256, exact source SHA/version, full pack manifest and observed
verification. The synthetic journey uses an explicit disposable `dev_local`
fixture lease for actual local tests and blocks external inference; this is
mechanics evidence, not live-model quality. Its UI start/exit check uses pipes;
separate PTY evidence and platform-specific skipped coverage belong in the PR.

Releases use the repository's [release guide](../docs/guides/RELEASE.md): source
and package provenance are checked, and an immutable consumer artifact is
qualified before a version tag is cut. Publishing that qualified artifact to
npm is a separate release operation. Do not add registry credentials to a
checkout; the publish workflow uses the repository's configured trusted
publisher.


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

From a clone of this repository (not an npm registry package). Node.js 22.19.0+ in the 22.x line, or 24.13.1+ in the 24.x line.

Throughout this file, `babel <command>` means `node .\babel-cli\dist\index.js <command>` run from the repository root, unless you have linked or installed the binary yourself (macOS/Linux: `./babel-cli/dist/index.js`).

Windows PowerShell from the Babel repository root:

```powershell
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js doctor --json

# macOS/Linux equivalent:
npm --prefix ./babel-cli ci && npm --prefix ./babel-cli run build && node ./babel-cli/dist/index.js doctor --json
```

`dev_local` executes approved tools directly on your host with no container
isolation. Use it only for repositories you own and code you have reviewed.
For untrusted repositories or unreviewed code, stay on the isolated
`safe_repo` profile.

```powershell
$env:BABEL_EXECUTION_PROFILE = 'dev_local'
node .\babel-cli\dist\index.js interactive
```

Then talk to Babel. One-shot instead of the TUI:

```powershell
node .\babel-cli\dist\index.js "Explain this repository"
node .\babel-cli\dist\index.js plan "Split the auth module safely"
node .\babel-cli\dist\index.js deep "Harden the migration path and verify it"
```

Interactive output distinguishes the response from background work. `Response
complete` means the answer has finished; `Background: Indexing workspace` can
continue independently. Response timers measure the current turn. Usage beside
the answer covers that turn; footer totals are labeled `session`. Displayed
costs are token-based estimates, not billing receipts; incomplete price data
renders as `session cost unavailable`. `context
unavailable` means active-context telemetry or the model limit is missing.

The `Input ›` composer starts empty after submission. Up recalls history;
Ctrl+C cancels an active request. On terminals without a mutable preview,
incomplete Markdown blocks are buffered under `Receiving response…` and committed
once when their structure is known. Terminals with scroll regions show a mutable
tail, which enters scrollback when the generation finishes. If a resize makes
that preview unavailable, Babel buffers the generation until completion or until
the preview fits again; it never appends raw Markdown preview bytes.

`/model` marks the active backend, shows alias destinations, and labels input and
output prices in USD per million tokens. Prices come from policy; a configured
zero rate does not establish that billing is free. Credential presence does not
establish service availability. Use `/model show`, `/model why`, or `/model health`
for routing and operational details.

An unspecified Chat model and the generic `deepseek` selector use the OpenRouter
DeepSeek Flash standard route. As of October 30, 2026, the pinned snapshot is
[`deepseek/deepseek-v4.1-flash-1017`](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017),
which OpenRouter's [DeepSeek Flash Latest](https://openrouter.ai/~deepseek/deepseek-flash-latest)
currently resolves to. The explicit Pro route and the older V4 Flash 0731 route
remain available when selected by name; updating the default snapshot does not
rewrite those selections.

Preamble-budget diagnostics are retained as `preamble-budget.json` in the run
bundle. Interactive daemon diagnostics go to `diagnostics/interactive-<pid>.jsonl`
under the user state directory (`~/.babel`, or `BABEL_STATE_DIR`). The installed
interactive launcher redirects Node warnings to `diagnostics/node-warnings-<pid>.log`
before importing the runtime. For direct `node dist/index.js interactive` runs,
Node's `--redirect-warnings=<file>` flag provides the same warning separation.
Diagnostic files stay separate from the conversation; startup failures appear as
failed background tasks with the diagnostic location.
If the warning log directory is unavailable, startup continues using Node's
stderr warning output and reports a `Warning diagnostics` background failure.

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

- `BABEL_PROVIDER_REQUEST_TIMEOUT_MS` is the shared per-request abort timeout (default `120000`); `BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS` remains a compatibility alias. Explicit connections retry only their selected route and end with an actionable failure. Legacy explicitly configured waterfalls retain their own fallback policy.
- `BABEL_DEEPINFRA_REQUEST_MAX_RETRIES` controls retryable transport/HTTP attempts. The default is `4`.
- `BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS` controls how long a streaming response may stay silent before retry/failure. The default is `60000`.
- `BABEL_DEEPINFRA_STREAM_MAX_RETRIES` controls stream-idle retries. The default is `1`; set `0` to classify the first idle stream as failed.
- `BABEL_CONTEXT_PRUNING=true` enables model-backed context pruning. By default, pruning is skipped so smoke and release-gate runs avoid an extra provider call.

## First run, connections, and defaults

A fresh profile has **no cloud provider or model selected**. Launching the interactive
CLI offers setup before indexing or runtime warmup. Setup explains Babel, records
an explicit provider connection and exact model ID, asks for a per-task budget
(including an explicit `unlimited` choice), and confirms the initial user default.
Interrupted setup retains completed non-secret choices. In a pipe or CI,
`setup --json` reports local setup state without waiting for input.

```sh
babel-agent provider list
babel-agent provider connect openai --name personal --model <exact-model-id>
babel-agent provider connect gemini --name work --model <exact-model-id>
babel-agent provider use work --save user
babel-agent model use <exact-model-id> --save project
babel-agent provider status
babel-agent settings show
```

OpenAI and Gemini keys work directly; OpenRouter is optional. Anthropic uses its
native Messages API. Several accounts can use the same provider. Model names
never choose a provider. `model use` stays on the selected connection. Manual
exact model IDs are supported even when absent from the local catalog; availability
and pricing remain unverified until evidence exists. `provider list` exposes
qualified operations; saving a connection does not certify unsupported operations.

Custom Chat Completions endpoints require `provider connect openai-compatible
--name <id> --base-url <url> --model <id> --api-key-env <VARIABLE_NAME>`.
Only an explicit compatible connection may use `--no-auth`. Endpoints require
HTTPS except loopback HTTP and reject embedded credentials, query strings and
fragments. Redirects are refused. Repositories cannot supply connection endpoints
or credential destinations. `--context-window` and `--max-output-tokens` allow
explicit limits for a model absent from the catalog; unknown capacity is not
claimed as a measured context window.

Preferences contain env-variable **names**, never keys. They live in private
`preferences.json` under the user state root; project preferences are stored
there by resolved project root. Precedence is invocation, TUI session, explicit
environment, private project preference, user default, then built-in. Inside the
TUI, `/provider use` and `/model use` last for that session. CLI selection requires
`--save user|project`; an individual invocation can use `--connection <id>`.
Switching connection invalidates the old engine and pending plan. Legacy
repository `.babel/settings.json` never automatically selects a fresh user's account.

`provider status` distinguishes configured/unverified from missing setup or a
missing credential. It does not claim authentication. `doctor` also identifies
the executing package/version/path and checks Node, bundled resources, Docker and
the sandbox image. Failed credentials, quota, rate limits and missing models get
specific recovery guidance. No failure silently chooses another provider.

### Workflow and recovery

| Intent | CLI | Interactive |
| --- | --- | --- |
| Work | `babel-agent work "task"` | `/mode work` |
| Plan without edits | `babel-agent plan "task" --plan-only` | `/mode plan` |
| Apply saved plan | `babel-agent apply --plan <plan_id>` | `/apply <plan_id>` |
| Thorough review | `babel-agent work --review thorough "task"` | `/mode work --review thorough` |
| Conversation recovery | `babel-agent conversation list/resume` | `/conversation list/resume` |
| Execution recovery | `babel-agent run resume <id>` | `/run resume <id>` |
| Display density | interactive only | `/display renderer conversational|stages|auto` |

Planning stops by default and saves a private handoff. Application rechecks the
project identity, working-tree freshness, current read-only policy, and exclusive
application state before entering the existing governed executor. A failed or
started plan cannot be blindly applied again. Only explicitly saved
`settings set plans.autoApply true` enables automatic implementation; explicit
`--plan-only`, read-only task intent and current permissions still win. JSON plan
output stays plan-only for automation compatibility.

`plan --shadow` is a deprecated read-only restriction; it never automatically
applies a plan. Finite saved USD caps currently work with standard Work's task
allowance. Plan, thorough Work, Apply and unmetered compatibility lanes reject
finite caps before inference. Use standard Work or explicitly choose an
`unlimited` budget to use those lanes without a dollar ceiling. Setup and
`settings show` report this limitation.

`--headless` selects plain output after workflow resolution and grants no extra
permissions. The advanced literal `chat-headless` compatibility lane retains
its previous approval behavior; use Work with explicit permission settings for
new integrations.

The existing `session` CLI remains a **run-evidence inspection** interface.
Its `resume` view does not execute a task. Legacy `resume`/manual `apply` and
`continue` retain their existing recovery effects; use the explicit namespaces
above for new scripts. `/session list|resume` and `/resume` remain conversation
aliases. `/transcript` shows conversation text; `/history` shows entered commands;
`/clear` clears the display; context compaction remains separate. Operator modes
remain advanced compatibility controls rather than additional primary workflows.

### Defaults and instructions

`settings show` reports effective values and sources, runtime limits, permissions,
model identity status, persistence, and instruction owners. Built-ins are Work,
standard review, auto-apply off, `safe_repo` isolation, unlimited cost and whole-task
wall time, a 200-turn safety ceiling, 20 conversation messages, a 128,000 estimated
context threshold, 8 stall turns, and 200,000 tokens per round. Task tunes, explicit
environment and saved preferences can change effective limits. Setup asks for a
budget; it does not silently choose a dollar amount. Workflow, permissions, review
depth and renderer selection are independent.

Ordinary Work uses the built-in Chat behavior and canonical project instruction
compiler, including scoped AGENTS.md/ENGINEERING.md. Thorough review retains the
existing Deep stack assembly. The actual run instruction manifest records included,
omitted and truncated fragments; help does not imply that the whole Prompt OS is
loaded. Requested/sent/observed models are separate. Missing usage or price remains
unknown, including local/custom inference. Remote tracing remains opt-in.

### Provider architecture and migration

`ProviderEngine` owns construction. Shared Chat Completions request/stream behavior
lives in `runners/protocol/openai-chat-completions.ts`; DeepInfra's file contains
only its adapter. Gemini and Anthropic translate their own message protocols using
`protocol/native-messages.ts` for the shared lifecycle. Existing DeepInfra exports
and `BABEL_DEEPINFRA_*` settings remain compatible; neutral `BABEL_PROVIDER_*`
settings take precedence. Ollama has its own documented timeout/attempt defaults.
Native tool proposals always pass through Babel's existing execution authority.
Mock conformance evidence establishes mechanics, not live model quality.

## Provider configuration

**Credentials default to a private profile**, not the target project or the Babel source checkout. For standalone CLI use `~/.babel/config/.env` (or `%USERPROFILE%\.babel\config\.env` on Windows); a configured `BABEL_CONFIG_DIR` selects another private profile. Desktop uses its private profile directory. Set only the provider keys you need; never commit them. Explicit process environment variables take precedence.

The older `babel-cli/.env` is not automatically loaded. Existing contributor setups can temporarily opt in with `BABEL_LEGACY_CLI_ENV=1` while migrating secrets to private configuration. A target project's `.env` is **never loaded automatically**: after explicitly choosing project-local storage in Desktop, only authority-certified provider key names are loaded from a Git-ignored, untracked project `.env`. CLI-only project opt-in is available through `BABEL_PROJECT_CREDENTIALS_DIR=<absolute project root>`; do not set it for untrusted repositories.

Desktop can resolve the selected credential destination in its native process
before launching the owned CLI. When it supplies both internal markers
`BABEL_DESKTOP_IPC=1` and `BABEL_DESKTOP_CREDENTIALS_RESOLVED=1`, CLI bootstrap
skips private, project and legacy dotenv loading and inactive-file probes.
OpenCode Go also refuses helper or cached-helper fallback for that handoff.
This keeps removed or replaced credentials from returning through retained
legacy files. Standalone CLI credential precedence remains unchanged.

`node ./dist/index.js --desktop-capabilities` returns local compatibility
metadata before credential bootstrap or provider execution. The sole-option
probe advertises `credentialEnvironment: "native-resolved-v1"`; Desktop must
reject an incompatible CLI before handing it protected credentials.

The provider registry owns canonical provider IDs, protocols, and credential
variable names. The credential hub resolves keys only at transport boundaries,
while `ProviderEngine` selects the protocol-specific runner body. This keeps
one engine entry point without pretending that Anthropic, Gemini, and
OpenAI-compatible HTTP bodies are identical.

Canonical credential variables are `DEEPINFRA_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `COMMAND_CODE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, and `GROQ_API_KEY`. Ollama is credential-free by default and
uses `BABEL_OLLAMA_BASE_URL` for an optional endpoint override. The `opencode`
provider targets OpenCode Zen (`https://opencode.ai/zen/v1`) with an optional
`BABEL_OPENCODE_BASE_URL` endpoint override.

For the experimental native Command Code API route, set `COMMAND_CODE_API_KEY`
in the private profile, then run
`babel run "Inspect this repository" --model command-code/deepseek-v4.1-flash`.
Babel sends Chat Completions requests to
`https://api.commandcode.ai/provider/v1/chat/completions`; Babel owns the tool
loop and permission checks. This is separate from launching the Command Code
CLI as an external harness. The explicit route rejects model substitution and
does not fall back to another provider. Usage estimates use published peak
rates and remain distinct from reported charges; missing usage stays unknown.

## Daily Interactive Loop

```powershell
node .\babel-cli\dist\index.js interactive
```

Inside the REPL, the short path is:

- `/doctor` then `/status` before a real task.
- `/inspect`, `/checkpoint list`, and `/session` after a run.
- `/mcp`, `/plugins`, and `/agents` when checking integrations or delegation surfaces.

## Developer workflow

From inside `babel-cli/`:

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
- `dev_local` is host-friendly (`dockerSandbox: false`); permits common local build tools such as pnpm, yarn, cargo, go, gcc, make, uv, and dotnet while keeping shell wrappers and destructive commands rejected. Prefer this for host-only day-to-day work. It runs tools directly on your host — do not point it at untrusted repositories or unreviewed code.
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

Chat/Plan transitions in the shared ChatEngine retain one task identity and the accepted objective, verifier requirements, budgets and original effect ceiling. Each mode change creates a linked frozen contract revision; its manifest, head contract and versioned `task-mode-history.json` commit through the existing checkpoint journal. A failed publication retains the prior generation. Missing, malformed or newer lineage cannot authorize a derived head. Legacy archives remain readable, but execution admission and mode changes require retained canonical history; missing sources are never replaced with empty logs. A Plan-only objective cannot gain implementation authority from a mode selection. Deep requires its real controller and is not a ChatEngine mode alias.

Independent Chat submissions receive separate task identities, including repeated requests with identical text. Status, continuation and amendments retain the current objective. Admission commits the frozen authority, retained earlier objectives, canonical turn/attempt binding and task allowance together before provider or tool execution. Prior verification remains historical; uncertain earlier tool effects still require reconciliation. A continuation retains its objective allowance, and an incompatible or missing budget cannot silently reset it.

Initial acceptance capture distinguishes explicit requirements, proposed inferred meaning and unresolved meaning. Additive amendments create frozen revisions linked to their canonical accepted input, preserving the original goal, required checks and execution ceiling. Exact legacy placeholders can be initialized from the original canonical request and accepted additions; missing sources cannot authorize migration. Acceptance changes retire previous completion receipts while retaining the archive. Version 2 mode history and canonical acceptance-amendment events require a compatible runtime; older readers reject them. Capture does not itself verify a requirement. Shared completion requires current, authority-owned criterion evidence; supported verifier binding/execution, full Deep handoff and Desktop task/queue presentation remain separate implementation work.

Within an `Also`, `Additionally` or `And` continuation, only standalone supported status forms are exempt from acceptance capture. Unsupported or mixed prose requires clarification; a question mark alone cannot discard a potential requirement.

A response can finish while its task remains unverified. Historical or generic test receipts do not establish criterion coverage, and missing trusted evidence cannot be bypassed by a permissive verification policy. The current criterion service has no execution evidence until the supported binding and dispatch path is implemented.

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
