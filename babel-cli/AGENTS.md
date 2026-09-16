# AGENTS.md - Babel CLI

Agent-neutral startup router for the Babel CLI package. Root `ENGINEERING.md` and root `AGENTS.md` remain authoritative for safety, verification, deletion, scope, and truthfulness.

## Startup Sequence

1. Read the repository-root `..\AGENTS.md` and this package's `PROJECT_CONTEXT.md`.
2. Read `README.md` when command examples or CLI workflows are relevant.
3. For Babel control-plane or prompt-stack work, additionally read the root
   `..\INTEGRATION.md`, `..\PROJECT_CONTEXT.md`, and `..\prompt_catalog.yaml`.
4. Read `CLAUDE.md` in this package only when changing harness architecture,
   completion, mode policy, or another listed high-risk area.

## Local Rules

- `PROJECT_CONTEXT.md` is the canonical package-local **implementation** context for all agents.
- Runtime harness **norms**: `../docs/architecture/HARNESS_ARCHITECTURE_V1.md` (see also `CLAUDE.md` in this package).
- Edit `src/`, not generated `dist/`.
- Do not clean `runs/` without explicit user approval.
- Keep remote-mutating workflows gated and explicit.
- Treat compiler, pipeline, contract schemas, executor tools, plugins, schedules, git drafts, and subagent flows as high risk.

## Verification

Use the commands in `PROJECT_CONTEXT.md`. Do not claim dist/source-provenance cleanliness unless the corresponding command was run and passed.
