# Babel Operator Status Taxonomy

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Babel operator diagnostics separate command health from environment readiness so a missing shell, missing provider key, or absent build artifact is not reported as a generic repo failure.

## Doctor Result Levels

| Status | Meaning | Operator action |
| --- | --- | --- |
| `pass` | The checked surface meets the local contract. | Continue. |
| `warn` | The surface is usable but proof is incomplete or optional capability is absent. | Continue only if the warning is irrelevant to the task. |
| `fail` | The checked surface cannot satisfy the contract. | Fix before treating downstream results as trustworthy. |
| `skip` | The check is intentionally not applicable to the selected scope or mode. | No action unless the skipped surface was expected. |

## Doctor Diagnostic Codes

| Code | Scope | Meaning |
| --- | --- | --- |
| `ENV_SHELL_UNAVAILABLE` | `env`, resolver/export probes | The host shell or process spawn is unavailable, blocked, or incompatible with command execution. |
| `POWERSHELL_UNAVAILABLE` | `env`, resolver/export probes | No compatible `pwsh`/`powershell` runtime could be started. |
| `POWERSHELL_INCOMPATIBLE` | `env` | PowerShell was found but failed the compatibility probe. |
| `PROVIDER_ENV_MISSING` | `env` | No recognized provider API key is present; live provider-backed tests should use recorded replay or explicit skip artifacts. |
| `REPO_MISSING` | `repos` | A repo-map entry points to a missing path. |
| `EXTERNAL_PREREQUISITE_MISSING` | `repos` | A repo-map entry is intentionally treated as an external prerequisite and is missing in this workspace. |
| `DIST_MISSING` | `workspace` | `babel-cli/dist/index.js` is missing; build the CLI before dist-first checks. |
| `CATALOG_INVALID` | `workspace` | `prompt_catalog.yaml` is missing or fails the minimal doctor shape check. |
| `RESOLVER_INVALID` | `repos` | The resolver script is missing, exits nonzero, emits invalid JSON, or returns no usable `ProjectPath`. |

## Operator Commands

```powershell
node .\babel-cli\dist\index.js doctor --scope env --json --verbose
node .\babel-cli\dist\index.js doctor --scope repos --json --verbose
npm --prefix .\babel-cli run reliability:matrix -- --help
npm --prefix .\babel-cli run reliability:matrix -- --list
npm --prefix .\babel-cli run reliability:matrix -- --json
```

`doctor --scope repos` may surface PowerShell/environment failures as `resolution.environment_powershell`; that is intentional and means repo routing has not been tested yet.
