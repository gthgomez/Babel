<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# LLM Collaboration System (Humans + LLMs)

This folder contains product prompt assets for Babel model stacks. It is not a
contributor instruction entrypoint; root `AGENTS.md` owns contributor policy.

## Why This Exists

- Reduces instruction drift between tools.
- Makes model switching deterministic.
- Describes runtime prompt activation and model-specific layers.
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

## Runtime scope

`ACTIVATION_CONTRACT.yaml` governs behavioral activation in assembled Babel
runtime stacks. Model overlay names describe supported product adapters; they do
not require root host instruction files. The catalog/resolver owns assembly.
This tree has no model-manifest synchronization helper or separate contributor
startup sequence.
