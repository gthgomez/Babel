# Start Here

`Babel-public` is easiest to understand through one deterministic success path:

1. install `babel-cli`
2. validate the public repo
3. preview a resolved stack/manifest
4. compare it to a golden output checked into the repo
5. only then decide whether you want the advanced runtime harness

## First Success

Install dependencies:

```powershell
cd .\babel-cli
npm install
cd ..
```

Run the public validation suite:

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

Preview the backend example:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

Expected reference output:

- [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json)

Preview the Android/mobile example:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

Expected reference output:

- [examples/manifest-previews/mobile-direct.json](./examples/manifest-previews/mobile-direct.json)

If you want to try the compiled CLI afterward:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js doctor
```

## What You Just Proved

- the catalog is internally valid
- the public resolver expands default skills and dependencies
- the ordered manifest comes from `prompt_catalog.yaml`
- Android/mobile is a real first-class route in the public helper flow
- the compiled CLI is available if you want to move from preview into runtime diagnostics

## Where To Go Next

- [README.md](./README.md) for the repo overview
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) for copy-paste CLI flows
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the technical shape
- [docs/BABEL_LOCAL_MODE.md](./docs/BABEL_LOCAL_MODE.md) for runtime expectations
- [BABEL_BIBLE.md](./BABEL_BIBLE.md) if you are wiring Babel into another model/client surface
