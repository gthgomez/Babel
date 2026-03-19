# Model Switch Handoff Template

Copy this block when switching between Claude Code, Codex, Gemini CLI, or a web LLM.

```text
[MODEL_SWITCH_HANDOFF]
project: Babel
task_purpose: <UI_UX|Coding|Safety_Governance|Research|Compliance_Regulatory|General_Intelligence|Other>
current_phase: <plan|implement|verify|review>
completed_steps:
- ...
pending_steps:
- ...
key_decisions:
- ...
constraints:
- ...
overlay_status: <loaded|missing|outside_workspace>
path_corrections:
- original -> corrected (reason)
command_rewrites:
- original -> rewritten (reason)
context_inject:
- source + summary if overlay unavailable
files_touched:
- relative/path.ext
verification_run:
- command + key result
next_action: <single next action>
[/MODEL_SWITCH_HANDOFF]
```
[MODEL_SWITCH_HANDOFF]
project: Babel
task_purpose: <Purpose>
current_phase: <plan|act>
prior_models: <comma-separated>

overlay_status:
- requested_overlay: <Purpose>-<Model>.md
- overlay_loaded: <yes|no>
- reason_if_not_loaded: <outside workspace|missing file|n/a>

path_corrections:
- referenced_path: <path from prior model>
- resolved_path: <verified path>
- evidence_command: <rg/ls command used>

command_rewrites:
- original: <command>
- rewritten: <safe command>
- reason: <portability/safety/path fix>

completed_steps:
- ...

pending_steps:
- ...

constraints:
- PLAN-only or implementation constraints

files_touched:
- ...

verification_run:
- command: <cmd>
- result: <pass|fail>
- notes: <short>

next_action: <what next model should do>
[/MODEL_SWITCH_HANDOFF]
