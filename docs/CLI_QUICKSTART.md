<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel CLI Quickstart

**Role:** operational **command reference** for chat / plan / deep / doctor / MCP.
**Canonical first-success** (clone → build → talk) lives in [START_HERE.md](../START_HERE.md).
Docs map: [README.md](./README.md).

Babel is a **local coding agent**. The primary interface is the interactive
**TUI/REPL**. Daily work uses **Work**, **Plan**, and **Work with thorough review**.
The internal controller names Chat/Plan/Deep remain compatible.

These commands are for a **current-source clone**. The published Windows x64
Desktop [0.1.3](https://github.com/gthgomez/Babel/releases/tag/v0.1.3) bundles Node and the CLI; see [START_HERE.md](../START_HERE.md)
for choosing between them. The PowerShell examples use an absolute `$BabelCli`
path defined after the build below, so they also work outside the Babel checkout.

## npm first run

```sh
npm install --global babel-harness@latest
babel-agent setup
babel-agent provider status
babel-agent settings show
babel-agent work "Explain this project"
```

Setup requires an explicit connection/model and budget choice; no cloud provider
is preselected. OpenAI/Gemini/Anthropic can be used directly. Configuration is not
proof of authentication. `doctor` checks local execution prerequisites. In a pipe,
use `setup --json` for setup state and instructions. Details and migration commands:
[package README](../babel-cli/README.md#first-run-connections-and-defaults).

Plan stops by default. Only an explicitly saved `plans.autoApply` preference can
enable automatic implementation; explicit plan-only intent and permissions win.
`work --review thorough` is the public spelling for the existing Deep controller.
Workflow, permissions and display are independent. `conversation list/resume`
recovers conversations; `run resume <id>` recovers execution worker chains.

## Requirements

- Node.js **22.19.0+ in the 22.x line, or 24.13.1+ in the 24.x line**
- PowerShell (`pwsh`) for the helper scripts in this guide
- A provider API key for model-backed sessions
- Docker plus a sandbox image containing your project's tools before
  running project tests or builds (see [Execution profile](#execution-profile-read-this-before-the-first-edit))

## Clone, install, build

Clone from a parent directory, then build inside the Babel checkout:

```powershell
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
$BabelRoot = (Get-Location).Path
$BabelCli = Join-Path $BabelRoot 'babel-cli\dist\index.js'

# macOS/Linux equivalent:
npm --prefix ./babel-cli ci && npm --prefix ./babel-cli run build
```

Authoritative package root is `babel-cli/`. There is no root `package.json`.
Keep `$BabelRoot` and `$BabelCli` in this PowerShell session. Before the CLI
commands below, select your own repository:

```powershell
Set-Location -LiteralPath 'C:\path with spaces\your-repo'
```

Target resolution uses the nearest recognized project at or above the working
directory, falling back to the working directory. Explicit project/target
selection and session resume can override it; check the displayed target.

## Provider credentials

Create `~/.babel/config` first and copy the blank template from the Babel
checkout (`Join-Path $BabelRoot 'babel-cli\.env.example'`) into the private
`~/.babel/config/.env`
(or `%USERPROFILE%\.babel\config\.env` on Windows) and set only the
provider keys you use. On macOS/Linux, set file permissions with
`chmod 600 ~/.babel/config/.env` after copying. `BABEL_CONFIG_DIR` selects an explicit profile.
Never put provider keys inside the target repository by default. Desktop provides
masked setup in **Configure provider**; it only offers project-local `.env`
with explicit opt-in, Git ignore and tracking checks. Host and CI environment
variables continue to take precedence. The old `babel-cli/.env` is read only
when `BABEL_LEGACY_CLI_ENV=1` is explicitly set.

Live provider-backed runs typically need `DEEPSEEK_API_KEY`. Other keys in
the example file are optional.

## Doctor / ping

```powershell
node "$BabelCli" doctor
node "$BabelCli" setup --json
node "$BabelCli" models ping --json
```

`models ping` needs a configured provider. Skip it when you only want the
no-credentials inspect path.

## Execution profile (read this before the first edit)

Default profile is **`safe_repo`**. It expects Docker isolation. Without
Docker and a configured image (`BABEL_BENCHMARK_DOCKER_IMAGE`) it
**fail-closes** unless you opt into host execution.

Keep the default `safe_repo` profile for project execution and prepare an
image containing your project's tools. `dev_local` permits supported host
inspection without Docker; selecting it alone does **not** enable repository
test or build commands:

```powershell
$env:BABEL_EXECUTION_PROFILE = 'dev_local'
# or pass --execution-profile dev_local on a one-shot command
```

`BABEL_ALLOW_HOST_FALLBACK=1` is an explicit host-escalation switch when
you keep `safe_repo` but Docker is unavailable. It is not the recommended
first-use path.

Details: [CHAT_MODE.md](./CHAT_MODE.md#execution-profile-and-isolation-h13).

## Start Babel (interactive TUI)

```powershell
node "$BabelCli" interactive
# same as:
node "$BabelCli"
```

What you get:

- multi-turn coding session in the terminal
- default mode: **chat**
- slash commands (`/help` inside the session)
- session resume via `node "$BabelCli" resume`

Try:

```text
> Explain this codebase
> Fix the failing auth test
> Review the changes you just made
```

Essential slash commands:

```text
/model         switch models
/mode          chat / plan / deep
/diff          inspect the latest changes
/resume        continue an earlier conversation
/permissions   change approval behavior
/help          see everything
```

`/dashboard`, `/theme`, `/palette`, `/cancel`, `/checkpoint`, and `/restore`
are available; `/help` is canonical. There is no `/undo` in the TUI —
use CLI `undo` or `/checkpoint` / `/restore`.

## Chat (default one-shot path)

```powershell
node "$BabelCli" "Fix webhook retry handling"
# explicit:
node "$BabelCli" run "Fix webhook retry handling" --mode chat
```

Headless / CI-friendly chat output:

```powershell
node "$BabelCli" run "Summarize the failing test" --mode chat-headless
node "$BabelCli" chat --headless "Summarize the failing test"
```

## Plan

Plan first, inspect the saved result, then explicitly apply:

```powershell
node "$BabelCli" plan "Split the auth module safely" --plan-only
node "$BabelCli" apply --plan <plan_id>
```

Use when you want an explicit plan gate before mutations.

## Deep

Higher-ceremony path with extra critique and execution structure:

```powershell
node "$BabelCli" deep "Harden the migration path and verify it"
```

Use for riskier changes when you want more structure than chat. Route availability does **not** mean Deep is more reliable than chat for ordinary tasks (see [STATUS.md](./STATUS.md) when present; [ROADMAP.md](./ROADMAP.md)).

## Resume and recovery

```powershell
node "$BabelCli" resume
node "$BabelCli" undo
```

`undo` restores the last checkpoint. Inside the TUI, inspect or restore with
`/checkpoint` and `/restore`.

## Mode map

| Mode | Engine | Best for |
|------|--------|----------|
| **chat** | ChatEngine (TUI / conversational loop) | Daily coding, exploration, iteration |
| **chat-headless** | Same engine, non-interactive output | Scripts, CI, automation |
| **plan** | Governed plan path | Reviewable plan before apply |
| **deep** | Full governed pipeline | Higher-risk implementation + verification |

Legacy names still accepted as aliases with deprecation warnings
(compatibility only; do not use them in new docs or scripts):

| Legacy | Maps to |
|--------|---------|
| `verified`, `autonomous` | `deep` |
| `manual` | `plan` |
| `direct`, `default` | `chat` |

## MCP (integrations)

```powershell
node "$BabelCli" mcp
```

Read-only control-plane server for other tools — not the everyday coding
entrypoint.

## Stack preview (no model)

From the Babel checkout, still useful without credentials:

```powershell
Set-Location -LiteralPath $BabelRoot
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode deep `
  -Format json
```

Compare with [examples/manifest-previews/backend-deep.json](../examples/manifest-previews/backend-deep.json).

## Advanced: remote serve (experimental loopback)

Authenticated ADR-010 JSON-RPC on `127.0.0.1` only. Not a public server.
Not a remote desktop. Not part of first-run.

```powershell
Set-Location -LiteralPath 'C:\path with spaces\your-repo'
node "$BabelCli" remote serve --port 4545 --project $PWD
# Tailscale Serve to that loopback port; never Funnel; never 0.0.0.0
```

Evidence and limits: [architecture/babel-remote/BABEL_REMOTE_SPIKE_RESULTS.md](./architecture/babel-remote/BABEL_REMOTE_SPIKE_RESULTS.md).

Further reading: [START_HERE.md](../START_HERE.md) (first-success) · [README.md](./README.md) (docs map) ·
[README.md](../README.md) (product front door) · [CHAT_MODE.md](./CHAT_MODE.md) ·
[ROADMAP.md](./ROADMAP.md)
