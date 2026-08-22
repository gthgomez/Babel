<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel CLI Quickstart

Babel is a **local coding agent**. The primary interface is the interactive
**TUI/REPL**. Daily work uses three product modes: **chat**, **plan**, and
**deep**.

These commands are for a **source clone**. Babel is not published as an npm
registry package. After build, use `node .\babel-cli\dist\index.js` from the
repo root unless you have installed the package binary yourself.

## Requirements

- Node.js **22.5+**
- PowerShell (`pwsh`) for the helper scripts in this guide
- A provider API key for model-backed sessions
- Docker plus a sandbox image **or** `dev_local` / host fallback before
  mutating work (see [Execution profile](#execution-profile-read-this-before-the-first-edit))

## Clone, install, build

From the repository root:

```powershell
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build

# macOS/Linux equivalent:
npm --prefix ./babel-cli ci && npm --prefix ./babel-cli run build
```

Authoritative package root is `babel-cli/`. There is no root `package.json`.

## Provider credentials

Copy `babel-cli/.env.example` to `babel-cli/.env` and set only the providers
you use. Host and CI environment variables win over that file. Never commit
the populated file.

Live provider-backed runs typically need `DEEPSEEK_API_KEY`. Other keys in
the example file are optional.

## Doctor / ping

```powershell
node .\babel-cli\dist\index.js doctor
node .\babel-cli\dist\index.js setup --json
node .\babel-cli\dist\index.js models ping --json
```

`models ping` needs a configured provider. Skip it when you only want the
no-credentials inspect path.

## Execution profile (read this before the first edit)

Default profile is **`safe_repo`**. It expects Docker isolation. Without
Docker and a configured image (`BABEL_BENCHMARK_DOCKER_IMAGE`) it
**fail-closes** unless you opt into host execution.

For ordinary local coding in repositories you trust:

```powershell
$env:BABEL_EXECUTION_PROFILE = 'dev_local'
# or pass --execution-profile dev_local on a one-shot command
```

`BABEL_ALLOW_HOST_FALLBACK=1` is the explicit host-escalation switch when
you keep `safe_repo` but Docker is unavailable.

Details: [CHAT_MODE.md](./CHAT_MODE.md#execution-profile-and-isolation-h13).

## Start Babel (interactive TUI)

```powershell
node .\babel-cli\dist\index.js interactive
# same as:
node .\babel-cli\dist\index.js
```

What you get:

- multi-turn coding session in the terminal
- default mode: **chat**
- slash commands (`/help` inside the session)
- session resume via `node .\babel-cli\dist\index.js resume`

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
node .\babel-cli\dist\index.js "Fix webhook retry handling"
# explicit:
node .\babel-cli\dist\index.js run "Fix webhook retry handling" --mode chat
```

Headless / CI-friendly chat output:

```powershell
node .\babel-cli\dist\index.js run "Summarize the failing test" --mode chat-headless
node .\babel-cli\dist\index.js chat --headless "Summarize the failing test"
```

## Plan

Plan first, approve, then apply:

```powershell
node .\babel-cli\dist\index.js plan "Split the auth module safely"
```

Use when you want an explicit plan gate before mutations.

## Deep

Governed pipeline with extra critique and execution rigor:

```powershell
node .\babel-cli\dist\index.js deep "Harden the migration path and verify it"
```

Use for higher-risk changes when you want more structure than chat.

## Resume and recovery

```powershell
node .\babel-cli\dist\index.js resume
node .\babel-cli\dist\index.js undo
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
node .\babel-cli\dist\index.js mcp
```

Read-only control-plane server for other tools — not the everyday coding
entrypoint.

## Stack preview (no model)

From the repo root, still useful without credentials:

```powershell
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
node .\babel-cli\dist\index.js remote serve --port 4545 --project $PWD
# Tailscale Serve to that loopback port; never Funnel; never 0.0.0.0
```

Evidence and limits: [architecture/babel-remote/BABEL_REMOTE_SPIKE_RESULTS.md](./architecture/babel-remote/BABEL_REMOTE_SPIKE_RESULTS.md).

Further reading: [START_HERE.md](../START_HERE.md) · [README.md](../README.md) ·
[CHAT_MODE.md](./CHAT_MODE.md)
