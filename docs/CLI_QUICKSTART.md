<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel CLI Quickstart

This is the shortest path to using the Babel CLI as a new developer.

If you have not done setup yet:

```powershell
cd .\babel-cli
npm install
npm run build
```

After that, these are the four most useful copy-paste flows.

## 1. Doctor

Use this first when you want to verify the local Babel environment and workspace shape.

```powershell
cd .\babel-cli
node .\dist\index.js doctor
```

What it does:

- checks Babel workspace health
- surfaces repo/export issues early
- gives you the safest first CLI signal before a real run

## 2. Run

Use this when you want Babel to run a real task through the pipeline.

```powershell
cd .\babel-cli
node .\dist\index.js run "Fix webhook retry handling" --project example_saas_backend --mode verified
```

Good defaults:

- start with `--mode verified`
- use `--project` explicitly
- treat `autonomous` as an advanced path, not the default first run

## 3. Plan

Use this when you want a manual bridge handoff instead of a normal execution flow.

```powershell
cd .\babel-cli
node .\dist\index.js plan example_llm_router "Prepare rollout plan"
```

What it does:

- starts the Manual Bridge flow
- gives you a structured handoff instead of a normal task run
- is useful when you want more control than `run`

## 4. MCP

Use this when another client or tool wants to inspect Babel through MCP.

```powershell
cd .\babel-cli
node .\dist\index.js mcp
```

What it does:

- runs the read-only Babel MCP control-plane server over stdio
- is meant for integrations, not as the normal day-to-day starting point

## What To Use First

- use `doctor` if you want to confirm the CLI is healthy
- use `run` if you want Babel to execute a task
- use `plan` if you want a manual-bridge workflow
- use `mcp` if you are integrating Babel into another client

If you are still learning the repo, start with [START_HERE.md](../../START_HERE.md) and [BABEL_LOCAL_MODE.md](./BABEL_LOCAL_MODE.md) first.
