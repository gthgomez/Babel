# Babel Run Remediation Checklist

## Goal

Close the current gap between raw `runs/` bundles and canonical Local Mode lifecycle logging.

## Checklist

- Tighten the QA gate.
  Acceptance:
  `babel-cli` must refuse Stage 4 if the latest `03_qa_verdict_v*.json` is not `PASS`, including resume/manual flows.

- Audit raw bundles against Local Mode lifecycle logs.
  Acceptance:
  `tools/report-run-consistency.ps1` flags lifecycle coverage gaps using UTC day + project + model correlation and surfaces `QA REJECT -> EXECUTION_COMPLETE` violations.

- Report orphaned partial runs by day, model, and project.
  Acceptance:
  the consistency report emits grouped partial-bundle counts so incomplete runs are visible without manually inspecting `runs/`.

- Make run logging explicit in the first-read path.
  Acceptance:
  `BABEL_BIBLE.md` tells LLMs near the top that raw bundles are insufficient and that `start-local-session.ps1` / `end-local-session.ps1` or `launch-babel-local.ps1` are required for canonical Local Mode runs.

## Operator Commands

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\report-run-consistency.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-report-run-consistency.ps1
```
