# AGENTS.md - Babel CLI

Agent-neutral startup router for the private Babel CLI package. Root `ENGINEERING.md` and root `AGENTS.md` remain authoritative for safety, verification, deletion, scope, and truthfulness.

## Startup Sequence

1. Read `/workspace-root/ENGINEERING.md`.
2. Read `/workspace-root/AGENTS.md`.
3. Read `.\BABEL_BIBLE.md`.
4. Read `.\PROJECT_CONTEXT.md`.
5. Read `PROJECT_CONTEXT.md` in this directory.
6. Read `README.md` for CLI command examples.

## Local Rules

- `PROJECT_CONTEXT.md` is the canonical package-local context for all agents.
- Edit `src/`, not generated `dist/`.
- Do not clean `runs/` without explicit user approval.
- Keep remote-mutating workflows gated and explicit.
- Treat compiler, pipeline, contract schemas, executor tools, plugins, schedules, git drafts, and subagent flows as high risk.

## Verification

Use the commands in `PROJECT_CONTEXT.md`. Do not claim dist/source-provenance cleanliness unless the corresponding command was run and passed.
