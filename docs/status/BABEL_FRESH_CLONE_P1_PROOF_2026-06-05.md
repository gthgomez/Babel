# Fresh-Clone P1 Proof

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Date: 2026-06-05

## Goal

Validate the P1 fresh-clone trust path for Babel Lite onboarding:

- users can reach `bl ask` quickly after install/build,
- missing `dist/` guidance is explicit,
- provider-configured and provider-missing modes are documented without repeated approval friction.

## Smoke Checklist

Run in PowerShell from a fresh repository checkout:

1. Build and verify CLI startup

```powershell
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js --help
```

Observed:

- build completed successfully.
- help includes `bl ask`, `bl plan`, `bl fix` and `Command Guide` language.

2. Confirm first useful runtime checks pass

```powershell
node .\babel-cli\dist\index.js doctor --scope workspace --json
```

Observed:

- `"status": "pass"`
- `summary`: `pass: 14, warn: 0, fail: 0, skip: 0`

3. Confirm Lite usability benchmark remains green

```powershell
node .\babel-cli\dist\index.js benchmark lite --json
```

Observed:

- `summary`: `scenarios: 4, pass: 4, fail: 0`

4. Confirm missing-entrypoint guidance includes the required build command

- `babel-cli/src/commands/liteCommands.test.ts` asserts both wrappers contain `npm --prefix .\\babel-cli run build`.
- `babel-cli/src/doctor.test.ts` asserts the `runtime.cli_entrypoint` `DIST_MISSING` check carries the same fix hint:
  `Run npm --prefix .\babel-cli run build before invoking dist-first CLI checks.`

5. Confirm provider-mode behavior stays short and explicit

Configured providers:

```powershell
node .\babel-cli\dist\index.js doctor --scope env --json
```

Observed:

- `env.provider.any_key_present` status `pass` when provider keys are set.

Providerless path:

```powershell
$env:DEEPINFRA_API_KEY=''; $env:ANTHROPIC_API_KEY=''; $env:GROQ_API_KEY=''; $env:OPENAI_API_KEY=''
node .\babel-cli\dist\index.js doctor --scope env --json
```

Observed:

- `status: "warn"` with `diagnostic_code: "PROVIDER_ENV_MISSING"` and a clear recovery hint:
  `Set a provider API key or use recorded-provider replay fixtures for governance proof.`

## Evidence Location

- This check was run against current `./`.
- Commands are intentionally non-destructive and use the dist-built CLI path.
