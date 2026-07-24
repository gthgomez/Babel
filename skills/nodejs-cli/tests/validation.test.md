# Validation Test Plan

- `babel skill validate skills/nodejs-cli` returns GREEN.
- `babel skill audit skills/nodejs-cli` returns GREEN.
- `contracts/input.schema.json` and `contracts/output.schema.json` parse as JSON.
- `SKILL.md` includes entrypoint, args, exit-code, stdout/stderr, path, and verification rules.
- Export remains blocked by default while status is experimental.
- Export succeeds with `--allow-experimental`.
