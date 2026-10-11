# Validation Test Plan

- `babel skill validate skills/session-retro` returns GREEN.
- `contracts/input.schema.json` and `contracts/output.schema.json` parse as JSON.
- `skill.yaml` `inputs`, `outputs`, and `tests` point at those paths.
- `SKILL.md` keeps on-error to one failure, session-end to at most 3 lessons, and requires the retro log in addition to memory or instructions.
- Prompt-layer owner `02_Skills/Governance/Session-Retro-v1.md` is registered as `skill_session_retro` in `prompt_catalog.yaml`.
