---
name: ratchet-preflight
description: Architectural-budget diagnostic command reference.
---

# Architectural-budget diagnostic

Contributor policy is owned only by [AGENTS.md](../../../AGENTS.md).
`tools/preflight-ratchet.ps1` reports files near their budgets; inspect its
parameters for the current warning threshold. `tools/check-architectural-budget.ps1`
and `config/architectural-budget/` own enforced limits and baselines.

```powershell
pwsh tools/preflight-ratchet.ps1
pwsh tools/check-architectural-budget.ps1
```

A warning indicates a file approaching a limit; a failure identifies a measured
budget violation. Diagnose actual ownership/dependencies before proposing a
cohesive extraction. Automatically updating baselines would hide regressions;
AGENTS.md governs repairs and verification. These commands do not certify full CI.
