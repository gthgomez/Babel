# Diagnostics (non-production)

## `windowsDirectoryAnchorAcquire.mjs`

Windows-only experiment for directory-anchor helper startup timing. Uses the same
encoded helper shape and path arguments as production, plus `TIMING:` lines for
helper-side Add-Type duration. Does not change `effectDirectoryAnchors.ts` or the
15s acquire policy.

CI: `.github/workflows/windows-directory-anchor-diagnostic.yml` (two `windows-latest`
matrix instances). Artifacts: `report-instance-*.json` with every sample preserved.
