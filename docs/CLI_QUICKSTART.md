<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel CLI Quickstart

Babel is a **local coding agent**. The primary interface is the interactive **TUI/REPL**.
Daily work uses three product modes: **chat**, **plan**, and **deep**.

## Setup

```powershell
cd .\babel-cli
npm install
npm run build
```

Optional health check:

```powershell
node .\dist\index.js doctor
```

Model-backed sessions need a configured provider (API keys in your environment, never committed).

## 1. Interactive TUI / REPL (default)

```powershell
cd .\babel-cli
node .\dist\index.js
# same as:
node .\dist\index.js interactive
```

What you get:

- multi-turn coding session in the terminal
- default mode: **chat**
- slash commands (see `/help` inside the session), including mode/model switches
- session resume via `babel resume`

## 2. Chat (default one-shot path)

Conversational agent loop — multi-turn tool use when interactive; one-shot when given a task:

```powershell
node .\dist\index.js "Fix webhook retry handling"
# explicit:
node .\dist\index.js run "Fix webhook retry handling" --mode chat
```

Headless / CI-friendly chat output:

```powershell
node .\dist\index.js run "Summarize the failing test" --mode chat-headless
# or: babel chat --headless "..."
```

## 3. Plan

Plan first, approve, then apply:

```powershell
node .\dist\index.js plan "Split the auth module safely"
```

Use when you want an explicit plan gate before mutations.

## 4. Deep

Governed pipeline with extra critique and execution rigor:

```powershell
node .\dist\index.js deep "Harden the migration path and verify it"
```

Use for higher-risk changes when you want more structure than chat.

## Mode map

| Mode | Engine | Best for |
|------|--------|----------|
| **chat** | ChatEngine (TUI / conversational loop) | Daily coding, exploration, iteration |
| **chat-headless** | Same engine, non-interactive output | Scripts, CI, automation |
| **plan** | Governed plan path | Reviewable plan before apply |
| **deep** | Full governed pipeline | Higher-risk implementation + verification |

Legacy names still accepted as aliases with deprecation warnings:

| Legacy | Maps to |
|--------|---------|
| `verified`, `autonomous` | `deep` |
| `manual` | `plan` |
| `direct`, `default` | `chat` |

Prefer the modern names in docs and new scripts.

## 5. MCP (integrations)

```powershell
node .\dist\index.js mcp
```

Read-only control-plane server for other tools — not the everyday coding entrypoint.

## 6. Stack preview (no model)

From the repo root, still useful without credentials:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -Format json
```

## What to use first

1. `babel` — open the TUI  
2. `babel plan "..."` — when you want a gated plan  
3. `babel deep "..."` — when you want the heavy governed path  
4. `babel doctor` — environment health  
5. `babel mcp` — integrations  

Further reading: [START_HERE.md](../START_HERE.md) · [README.md](../README.md)
