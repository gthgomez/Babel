# VS Code and Local Tool Invocation Guide

## Purpose

This guide gives practical invocation patterns for using Babel with:
- VS Code model extensions
- Claude Code
- Codex extension / OpenAI coding surfaces
- Gemini CLI

Use these invocations as starting points, then adapt them per repo.

## Core Invocation Rule

For any local coding workflow:

1. point the model at [BABEL_BIBLE.md](../BABEL_BIBLE.md)
2. tell it to use Babel before planning or acting
3. if the target repo has a local collaboration system, tell it to read that repo’s `PROJECT_CONTEXT.md` and `LLM_COLLABORATION_SYSTEM` entrypoint too

## Universal Invocation

Use this when you want one phrase that works across tools:

`Read Babel's BABEL_BIBLE.md first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md and local collaboration system if present before planning or coding.`

## Deterministic Launch Helper

For local codex/claude/gemini startup, prefer the Phase 6 helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\launch-babel-local.ps1 -TaskCategory backend -Model codex -WorkMode plan -TaskPrompt "Implement only the requested backend fix."
```

The helper:
- reuses `tools/start-local-session.ps1`
- emits a copy-paste launch prompt
- emits copy-paste `end-local-session` commands
- keeps output deterministic for the same inputs

## Codex / OpenAI Coding Surface

Recommended:

`Read Babel's BABEL_BIBLE.md, use Babel for this task, then read this repo's PROJECT_CONTEXT.md and local collaboration system if present before planning and implementation.`

Use when:
- you want deterministic repo editing
- you want Babel to normalize stack selection first

## Claude Code

Recommended:

`Read Babel's BABEL_BIBLE.md first. Use Babel to choose the right instruction stack. Then read this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md before planning or coding.`

Use when:
- the repo has strict local invariants
- you want strong plan-first behavior

## Gemini CLI

Recommended:

`Read Babel's BABEL_BIBLE.md first and use Babel before doing this task. Then load this repo's PROJECT_CONTEXT.md and local collaboration system if present. Keep plans explicit and state assumptions clearly.`

Use when:
- you want strong synthesis on a local codebase
- you need Babel to normalize repo-specific setup

## VS Code Generic Extension Pattern

If the extension gives you a large initial prompt field, use:

`Use Babel for this task. Start with BABEL_BIBLE.md. Then read this repo's PROJECT_CONTEXT.md and its local collaboration system entrypoint if present. Select the smallest correct instruction stack and proceed.`

## When The Repo Has `LLM_COLLABORATION_SYSTEM`

If the repo contains a local collaboration system:

- do not skip it
- do not treat Babel as a replacement for it
- use it as the repo-specific contract layer

Recommended wording:

`After reading Babel's BABEL_BIBLE.md, also read this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md before planning.`

## Suggested Workflow For Daily Coding

1. Open the target repo.
2. Invoke the model with a Babel-first prompt.
3. Ensure it reads the repo-local context.
4. Ask for PLAN first on risky tasks.
5. Ask for ACT only after the stack is correct.

## Best Practices

- keep the invocation stable across sessions
- prefer one universal phrase plus small tool-specific variations
- use Babel to normalize behavior across tools
- use repo-local systems for last-mile invariants

## Anti-Patterns

Do not:
- give the model only Babel and skip the repo-local context
- assume the tool remembers prior stack choices correctly
- let the model invent project overlays or local rules
- overload the first prompt with the entire Babel repo when the Bible doc is enough to start
