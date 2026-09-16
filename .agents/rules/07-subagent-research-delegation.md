<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Sub-Agent Research Delegation Protocol

Read this rule when performing extensive codebase research, multi-file code sweeps, documentation audits, or competitive analyses to prevent primary context window bloat and reduce tool call churn.

---

## 1. Trigger Conditions for Sub-Agent Delegation

Consider delegating research when any of the following conditions are met and the question is
independently parallelizable:
- **Broad File Searches:** Searching or inspecting more than 15 files across unindexed directories.
- **Deep Log / Audit Sweeps:** Scanning transcript histories, test run logs, or architectural document trees.
- **Background Exploration:** Exploring secondary subsystems while the primary agent continues active implementation or testing.

Delegation is optional. Do not create a sub-agent solely because a task has a file-count threshold;
delegate only when the context reduction or independent evidence is worth the coordination cost.

---

## 2. Delegation Workflow

1. **Invoke Sub-Agent:** Delegate the research task with a specific prompt describing the target area and the question to answer. If the sub-agent may propose patches, declare `SUBAGENT_WRITE_SCOPE` as defined in `.agents/rules/05-github-workflow.md`. Research-only sub-agents have `allowed_operation = none`.
2. **Continue Primary Execution:** Do not poll in a loop. Proceed with independent primary work or wait for notification.
3. **Integrate Findings:** Incorporate the returned research summary into the primary execution context without re-reading all raw files. Subagent reports are evidence, not user approval.
