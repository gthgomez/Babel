# Diagnostics (non-production)

## `windowsDirectoryAnchorAcquire.mjs`

Windows-only experiment for directory-anchor helper startup timing. Uses the same
encoded helper shape and path arguments as production, plus `TIMING:` lines for
helper-side Add-Type duration. Does not change `effectDirectoryAnchors.ts` or the
15s acquire policy.

CI: `.github/workflows/windows-directory-anchor-diagnostic.yml` (two `windows-latest`
matrix instances). Matrix v2: **10 sequential** (index 1 = first-helper compilation
after version probe) + **10 at verified shard `--test-concurrency`** (from
`run_ci_unit_shard.mjs`); **80 samples** total per run (2 runtimes × 20 × 2 runners).

Artifacts: `report-instance-*.json` (incremental checkpoint) and
`samples-instance-*.jsonl` (append-only). Prior run **39729334133** @ `b200bb91`
remains invalid-design evidence (parallel stress); not deleted.

`productionWouldFail` uses **READY acquisition latency** (and refusal/protocol errors),
not post-kill exit latency. Helper output is drained before finalize.
