# Babel Startup And Scope

## Required Context

1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `AGENTS.md`

## Repo Map

- `00_System_Router/` - orchestration and routing contracts
- `01_Behavioral_OS/` - universal behavior
- `02_Domain_Architects/` - thin strategy layers
- `02_Skills/` - reusable technical knowledge
- `03_Model_Adapters/` - model-specific tuning
- `04_Meta_Tools/` - prompt tooling and governance
- `05_Project_Overlays/` and `06_Task_Overlays/` - context overlays
- `babel-cli/` - runtime harness

## Scope Discipline

- Assemble the smallest correct instruction stack.
- Do not invent routable files outside `prompt_catalog.yaml` unless the task explicitly adds them.
- Treat router and behavioral changes as cross-repo changes.
