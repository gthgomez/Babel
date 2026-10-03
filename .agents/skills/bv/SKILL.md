---
name: bv
description: Optional configured-workspace verification adapter reference.
---

# Workspace verification adapter

Contributor policy and verification selection are owned only by
[AGENTS.md](../../../AGENTS.md#delivery-and-verification).
`bv.ps1` is an optional workspace helper, not a script shipped by Babel.
When a workspace explicitly supplies it, inspect its configuration and command
mapping before invocation. `-List` can expose configured checks; `-Json` exposes
per-check results when supported by that installed version.

Default, budget, and full modes are adapter-specific choices, not a mandatory
sequence. A helper's green summary covers only commands actually executed and
does not certify hosted CI. In a clean clone, use the canonical commands in
AGENTS.md and package scripts directly; no workspace map or helper is required.
