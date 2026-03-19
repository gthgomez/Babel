# Babel Local Mode

## Purpose

Local Mode is the subscription-first, human-in-the-loop runtime for Babel.

Use this mode when you are working with:
- ChatGPT Plus
- Claude Pro
- Google AI Pro / Gemini Advanced
- VS Code model extensions
- Claude Code
- Gemini CLI

Local Mode is the right default when you want Babel to improve consistency and instruction quality without requiring paid API orchestration.

## What Local Mode Is

Local Mode uses Babel as:
- the instruction entrypoint
- the stack selector
- the cross-model consistency layer

It does not require:
- automatic API routing
- full autonomous pipelines
- central eval infrastructure
- programmatic tool orchestration

## What Local Mode Is Not

Local Mode is not:
- fully autonomous agent operations
- headless background orchestration
- a substitute for repo-native instructions
- a replacement for project-specific safety rules

## Recommended Local Stack

In Local Mode, the model should:

1. Read [BABEL_BIBLE.md](../BABEL_BIBLE.md).
2. Read Babel’s own [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) and [prompt_catalog.yaml](../prompt_catalog.yaml) if stack selection is needed.
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
2. The target repo’s collaboration system supplies the last-mile project contract.
3. Repo-local rules win for repo-local invariants.

Short version:

`Babel chooses the stack; the project system defines the repo-specific ground truth.`

## Local Mode Invocation Pattern

When working inside a project repo, the recommended instruction chain is:

1. Read Babel’s [BABEL_BIBLE.md](../BABEL_BIBLE.md).
2. Use Babel to select the right stack.
3. Read the target repo’s `PROJECT_CONTEXT.md`.
4. If present, read the target repo’s `LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md`.
5. Plan and act using the combined instruction stack.

For deterministic startup ergonomics, use:
- `tools/launch-babel-local.ps1` for one-command `plan|act` launch packaging
- `tools/start-local-session.ps1` / `tools/end-local-session.ps1` for explicit lifecycle logging

## Best Use Cases

- code review
- refactors
- frontend polish
- architecture-aware edits
- planning
- project-specific coding with strong local invariants
- comparative reasoning across Codex, Claude, and Gemini

## Review And Readiness Pattern

When the task is review, readiness, or postmortem work:

1. Lock the run to one repo root and ignore unrelated repo or worktree context.
2. Re-read the current files before trusting any earlier review summary.
3. Report findings first with exact file and line references.
4. Separate verified facts from inference.
5. Treat empty grep or empty search output as evidence only for the exact search surface used.
6. Keep implementation separate from review unless the user explicitly asks for fixes after the review call.

## Limits Of Local Mode

- no centralized automation pipeline
- model behavior still depends on client quality
- persistence differs by platform
- repo context quality differs by tool
- approvals and tool use are platform-specific

## Local Mode Design Bias

When designing Babel for Local Mode, prioritize:
- short entrypoint instructions
- reliable project handoff
- repeatable invocation text
- minimal required files
- compatibility with web and editor clients

## Current Tooling Targets

Primary Local Mode targets:
- VS Code with model extensions
- Claude Code
- Codex extension / OpenAI coding surfaces
- Gemini CLI

## Success Criteria

Local Mode is working well when:
- the same repo gets more consistent plans across models
- project invariants survive model switching
- less prompt repetition is needed
- human setup overhead is low enough to use Babel daily
