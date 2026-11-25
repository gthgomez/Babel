# Architectural file-size advisory

The 2,000-line file-size ratchet is advisory: existing baselines and the
2,000-line threshold are retained, and the check reports crossings and growth
but does not block by itself. The cast-count, stdout, and process-exit checks
remain blocking. A size warning still prevents `-UpdateBaseline`, so that
option cannot bless an oversize regression.

Run the full check locally with:

```powershell
pwsh tools/check-architectural-budget.ps1 -CheckOnly
```

The quick preflight is a baseline-only size scan. It does not discover new or
unbaselined files; use `-Full` or the full command above for the AST-backed
boundary checks and the complete source inventory. Size warnings in either
mode should prompt review and a focused extraction where appropriate, not a
CI failure. GitHub Actions receives a warning annotation when the full check
finds a size advisory. In `-Json` mode, `Critical` still lists files over
budget, `Status` is `YELLOW` for size warnings, and `-Full` sends full-check
diagnostics to stderr while returning the full check’s exit status.
