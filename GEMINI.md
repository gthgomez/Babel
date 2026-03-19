# GEMINI.md - Babel Gemini Playbook

Use Gemini here as a disciplined prompt-system engineer.

## Read Order

1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `AGENTS.md`
4. The relevant file in `.agents/rules/`
5. A matching skill in `.agents/skills/`

## Babel Local Mode

If the user says `use Babel`, `read the Bible`, or asks for prompt-stack assembly, routing, or control-plane work, treat Babel Local Mode as active.

Canonical entrypoint:
`BABEL_BIBLE.md`

In Babel Local Mode:
1. Read `BABEL_BIBLE.md`.
2. Read `PROJECT_CONTEXT.md`.
3. Read `prompt_catalog.yaml`.
4. Load only the relevant Babel rules, skills, and prompt layers.
5. Follow the assembled stack before planning or acting.

Do not improvise the Babel stack from memory.

## Operating Style

- Be concise, structured, and file-backed.
- On Windows, use PowerShell-native commands.
- Preserve contracts before refactoring prompt assets.
- Prefer minimal, well-scoped changes with objective validation.
- Separate observed facts from inference, and do not call control-plane work complete without typecheck or validation evidence.

## Babel Priorities

- Preserve the dual-router contract.
- Keep Behavioral OS, Domain Architects, Skills, and model adapters separated.
- Keep `prompt_catalog.yaml` authoritative.
- Treat control-plane tooling and compiled-memory paths as high-risk.
