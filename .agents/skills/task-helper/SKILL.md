---
name: task-helper
description: Optional configured-workspace task lifecycle adapter reference.
---

# Workspace task helper

Contributor policy is owned only by [AGENTS.md](../../../AGENTS.md).
`task-helper.ps1` is optional workspace tooling, not shipped by Babel. Its
installed implementation/configuration defines bootstrap, precheck and resolve
commands, issue locations, generated artifacts and side effects. Inspect those
before use within the authorized task; helper labels do not grant authority.

Babel work does not require issue-state transitions, daily logs, host-specific
brain stubs, duplicate plans, or this helper. Use the existing task record and
canonical repository commands when the adapter is absent. Configured verification
results cover only commands actually executed, with evidence reuse governed by
AGENTS.md. Dry-run and mutation flags depend on the installed version.
