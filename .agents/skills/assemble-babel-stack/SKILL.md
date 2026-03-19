---
name: assemble-babel-stack
description: Assembles the correct Babel instruction stack for a task. Use when deciding which Behavioral OS, Domain Architect, Skills, adapters, and overlays should be loaded before implementation.
---

# Assemble A Babel Stack

## Workflow

1. Read `BABEL_BIBLE.md`, `PROJECT_CONTEXT.md`, and `.agents/rules/01-startup-and-scope.md`.
2. Identify:
   - task purpose
   - primary domain
   - needed reusable skills
   - target model adapter
   - project or task overlays
3. Prefer one domain architect plus only the skills and overlays needed for the task.
4. If the task changes routing or catalog behavior, classify the change as `COMPATIBLE`, `RISKY`, or `BREAKING`.
5. Output the proposed load order and why each layer is necessary.

## Output

- Recommended stack
- Why each layer is included
- Any risk or compatibility note
