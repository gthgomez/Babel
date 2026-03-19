# LLM Collaboration System (Humans + LLMs)

This folder exists to keep Codex, Claude, and Gemini aligned in this repo.

## Why This Exists

- Reduces instruction drift between tools.
- Makes model switching deterministic.
- Gives first-time contributors a predictable startup sequence.
- Supports web-only LLM sessions that do not have direct filesystem access.

## File Index

- `RULES_CORE.md`: always-loaded cognitive discipline layer.
- `RULES_GUARD.md`: conditional execution-permissioning layer.
- `ADAPTER_BABEL.md`: Babel-specific invariants and boundaries.
- `ACTIVATION_CONTRACT.yaml`: deterministic load policy for Core/Guard/Adapter.
- `RULES_SHARED_ALL_MODELS.md`: rules all models must obey.
- `RULES_MODEL_CODEX.md`: Codex specialization layer.
- `RULES_MODEL_CLAUDE.md`: Claude specialization layer.
- `RULES_MODEL_GEMINI.md`: Gemini specialization layer.
- `MODEL_SWITCH_HANDOFF_TEMPLATE.md`: copy/paste handoff block for tool/model switching.
- `WEB_UPLOAD_GUIDE.md`: what to upload when using web chat interfaces.
- `legacy_manifests/`: backups of prior manifest files.

## Manifest Policy

- `CLAUDE.md`: Manually maintained (root + per-project lean files). Never auto-generated.
- `AGENTS.md` / `GEMINI.md`: Report-only sync via `tools/sync-model-manifests.ps1`. Proposals staged in `tools/reports/` for manual review.

## Non-Negotiable

Always read `PROJECT_CONTEXT.md` before coding or proposing code changes.
