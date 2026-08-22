# Start Here

Babel is a **local terminal coding agent**. First success is talking to it.

There is an optional second path: inspect the Prompt OS / instruction stack
without a model or API key. That path is useful, but it is not the product.

Babel is currently run **from a clone of this repository**. It is not published
as an npm registry package. After build, the documented command is
`node .\babel-cli\dist\index.js` from the repo root (`babel` is not assumed
to be on PATH).

## Requirements

- Node.js **22.5+** (see `babel-cli/package.json` `engines.node`)
- A clone of this repository
- For model-backed sessions: a provider key (see `babel-cli/.env.example`)
- For host-side edits under the default execution profile: either Docker plus a
  sandbox image, **or** `dev_local` / an explicit host fallback (see below)

## 1. First success: talk to Babel

Install, build, and check the environment:

```powershell
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js doctor
```

macOS/Linux equivalent: `git clone https://github.com/gthgomez/Babel.git && cd Babel && npm --prefix ./babel-cli ci && npm --prefix ./babel-cli run build && node ./babel-cli/dist/index.js doctor`

Copy `babel-cli/.env.example` to `babel-cli/.env` and set only the providers
you use. Host or CI environment variables take precedence over that file.

Before the first mutation, pick an execution profile. The default `safe_repo`
profile expects Docker isolation and **fail-closes** without Docker and a
configured image.

`dev_local` executes approved tools directly on your host with no container
isolation. Use it only for repositories you own and code you have reviewed.
For untrusted repositories or unreviewed code, stay on the isolated
`safe_repo` profile.

For ordinary host coding:

```powershell
$env:BABEL_EXECUTION_PROFILE = 'dev_local'
```

Start the interactive TUI:

```powershell
node .\babel-cli\dist\index.js interactive
```

Then talk to it:

```text
> Explain this repository
> Fix the failing auth test
> Review the changes you just made
```

Useful commands inside the session (`/help` lists the rest):

```text
/model         switch models
/mode          chat / plan / deep
/diff          inspect the latest changes
/resume        continue an earlier conversation
/permissions   change approval behavior
/help          see everything
```

One-shot from the repo root:

```powershell
node .\babel-cli\dist\index.js "Explain this repository and identify the highest-risk test gap"
node .\babel-cli\dist\index.js plan "Split the auth module safely"
node .\babel-cli\dist\index.js deep "Harden the migration path and verify it"
```

Recovery: `node .\babel-cli\dist\index.js undo` restores the last checkpoint.
The TUI does not currently expose `/undo`; use `/checkpoint` and `/restore`
inside a session, or `undo` from the CLI.

Read [docs/CHAT_MODE.md](./docs/CHAT_MODE.md) for routing, sessions, and
permissions. Read [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) for the
full operational guide.

## 2. Optional: inspect the harness without a model

This checks catalog and stack resolution. It does not replace talking to Babel.

```powershell
pwsh -File .\tools\validate-public-release.ps1

pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode deep `
  -Format json
```

Compare the preview with
[examples/manifest-previews/backend-deep.json](./examples/manifest-previews/backend-deep.json).

Android/mobile example:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

Expected reference:
[examples/manifest-previews/mobile-chat.json](./examples/manifest-previews/mobile-chat.json).

## What you just proved

After path 1: you can build the CLI, run doctor, and start a coding session.

After path 2 (optional): the catalog is valid, the public resolver expands
default skills and dependencies, and the ordered manifest comes from
`prompt_catalog.yaml`.

## Where to go next

- [README.md](./README.md) — product overview
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) — copy-paste CLI flows
- [docs/CHAT_MODE.md](./docs/CHAT_MODE.md) — default daily runtime
- [docs/VISION.md](./docs/VISION.md) — product principles
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) — Prompt OS layers
- [INTEGRATION.md](./INTEGRATION.md) — model/integration invocation contract
