# Babel Local Optimization Research

Research date: 2026-03-07

## Purpose

Turn official platform guidance into concrete changes that improve:
- Babel Local self-learning
- output quality
- operating efficiency
- cross-tool consistency

This document focuses on subscription-first and local-tool workflows:
- Codex extension / Codex CLI
- Claude Code
- Gemini CLI
- ChatGPT web projects where relevant

## Core Direction

The strongest pattern across the official docs is consistent:

- persistent context improves quality
- deterministic automation improves reliability
- telemetry and evals improve learning
- concise, structured memory improves efficiency
- human review is still required for system-level prompt changes

Babel should therefore evolve as:
- a cross-tool memory compiler
- a local observability layer
- an eval-driven prompt system

not as a fully autonomous self-editing prompt engine.

## What The Official Docs Suggest

### 1. Persistent memory files are the default pattern

Claude Code uses project and user memory files:
- project instructions in `./CLAUDE.md` or `./.claude/CLAUDE.md`
- user instructions in `~/.claude/CLAUDE.md`

Gemini CLI uses hierarchical `GEMINI.md` files:
- global memory in `~/.gemini/GEMINI.md`
- ancestor/project context files
- sub-directory context files
- `/memory show`, `/memory refresh`, and `/memory add`

Codex uses layered `AGENTS.md` files:
- `~/.codex/AGENTS.md`
- repo-root `AGENTS.md`
- current-directory `AGENTS.md`

ChatGPT Projects also persist shared instructions, chats, and files inside a project.

Implication for Babel:
- Babel should compile one canonical instruction source into tool-native memory surfaces instead of relying on repeated copy-paste startup prompts.

### 2. Deterministic automation beats prompt-only reminders

Anthropic is explicit that hooks provide deterministic control and are better than relying on the model to remember to do something. Hooks can run at session start, before tool use, after tool use, and when sessions end.

Gemini CLI exposes a similar operational surface:
- headless mode for scripted use
- telemetry
- checkpointing
- sandboxing
- context refresh commands

Implication for Babel:
- move recurring “always do this” behavior into scripts and hooks where possible
- keep prompts for judgment, not for repeated mechanical enforcement

### 3. Observability is a first-class feature

Gemini CLI supports local and GCP telemetry. Its telemetry includes prompt events, tool calls, file operations, and API requests.

Claude Code exposes usage monitoring, including:
- session count
- token usage
- lines of code modified
- commit count
- pull request count
- cost usage

Implication for Babel:
- Babel Local should collect structured session evidence by default
- logging should capture which stack was selected, which stack was actually used, and whether the session succeeded

### 4. Safety and reversibility improve quality

Gemini CLI checkpointing stores a snapshot before AI-powered file modifications and allows restore.

Claude Code settings support explicit read denies for sensitive files and hook snapshots that must be reviewed before changes apply.

Gemini CLI sandboxing and tool confirmations provide another safety layer.

Implication for Babel:
- before pushing Local Mode toward more autonomy, Babel should add a restore/checkpoint habit and tool-specific safe defaults

### 5. Official guidance favors eval-driven iteration

OpenAI’s eval guidance recommends:
- evaluate early and often
- log everything
- automate when possible
- keep human calibration in the loop
- grow eval sets from real production or user-feedback data

OpenAI also recommends agent evals and workflow-level trace grading for agent systems.

Implication for Babel:
- self-learning should be based on structured logs plus regression fixtures
- prompt and router changes should be scored against known tasks before adoption

### 6. Efficiency comes from context discipline, not bigger prompts

Claude Code memory docs, Gemini CLI `GEMINI.md`, Codex `AGENTS.md`, and ChatGPT Projects all point in the same direction:
- write instructions once
- keep them structured
- avoid re-explaining the repo every session

Gemini CLI also supports imported memory fragments and configurable context filenames.

OpenAI prompt caching and Gemini token caching both reinforce the same principle for API mode: stable repeated prefixes lower cost and improve speed. Gemini’s token caching is available for API-key and Vertex users, but not OAuth users.

Implication for Babel:
- keep startup prompts short
- push stable guidance into files
- modularize memory by scope
- keep overlays narrow and reusable

### 7. Parallel or comparative generation can improve output selection

OpenAI’s “How OpenAI uses Codex” guide recommends:
- using the task queue as a lightweight backlog
- using Best-of-N to explore multiple solutions and choose the best one

Implication for Babel:
- for important work, Babel should compare at least two candidate plans or outputs instead of trusting a single run
- this can be cross-model or same-model Best-of-N depending on cost and speed

## Concrete Changes Babel Should Make

### Highest priority

1. Keep `tools/log-local-session.ps1` in the loop after real sessions.
2. Add a small analyzer that groups failures by:
- client surface
- project
- task category
- selected adapter
- failure tag
3. Add tool profiles for:
- Claude Code
- Codex extension
- Gemini CLI
4. Add “compiled memory” outputs:
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
5. Add a lightweight output-eval fixture set for:
- planning quality
- contract preservation
- verification quality

### Second priority

1. Add hook/script examples for Claude Code session start and session end.
2. Add Gemini CLI telemetry guidance for local logs.
3. Add a restore/checkpoint recommendation layer for Gemini CLI and compatible tools.
4. Add pairwise comparison workflow for high-value tasks.

### API-mode later

1. Use prompt caching.
2. Use background mode for long-running jobs.
3. Use prompt optimizer only with narrow graders and human review.
4. Use agent evals and trace grading for workflow regressions.

## Recommended Self-Learning Model For Babel Local

The safest useful loop is:

1. Log session evidence.
2. Normalize failures into stable tags.
3. Periodically summarize patterns by tool and task type.
4. Stage proposed rule changes.
5. Evaluate proposed changes on fixtures.
6. Apply only human-approved changes.

This is self-improving, but not self-mutating.

## Recommended Metrics

Track these first:
- session result
- stack override rate
- failure tag frequency
- follow-up-needed rate
- files touched
- duration
- repo-local system detected

Then add:
- average prompt length
- tool-call success rate
- compaction or refresh frequency
- cost and token usage where the client exposes them

## Anti-Patterns To Avoid

- storing raw conversations as “memory”
- letting a single good or bad run rewrite prompts
- promoting repo-specific lessons into global rules without evidence
- measuring quality only by subjective vibe
- using giant universal prompts instead of layered memory

## Best Next Steps

1. Use `tools/log-local-session.ps1` after real sessions for a week.
2. Add `tools/analyze-local-sessions.ps1`.
3. Add `docs/TOOL_PROFILES.md`.
4. Add compiled memory outputs for Codex, Claude Code, and Gemini CLI.
5. Add a small plan-quality eval suite.

## Official Sources

- Claude Code memory: https://code.claude.com/docs/en/memory
- Claude Code hooks: https://code.claude.com/docs/en/hooks-guide
- Claude Code slash commands and skills: https://code.claude.com/docs/en/slash-commands
- Claude Code monitoring: https://code.claude.com/docs/en/monitoring-usage
- Claude Code settings: https://code.claude.com/docs/en/settings
- Claude Code costs: https://code.claude.com/docs/en/costs
- Gemini CLI context files: https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html
- Gemini CLI commands: https://google-gemini.github.io/gemini-cli/docs/cli/commands.html
- Gemini CLI telemetry: https://google-gemini.github.io/gemini-cli/docs/cli/telemetry.html
- Gemini CLI checkpointing: https://google-gemini.github.io/gemini-cli/docs/checkpointing.html
- Gemini CLI sandboxing: https://google-gemini.github.io/gemini-cli/docs/cli/sandbox.html
- Gemini CLI token caching: https://google-gemini.github.io/gemini-cli/docs/cli/token-caching.html
- OpenAI evaluation best practices: https://developers.openai.com/api/docs/guides/evaluation-best-practices
- OpenAI agent evals: https://developers.openai.com/api/docs/guides/agent-evals
- OpenAI prompt optimizer: https://developers.openai.com/api/docs/guides/prompt-optimizer
- OpenAI background mode: https://developers.openai.com/api/docs/guides/background
- OpenAI agent safety: https://developers.openai.com/api/docs/guides/agent-builder-safety
- ChatGPT Projects: https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- ChatGPT Custom Instructions: https://help.openai.com/en/articles/8096356-custom-instructions-for-chatgpt
- OpenAI Codex repository: https://github.com/openai/codex
- How OpenAI uses Codex: https://cdn.openai.com/pdf/6a2631dc-783e-479b-b1a4-af0cfbd38630/how-openai-uses-codex.pdf
