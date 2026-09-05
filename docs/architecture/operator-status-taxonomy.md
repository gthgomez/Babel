# Babel Operator Status Taxonomy

<!--
status: ACTIVE
last_verified: 2026-09-05
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

## Epistemic Honesty Invariant for Operator Surfaces (added 2026-09-05)

Every surface that reports model, routing, provider, cost, health, fallback,
or reliability state to the operator must preserve the epistemic class of
each fact it renders. The four classes:

| Class | Rule | Example rendering |
| --- | --- | --- |
| Known | A verified fact renders as the fact, with its provenance when non-obvious. | `OPENROUTER_API_KEY set — presence only; validity, quota, and reachability not verified` |
| Historical | An observation from a past run is labeled historical, bound to its stage/timestamp, and never implies the present. | `success on 'tier' (stage 'chat', 2026-09-05T01:02:03Z) (historical)` |
| Configured | Configuration state is never presented as runtime health or readiness. | `fallback — configured · credential missing · readiness not verified` |
| Unknown | Absence of data renders as unknown/not recorded/not observed — never as a plausible default. | `cost unknown — not published in model policy` · `Qualification not recorded` · `live reachability not checked by this surface` |

Forbidden transformations (each regression-tested in
`babel-cli/src/interactive/commands/modelDetail.test.ts`):

- credential env-var present → credential valid
- configured provider → reachable/healthy
- configured fallback → ready fallback
- missing cost metadata → `$0` (only an explicit `0` may render as `$0`)
- historical upstream → current upstream (observed upstream is historical)
- model enabled → model qualified
- missing evidence → false success
- missing evidence → program exception instead of a clean blocked state

Correlation rule: telemetry facts must be joined by their canonical key
(stage, SHA, digest) — never by filename ordering or incidental list order.

Cost rule: an unknown or derived-from-unknown estimate must never render as
a dollar figure. A per-run estimate derived from per-M costs renders only
when at least one per-M cost is published.
