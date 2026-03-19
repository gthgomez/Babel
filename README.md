# Babel

Babel is the prompt operating system for the wider `Project_SaaS` workspace.

It provides:
- routing
- behavioral rules
- domain expertise layers
- model adapters
- project overlays
- optional task overlays

## Start Here

For humans and LLMs, the primary entrypoint is [BABEL_BIBLE.md](./BABEL_BIBLE.md).

If you want a model to use Babel before doing a task, tell it:

`Read BABEL_BIBLE.md and use Babel before planning or completing this task.`

If the shorthand is just `use Babel`, the intended repo root is:

`<YOUR_PROJECT_ROOT>/Babel`

Minimum first-read chain:

1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `README.md`
4. `prompt_catalog.yaml`

## Invocation Snippets

Use short language that points the model at the Bible doc first.

### Codex

`Read BABEL_BIBLE.md, use Babel for this task, then plan and execute using the selected instruction stack.`

### GPT

`Read BABEL_BIBLE.md first. Use the Babel system to choose the right instructions before answering or doing the task.`

### Claude

`Read BABEL_BIBLE.md and follow Babel before planning. Load the relevant Babel layers for this task, then proceed.`

### Gemini

`Read BABEL_BIBLE.md first and use Babel to assemble the correct instruction stack before analyzing or completing the task.`

## Repository Structure

- `BABEL_BIBLE.md`
  Human-facing entrypoint for invoking Babel.
- `PROJECT_CONTEXT.md`
  Repo context for Babel itself.
- `prompt_catalog.yaml`
  Source of truth for prompt file registration and load order metadata.
- `00_System_Router/`
  Orchestrator and routing logic.
- `01_Behavioral_OS/`
  Universal execution behavior.
- `02_Domain_Architects/`
  Primary expertise layers.
- `02_Skills/`
  Reusable technical skills selected independently of thin domains.
- `03_Model_Adapters/`
  Model-specific tuning.
- `04_Meta_Tools/`
  Prompt authoring and governance support.
- `05_Project_Overlays/`
  Thin project context layers.
- `06_Task_Overlays/`
  Optional reusable task-specific overlays.
- `runs/`
  Generated runtime output. Ignored in Git.

## Recommended Load Shape

Standard stack:

1. `01_Behavioral_OS`
2. one `02_Domain_Architects` file
3. zero or more `02_Skills` files when applicable
4. one `03_Model_Adapters` file
5. one `05_Project_Overlays` file when applicable
6. zero or more `06_Task_Overlays`
7. optional pipeline stages

## Current Usage Pattern

- Use [BABEL_BIBLE.md](./BABEL_BIBLE.md) as the public entrypoint.
- Use [prompt_catalog.yaml](./prompt_catalog.yaml) as the registry.
- Use [OLS-v9-Orchestrator.md](./00_System_Router/OLS-v9-Orchestrator.md) for the default typed runtime lane in `babel-cli`.
- Keep [OLS-v8-Orchestrator.md](./00_System_Router/OLS-v8-Orchestrator.md) available as the compatibility fallback lane during migration.

## Repo Hygiene

Before changing Babel itself:
- preserve layering boundaries
- prefer overlays over new domain roles when possible
- update the catalog when adding routable files
- validate that all catalog paths resolve

## Validation

Run the catalog validator from the Babel root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
```

Run the local stack resolver regression tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-local-stack.ps1
```

Run the local session analyzer regression tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-analyze-local-sessions.ps1
```

Run compiled-memory manifest regression tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-sync-model-manifests.ps1
```

Run control-plane resolver semantic regression tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-control-plane.ps1
```

Run local hooks and scripts regression tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-local-hooks-and-scripts.ps1
```

Run Phase 4 eval fixture grading checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-eval-quality-fixtures.ps1
```

Run Phase 4 JSON output contract regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-eval-quality-fixtures-json-output.ps1
```

Run Phase 5 comparison workflow regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-comparison-workflow.ps1
```

Run Local evidence normalization regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-normalize-local-evidence.ps1
```

Run Local policy candidate generation regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-generate-local-policy-candidates.ps1
```

Run Local policy activation regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-activate-local-policies.ps1
```

Run Phase 4 global comparison validation regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-validate-global-policy-comparison.ps1
```

Run Phase 5 local-learning prompt evolution staging regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-stage-local-learning-prompt-evolutions.ps1
```

Run Phase 6 launch-helper regression checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-launch-babel-local.ps1
```

Preview a recommended local stack:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\resolve-local-stack.ps1 -Project GPCGuard -TaskCategory frontend -Model codex
```

Log a completed Babel Local session:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\log-local-session.ps1 -Project GPCGuard -TaskCategory frontend -Model codex -ClientSurface codex_extension -Result success
```

Start a deterministic Babel Local session lifecycle record:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-local-session.ps1 -TaskCategory devops -Project global -Model claude -ClientSurface claude_code
```

Launch Babel Local in one command (plan/act startup helper):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\launch-babel-local.ps1 -TaskCategory backend -Model codex -WorkMode plan -TaskPrompt "Implement only the requested backend fix."
```

End a deterministic Babel Local session lifecycle record:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\end-local-session.ps1 -SessionId <session-id> -Result success
```

Analyze logged Babel Local sessions:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\analyze-local-sessions.ps1 -Format text
```

Normalize Local Mode evidence into canonical JSONL:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\normalize-local-evidence.ps1
```

Generate Phase 2 Local policy candidates and audit output from normalized evidence:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\generate-local-policy-candidates.ps1
```

Activate eligible Phase 3 Local policies from candidate and normalized evidence artifacts:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\activate-local-policies.ps1
```

Run the legacy compiled-memory pipeline if you need historical compatibility reports:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\sync-model-manifests.ps1
```

Check that generated model memory files are up to date:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\sync-model-manifests.ps1 -Check
```

## Git Workflow

Recommended:

1. Keep Babel in its own Git repo.
2. Treat prompt changes like code changes.
3. Commit router, catalog, overlay, and adapter updates with clear intent.
4. Run the validator before commits that touch the catalog or load order.

## License

This repository is licensed under the [MIT License](./LICENSE).

## Collaboration Docs

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [GOVERNANCE.md](./GOVERNANCE.md)
- [BABEL_OSS_READINESS_CHECKLIST.md](./docs/BABEL_OSS_READINESS_CHECKLIST.md)
- [BABEL_LOCAL_MODE.md](./docs/BABEL_LOCAL_MODE.md)
- [BABEL_LOCAL_SELF_LEARNING.md](./docs/BABEL_LOCAL_SELF_LEARNING.md)
- [BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md](./docs/BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md)
- [BABEL_LOCAL_V1_1_PHASE_4_5_PLAN.md](./docs/BABEL_LOCAL_V1_1_PHASE_4_5_PLAN.md)
- [BABEL_LOCAL_OPTIMIZATION_RESEARCH.md](./docs/BABEL_LOCAL_OPTIMIZATION_RESEARCH.md)
- [BABEL_COMPILED_MEMORY_WORKFLOW.md](./docs/BABEL_COMPILED_MEMORY_WORKFLOW.md)
- [BABEL_LOCAL_HOOKS_AND_SCRIPTS.md](./docs/BABEL_LOCAL_HOOKS_AND_SCRIPTS.md)
- [BABEL_API_MODE.md](./docs/BABEL_API_MODE.md)
- [VSCODE_MODEL_INVOCATION_GUIDE.md](./docs/VSCODE_MODEL_INVOCATION_GUIDE.md)
- [BABEL_LOCAL_TOOLING_IMPROVEMENT_PLAN.md](./docs/BABEL_LOCAL_TOOLING_IMPROVEMENT_PLAN.md)
- [BABEL_COMPARISON_WORKFLOW.md](./docs/BABEL_COMPARISON_WORKFLOW.md)
- [BABEL_PROJECT_SYSTEM_INTEGRATION.md](./docs/BABEL_PROJECT_SYSTEM_INTEGRATION.md)
- [TOOL_PROFILES.md](./docs/TOOL_PROFILES.md)
- [CODEX_HANDOFF_BABEL_LOCAL_IMPROVEMENT.md](./docs/CODEX_HANDOFF_BABEL_LOCAL_IMPROVEMENT.md)
- [PLATFORM_CAPABILITY_MATRIX.md](./docs/PLATFORM_CAPABILITY_MATRIX.md)
- [PLATFORM_MODE_GUIDELINES.md](./docs/PLATFORM_MODE_GUIDELINES.md)
- [ROUTER_PLATFORM_FIELDS.md](./docs/ROUTER_PLATFORM_FIELDS.md)
- [WEB_LLM_BABEL_STATUS_AND_PLAN.md](./docs/WEB_LLM_BABEL_STATUS_AND_PLAN.md)
- [WEB_LLM_DEEP_RESEARCH_PROMPT.md](./docs/WEB_LLM_DEEP_RESEARCH_PROMPT.md)

## Portability Note

Babel currently uses Windows-first absolute paths inside some routing contracts by design.

That is intentional for the local orchestrator/runtime. Public-facing repo docs should use relative links where possible.
