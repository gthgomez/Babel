<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel Runtime Modes

> **Previously "Babel Local Mode."** Renamed to reflect that Babel is now a
> standalone harness with its own TUI/REPL, not a prompt stack injected into
> other agents.

## Purpose

Babel runs as a local Node.js process on your machine. The `babel` command
launches the TUI/REPL, which handles session lifecycle, cost tracking, and
interaction with configured LLM providers.

This document describes the runtime modes and the architecture behind them.

## Runtime Modes

### REPL / TUI Mode (primary)

```powershell
babel                           # interactive REPL
babel "fix the test"            # one-shot chat
babel chat-headless "run CI"    # CI/testing, JSON output
babel plan "compare X"          # approval-first planning
babel deep "harden Y"           # governed pipeline
```

The `babel` command (from `babel-cli/bin/babel.js`) boots the full TUI:

| Mode | Entry | What happens |
|------|-------|-------------|
| **Chat** | `babel "<task>"` | Multi-turn agent loop with tools via `ChatEngine` |
| **Chat-Headless** | `babel chat-headless "<task>"` | Same ChatEngine as chat, JSON/headless output for CI and scripting |
| **Plan** | `babel plan "<task>"` | Design-first — plan, review, approve, then apply |
| **Deep** | `babel deep "<task>"` | Governed pipeline: orchestrate → plan → review → execute |

The TUI manages session lifecycle internally — checkpoint, resume, transcript
archival, and cost tracking all run inside the `babel` process. Data is stored
under `runs/chat-sessions/<id>/`, `runs/threads/<id>/`, and `runs/checkpoints/`.

Key source files:
- `babel-cli/src/interactive/BabelRepl.ts` — REPL constructor and start
- `babel-cli/src/interactive/repl/replLifecycle.ts` — bootstrap, exit, resume picker
- `babel-cli/src/interactive/execution/dispatch.ts` — mode routing
- `babel-cli/src/agent/chatEngine.ts` — multi-turn agent loop
- `babel-cli/src/services/sessionCheckpoint.ts` — checkpoint/restore
- `babel-cli/src/services/chatSessionIndex.ts` — session listing for resume

### Editor / Chat Surface Mode

When working in an editor, chat surface, or web chat, Babel
operates as an instruction layer rather than a runtime. Tell the model:

```text
Read BABEL_BIBLE.md and use Babel before planning or completing this task.
```

The model reads `BABEL_BIBLE.md`, selects the correct instruction layers from
the prompt catalog, and follows the Standard Babel Workflow. Session lifecycle
is handled by the editor/inference surface, not by Babel's TUI runtime.

### Advanced / CI

PowerShell scripts under `tools/` provide explicit session lifecycle control
for CI pipelines, benchmark replay, and scripted automation:

- `tools/launch-babel-local.ps1` — one-command launch packaging
- `tools/start-local-session.ps1` / `tools/end-local-session.ps1` — explicit lifecycle
- `tools/run-babel-local-cli.ps1` — canonical repo-root CLI runs

See the tools directory for automation usage. These scripts are not needed for
everyday terminal use.

## Recommended Stack (Editor Surface)

When Babel is invoked through an editor or chat surface, the model should:

1. Read [BABEL_BIBLE.md](../../BABEL_BIBLE.md).
2. Read Babel's own [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) and [prompt_catalog.yaml](../../prompt_catalog.yaml) if stack selection is needed.
3. Identify the target project.
4. Load the appropriate Babel layers.
5. If the target project has its own `LLM_COLLABORATION_SYSTEM`, read that project system before planning or coding.

## Relationship To Project-Level Collaboration Systems

Babel and project-level collaboration systems overlap in purpose, but they operate at different levels.

### Babel

Babel is the cross-project control plane.

It decides:
- how to invoke the prompt system
- what layer stack should apply
- what model/task/project framing is appropriate
- when optional overlays should be used

### Project `LLM_COLLABORATION_SYSTEM`

A project-level collaboration system is the repo-local execution contract.

It defines:
- repo-specific invariants
- startup sequence inside that repo
- local handoff rules
- project safety boundaries

### Correct Integration Pattern

Use them together like this:

1. Babel chooses the instruction stack and operating mode.
2. The target repo's collaboration system supplies the last-mile project contract.
3. Repo-local rules win for repo-local invariants.

Short version:

`Babel chooses the stack; the project system defines the repo-specific ground truth.`

## CLI Pipeline Invocation

Canonical pipeline invocation from the repository root:

```powershell
babel run "your task"
```

Equivalent explicit forms:

```powershell
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js run "your task"
```

The CLI loads environment configuration on startup. Environment validation
warnings are emitted if required configuration is missing. Use `--strict-env`,
set `BABEL_STRICT_ENV=true`, or run under `CI=true` to exit non-zero instead
of warning.

## Best Use Cases

- Code review and readiness audits
- Refactors and architecture-aware edits
- Frontend polish and visual consistency
- Planning and design-first workflows
- Project-specific coding with strong local invariants

## Review And Readiness Pattern

When the task is review, readiness, or postmortem work:

1. Lock the run to one repo root and ignore unrelated repo or worktree context.
2. Re-read the current files before trusting any earlier review summary.
3. Report findings first with exact file and line references.
4. Separate verified facts from inference.
5. Treat empty grep or empty search output as evidence only for the exact search surface used.
6. Keep implementation separate from review unless the user explicitly asks for fixes after the review call.

## Limits

- Model behavior depends on provider quality and availability
- Persistence differs by platform (local filesystem, not cloud)
- Repo context quality depends on indexing scope
- The TUI is local-only — no remote/headless REPL surface yet

## Design Bias

When designing Babel runtime features, prioritize:
- Short entrypoint instructions (`babel "<task>"` is the ideal)
- Reliable project handoff
- Repeatable invocation text
- Minimal required files for first run
- The TUI as the primary experience; editor surfaces as secondary

## Success Criteria

Babel's runtime is working well when:
- The same repo gets more consistent plans across sessions
- Project invariants survive model switching
- Less prompt repetition is needed
- Setup overhead is low enough to use Babel daily (`babel "<task>"` just works)
