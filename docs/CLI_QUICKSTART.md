<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# CLI reference

Commands below were checked by running published `babel-harness@0.2.0` on 2026-11-03, unless a section says it is source-only. Install steps live in [START_HERE.md](../START_HERE.md). Problems you are likely to hit are in [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

Use `babel-harness`. `babel-agent` is the same binary. The help examples say `babel`, which is not installed.

## Published 0.2.0 commands

```sh
babel-harness --version
babel-harness --help
babel-harness doctor
babel-harness setup
babel-harness setup --json
babel-harness context preview @file README.md --json
babel-harness "Explain this repository in one sentence. Do not change files."
babel-harness plan --help
babel-harness deep --help
babel-harness undo --help
babel-harness models --help
babel-harness advanced
```

What those runs did:

| Command | Result on 0.2.0 |
| --- | --- |
| `--version` | Printed `0.2.0` |
| `--help` | Listed `setup`, `doctor`, `interactive`, `plan`, `deep`, `undo`, `resume`, `advanced` |
| `doctor` | Exited 1 without Docker. Node and package files were ok |
| `setup` and `setup --json` | Printed a checklist. No prompt and no model call |
| `context preview` | Exited 0 and printed the file. No key required |
| quoted task, no key | Exited 1. Missing `OPENROUTER_API_KEY` |
| `plan --help`, `deep --help`, `undo --help`, `models --help`, `advanced` | Exited 0 and printed help |

`plan --help` describes itself as: prepare a plan, ask for approval, then apply it in the same terminal flow. `deep --help` describes a governed apply-and-verify path. `undo --help` describes restoring the latest checkpoint. Those three were not given a real task in this pass.

`apply --help` exists and calls itself a legacy alias for `resume`. It is not a "apply this saved plan" command in the 0.2.0 help text.

`interactive` is listed as the way to open a session. A session was not driven in this pass, because it waits for a terminal.

## Commands that 0.2.0 does not have

Current source registers `provider`, `model`, `settings`, and a `work` alias. On the published 0.2.0 package:

- `settings show` ran as a chat task and failed without a key.
- `provider --help` and `work --help` printed `run` help.

Do not copy those examples from older pages until `babel-harness --help` on your installed version lists them. The source contract is [CLI_COMMAND_CONTRACT.md](./CLI_COMMAND_CONTRACT.md), and it is marked as source-tree grammar.

## Execution profile

The default is `safe_repo`. `doctor` requires a Docker server and `BABEL_BENCHMARK_DOCKER_IMAGE`. It does not fall back to the host. The image pull, and the fact that the recommended image is Node rather than a Python or Java toolchain, is in [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#doctor-fails-on-docker-and-the-sandbox-image).

`babel-harness run --help` lists `--execution-profile` with `dev_local` as one value. In the published package, `dev_local` is described as host inspection without Docker, with project test and build commands denied. That profile was not used for a live task in this pass.

## Build from a clone

```sh
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix ./babel-cli ci
npm --prefix ./babel-cli run build
node ./babel-cli/dist/index.js doctor
```

Contributor-only catalog preview, from the clone, with PowerShell:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode deep `
  -Format json
```

Compare that with [examples/manifest-previews/backend-deep.json](../examples/manifest-previews/backend-deep.json). This does not call a model. It was not re-run for the 2026-11-03 docs pass.

`advanced` on 0.2.0 also lists `mcp`, `models`, and `run`. Those were not started beyond `--help` / the `advanced` list.

## Further reading

- [Chat mode](./CHAT_MODE.md) — source description of the default loop. It mentions commands the 0.2.0 package does not install.
- [Command contract](./CLI_COMMAND_CONTRACT.md) — source grammar, same caveat.
- [Status](./STATUS.md)
