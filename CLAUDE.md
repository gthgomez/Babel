# CLAUDE.md — Babel Claude Adapter

This adapter supplements, but does not replace, the contributor router in
[AGENTS.md](./AGENTS.md). Start repository work there, then read
[PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) for Babel facts and contracts.

## Claude-Specific Guidance

- Use only tools the active host actually exposes; do not assume a particular
  Claude Code capability, tool name, or background-worker interface exists.
- On Windows, prefer PowerShell-native commands. In Git Bash, use absolute
  forward-slash paths.
- Keep searches scoped to the relevant package or prompt layer. Avoid generated
  output directories such as `runs/`, `artifacts/`, `runtime/`, `node_modules/`,
  and `dist/` unless the task explicitly concerns them.
- For Babel stack assembly, follow [INTEGRATION.md](./INTEGRATION.md),
  `prompt_catalog.yaml`, and the selected layers. Do not reconstruct a stack
  from memory.

## Pointers

- [ENGINEERING.md](./ENGINEERING.md) — code standards
- [babel-cli/CLAUDE.md](./babel-cli/CLAUDE.md) — package-specific CLI work
- [.agents/rules/05-github-workflow.md](./.agents/rules/05-github-workflow.md) — delivery workflow
- [docs/architecture/HARNESS_ARCHITECTURE_V1.md](./docs/architecture/HARNESS_ARCHITECTURE_V1.md) — normative runtime harness contract
