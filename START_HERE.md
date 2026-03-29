# Start Here

In under two minutes, `Babel-public` can show you the exact ordered stack it would resolve for a real task.

The default public path is the typed `v9` lane; `v8` remains only as a legacy fallback.

The quickest way to understand it is one deterministic success path:

1. install `babel-cli`
2. validate the public repo
3. preview a resolved stack/manifest
4. compare it to a golden output checked into the repo

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
  -SkillIds skill_android_pdf_processing `
  -Format json
```

Expected reference output:

- [examples/manifest-previews/mobile-pdf-direct.json](./examples/manifest-previews/mobile-pdf-direct.json)

## What You Just Proved

- the catalog is internally valid
- the public resolver expands default skills and dependencies
- the ordered manifest comes from `prompt_catalog.yaml`
- Android/mobile is a real first-class route in the public helper flow

## Where To Go Next

- [README.md](./README.md) for the repo overview
- [BABEL_BIBLE.md](./BABEL_BIBLE.md) for the invocation contract
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the technical shape
- [docs/BABEL_LOCAL_MODE.md](./docs/BABEL_LOCAL_MODE.md) for runtime expectations
