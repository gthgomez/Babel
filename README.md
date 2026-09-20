# Babel

[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions)

**Open-source coding agent for real repositories — with inspectable prompts, permissions, and verification.**

Babel runs locally in your terminal. Chat is the default. Plan and Deep are there when the work is riskier. The harness underneath keeps instructions, tools, and evidence visible instead of burying them in an opaque prompt.

> **Pre-1.0.** The public checkout builds and typechecks. Model choice, provider setup, sandboxing, and repo-specific execution policy still matter. See [project status](./docs/STATUS.md) for what is verified, experimental, or not claimed.

## See Babel in action

<!-- Maintainer: replace this block with a real capture at docs/assets/tui-chat.png (or .webm). Capture steps: docs/assets/README.md. Do not fabricate imagery. -->

*Illustrative transcript (not a live capture) of a chat turn in the Babel TUI:*

```text
BABEL · READY · CHAT · MyProject · deepseek
──────────────────────────────────────────────────

You
  Fix the failing webhook retry test and make sure
  duplicate deliveries can't double-process payments.

Babel
  I'll inspect the webhook handler and its tests first.

  ▸ Read src/webhooks/stripe.ts
  ▸ Read tests/webhooks/stripe.test.ts
  ▸ Search idempotency handling

  Found it: retries re-run the handler without a delivery key...

  ▸ Edited src/webhooks/stripe.ts
  ▸ Edited tests/webhooks/stripe.test.ts
  ▸ npm test -- stripe

  ✓ 18 passed

  Completed · 2 files changed · verified
```

Want a real screenshot or recording? See the [capture runbook](./docs/assets/README.md).

## Quick start (from source)

There is **no published npm package** for this CLI today. Run from a clone.

**Requirements:** Node.js 22.5+, a clone of this repo, and (for model sessions) a provider key.

```powershell
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js doctor
```

```bash
# macOS / Linux
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix ./babel-cli ci && npm --prefix ./babel-cli run build
node ./babel-cli/dist/index.js doctor
```

1. Copy `babel-cli/.env.example` → `babel-cli/.env` and set only the providers you use.
2. For ordinary host coding on repos you own, set `$env:BABEL_EXECUTION_PROFILE = 'dev_local'` (PowerShell) or `export BABEL_EXECUTION_PROFILE=dev_local`. The default `safe_repo` profile expects Docker and fail-closes without it.
3. Start the TUI:

```powershell
node .\babel-cli\dist\index.js interactive
```

```bash
node ./babel-cli/dist/index.js interactive
```

Then talk to it:

```text
> Explain this repository
> Fix the failing auth test
> Review the changes you just made
```

Full first-success path (profiles, one-shots, recovery): **[START_HERE.md](./START_HERE.md)**.  
Operational command reference: **[docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md)**.

## What Babel does

| Mode | Use it when |
|---|---|
| **Chat** | Daily work — ask, inspect, edit with permission, verify |
| **Plan** | You want a reviewable proposal before anything changes |
| **Deep** | Riskier work — plan, critique, stricter execution, verify |

Also available: headless chat for scripts/CI, checkpoints / `undo`, cost and diagnostics, and a read-only MCP control-plane surface.

```powershell
node .\babel-cli\dist\index.js "Fix the failing webhook retry test"
node .\babel-cli\dist\index.js plan "Split the auth module safely"
node .\babel-cli\dist\index.js deep "Harden the migration path and verify it"
node .\babel-cli\dist\index.js chat --headless "Summarize the failing test"
```

## Why the harness matters

Most coding agents expose a model and a tool loop. Babel also exposes the harness:

- **Permissions and execution profiles** — host vs isolated defaults you can reason about
- **Inspectable Prompt OS** — modular instructions you can preview and validate before a model runs
- **Evidence** — checkpoints, artifacts, diagnostics, recovery tools such as `undo`

You should be able to **use Babel before you understand Babel's architecture**. Deeper design lives under [docs/architecture](./docs/architecture/ARCHITECTURE.md).

Optional: validate the public tree and preview an instruction stack **without** a model key:

```powershell
pwsh -File .\tools\validate-public-release.ps1
pwsh -File .\tools\resolve-local-stack.ps1 -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode deep -Format json
```

## Project status

| | |
|---|---|
| **Maturity** | Pre-1.0 public source |
| **Install** | Clone + build (npm package not published yet) |
| **Strong public proof today** | Runnable CLI (chat / plan / deep), catalog/stack validation, typed contracts, read-only MCP inspection, release/scrub/secret-scan gates |
| **Depends on your environment** | Provider credentials, Docker vs `dev_local`, repo policy |

Honest detail: **[docs/STATUS.md](./docs/STATUS.md)**. Product direction: **[docs/VISION.md](./docs/VISION.md)**.

We do **not** claim: universal verifiers, unrestricted autonomous workers, mutating subagent teams, sandbox parity across every host, or market parity with other agents.

## Documentation

| Doc | Purpose |
|---|---|
| [START_HERE.md](./START_HERE.md) | First success, then optional inspect path |
| [docs/STATUS.md](./docs/STATUS.md) | Verified / experimental / limitations |
| [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) | Commands: chat, plan, deep, doctor, MCP |
| [docs/CHAT_MODE.md](./docs/CHAT_MODE.md) | Default daily runtime in depth |
| [docs/VISION.md](./docs/VISION.md) | Principles and public scope |
| [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) | System shape (when you want depth) |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute |
| [SECURITY.md](./SECURITY.md) | Vulnerability reporting |

## Feedback and contributing

- **Bugs / features:** [GitHub Issues](https://github.com/gthgomez/Babel/issues)
- **Changes:** see [CONTRIBUTING.md](./CONTRIBUTING.md) — highest-value work improves the daily chat loop, plan/deep UX, examples, and public gates
- Keep credentials, private paths, and operator-only notes out of public docs and fixtures

## License

Apache License 2.0. Use it, fork it, and build on it.

Historical tagged releases that shipped under MIT remain MIT for those snapshots. This tree is Apache-2.0 going forward.

Full text: [LICENSE](./LICENSE)
