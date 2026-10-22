# Start Here

Babel is a **local terminal coding agent**. First success is talking to it.

This page is the **canonical first-success** path. For the docs map (product vs architecture vs campaigns),
see [docs/README.md](./docs/README.md). Command reference: [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md).

There is an optional second path: inspect the Prompt OS / instruction stack
without a model or API key. That path is useful, but it is not the product.

Choose an install path:

- **Windows x64 — Babel Desktop 0.1.3:** download it from the
  [v0.1.3 release](https://github.com/gthgomez/Babel/releases/tag/v0.1.3). It includes Node and the Babel CLI. Follow the
  [setup guide for that release](https://github.com/gthgomez/Babel/blob/v0.1.3/babel-desktop/docs/INSTALL-WINDOWS.md), then skip to
  [step 2](#2-first-useful-request-in-your-own-repository).
- **Current source:** follow the build instructions below. Source builds can
  contain behavior that is not included in the published Desktop application.
  After build, the documented command is `node <Babel clone>/babel-cli/dist/index.js`
  (`babel` is not assumed to be on PATH).

## Requirements

- Node.js **22.19.0+ (22.x) or 24.13.1+ (24.x)** (see `babel-cli/package.json` `engines.node`)
- A clone of this repository
- For model-backed sessions: a provider key (see `babel-cli/.env.example`)
- For running your project's tests or builds: Docker plus a sandbox image that
  contains your project's tools (default `safe_repo` profile; see below)

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

For model-backed CLI use, create `~/.babel/config`, copy the blank
`babel-cli/.env.example` into `~/.babel/config/.env`, and set only the provider
keys you use. On macOS/Linux, run `chmod 600 ~/.babel/config/.env` after copying;
Babel refuses a private credential file with broader permissions. On Windows,
use `%USERPROFILE%\.babel\config\.env` or the masked Desktop setup.
Host or CI environment variables take precedence.

A saved credential and a listed model do not confirm account access or
successful inference. Select the provider and model you intend to use; the
first real response is the first evidence that route works.

Execution profile: keep the default `safe_repo` profile for project execution
and prepare an image containing your project's tools
(`BABEL_BENCHMARK_DOCKER_IMAGE`). `safe_repo` **fail-closes** without Docker
and a configured image. `dev_local` permits supported host inspection
(`rg`, `git status`, `cat`) without Docker; selecting it alone does **not**
enable repository test or build commands. Details:
[CHAT_MODE.md](./docs/CHAT_MODE.md#execution-profile-and-isolation-h13).

## 2. First useful request in your own repository

Pick the repository you want Babel to work on. In Desktop, use **Open project**
and trust that exact folder. In the CLI, change into it first, so Babel targets
it instead of the Babel checkout:

```powershell
cd C:\path\to\your-repo
node C:\path\to\Babel\babel-cli\dist\index.js interactive
```

Then send one bounded, read-only investigation whose result you can check:

```text
> Using this repository's README and code, trace one small documented behavior from its entry point to its implementation and nearest relevant test. Cite file paths and identify the test command documented or configured in the repository. Do not change files, install dependencies, or run tests or builds. If you cannot find a test or command, say so.
```

Check two of the cited files and the named test command yourself. This asks
Babel to inspect and report; it does not edit files or run anything. Ask for
explanation, a plan, or a change as explicit follow-ups, for example:

```text
> Propose a fix for <issue> and the checks you would run; do not edit yet
> Fix the failing auth test
```

Changes and test runs need the execution setup above. Configuration, a
successful response, changed files, and passed checks are separate claims, each
with its own evidence.

Useful commands inside the session (`/help` lists the rest):

```text
/model         switch models
/mode          chat / plan / deep
/diff          inspect the latest changes
/resume        continue an earlier conversation
/permissions   change approval behavior
/help          see everything
```

One-shot (run from your target repository):

```powershell
node <Babel clone>\babel-cli\dist\index.js "Explain this repository and identify the highest-risk test gap"
node <Babel clone>\babel-cli\dist\index.js plan "Split the auth module safely"
node <Babel clone>\babel-cli\dist\index.js deep "Harden the migration path and verify it"
```

Recovery: `node .\babel-cli\dist\index.js undo` restores the last checkpoint.
The TUI does not currently expose `/undo`; use `/checkpoint` and `/restore`
inside a session, or `undo` from the CLI.

Read [docs/CHAT_MODE.md](./docs/CHAT_MODE.md) for routing, sessions, and
permissions. Read [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) for the
full operational guide.

## 3. Optional: inspect the harness without a model

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

After steps 1–2: you have a working install, a selected repository, and one
checkable, file-backed investigation. That is one successful request, not a
general reliability rating.

After step 3 (optional): the catalog is valid, the public resolver expands
default skills and dependencies, and the ordered manifest comes from
`prompt_catalog.yaml`.

## Where to go next

- [README.md](./README.md) — product overview
- [docs/README.md](./docs/README.md) — docs index (product path vs architecture vs campaigns)
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) — command reference (chat / plan / deep / doctor)
- [docs/CHAT_MODE.md](./docs/CHAT_MODE.md) — default daily runtime
- [docs/VISION.md](./docs/VISION.md) — product principles
- [docs/ROADMAP.md](./docs/ROADMAP.md) — public NOW / NEXT / LATER (evidence-based)
- [docs/STATUS.md](./docs/STATUS.md) — available vs narrowly verified vs active qualification (when present on this revision)
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) — Prompt OS layers (progressive disclosure)
- [INTEGRATION.md](./INTEGRATION.md) — model/integration invocation contract
