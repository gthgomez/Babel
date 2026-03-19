# Web Upload Guide (No Local File Access)

Use this when asking GPT/Claude/Gemini on the web about Babel.

## Minimum Upload Pack

1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `prompt_catalog.yaml`
4. The selected prompt files relevant to the task
5. Relevant project files

Generated manifests such as `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` are optional convenience context, not required authority.

Router state:
`OLS-v9-Orchestrator.md is the default typed runtime lane in babel-cli; OLS-v8-Orchestrator.md remains callable as the compatibility fallback until migration is explicitly retired.`

## Task-Specific Additions

- Router/control-plane issue:
  - `Babel/00_System_Router/OLS-v9-Orchestrator.md`
  - `Babel/00_System_Router/OLS-v8-Orchestrator.md` when checking fallback behavior
  - `Babel/prompt_catalog.yaml` when routing/entity selection is in scope
- Behavioral OS issue:
  - `Babel/01_Behavioral_OS/OLS-v7-Core-Universal.md`
  - `Babel/01_Behavioral_OS/OLS-v7-Guard-Auto.md`
- Catalog issue:
  - `Babel/prompt_catalog.yaml`

## Prompt Header For Web LLM

Paste this before your question:

```text
Context: You do not have repository access. Use only uploaded files.
Goal: Provide file-level recommendations and verification commands.
Constraint: Distinguish facts from assumptions.
```
