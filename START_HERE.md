# Start Here

The canonical Babel repository has two complementary first-success paths:

- **Try the product:** build the CLI and start the default conversational chat
  agent.
- **Inspect the harness:** validate the public repo and preview a resolved stack
  without a model or API key.

The inspectable path is:

1. install `babel-cli`
2. validate the public repo
3. preview a resolved stack/manifest
4. compare it to a golden output checked into the repo
5. then decide whether to run a model-backed coding session

The current public release is built around a simple promise: a new user should
be able to clone the repo, install dependencies, start the chat agent when a
provider is configured, or validate the catalog and preview a stack without
model-backed execution.

## First runtime success

After installing dependencies, build the CLI and start the default
conversational agent:

```powershell
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js interactive
```

For a one-shot chat task:

```powershell
node .\babel-cli\dist\index.js "Explain this repository and identify the highest-risk test gap"
```

Use [docs/CHAT_MODE.md](./docs/CHAT_MODE.md) for the runtime contract and
`babel plan` / `babel deep` when the task needs stronger gates.

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
  -Model deepseek `
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
  -Model deepseek `
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
- the public release gate runs from this checkout
- the public resolver expands default skills and dependencies
- the ordered manifest comes from `prompt_catalog.yaml`
- Android/mobile is a real first-class route in the public helper flow
- the compiled CLI is available if you want to move from preview into runtime diagnostics
- public docs, examples, and generated release artifacts are meant to stand on their own without private workspace context

## Where To Go Next

- [README.md](./README.md) for the product overview and chat-first quick start
- [docs/VISION.md](./docs/VISION.md) for current state and where Babel is going
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) for copy-paste CLI flows
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) for the technical shape
- [docs/architecture/BABEL_LOCAL_MODE.md](./docs/architecture/BABEL_LOCAL_MODE.md) for runtime expectations
- [BABEL_BIBLE.md](./BABEL_BIBLE.md) if you are wiring Babel into another model/client surface
