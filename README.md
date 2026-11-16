# Babel

[![npm](https://img.shields.io/npm/v/babel-harness)](https://www.npmjs.com/package/babel-harness)
[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions/workflows/typecheck.yml)

Babel is an **agent harness**. It runs on your computer, talks to a model you choose, and stands between that model and your repository. The model can propose a change. Babel is what decides which commands and file edits are allowed to happen, and it keeps a local record of the run.

It is for developers who want a coding agent in a project they already have, including Python and Java projects. You do not have to learn Babel's internals first.

Use it when you want the agent on your machine, with a provider you pick and an explicit execution profile for project commands.

<!-- TODO: add a short Desktop demo video here once the recording exists. Do not link a file until it is in the repo. -->

## Try it

You need **Node.js 22.19.0 or newer on the 22 line, or Node.js 24.13.1 or newer on the 24 line**. Other major versions are rejected. Check before you install:

```sh
node --version
```

Install the latest published package and start Babel from the repository you want to work in:

```sh
npm install --global babel-harness
babel-harness --version
cd /path/to/your/repository
babel-harness
```

The first-run flow below describes version 0.3.0 and later. Check the installed version: older published releases use different setup and provider options. Version 0.3.0 installs `babel`, `babel-agent`, and `babel-harness` as names for the same CLI.

The composer opens before provider setup. On your first task, choose OpenRouter or Command Code, connect a credential, and accept a suggested model or enter an exact model ID. A suggestion is unverified and may not be available to your account. Setup does not send an inference request. You can also run `babel-harness setup` before opening the workspace.

Start with a task such as:

```text
Explain this repository in one sentence. Do not change files.
```

Sending the task uses the provider and model you selected. A saved credential is not proof of authentication, model access, or a successful coding result. On later launches Babel restores the saved connection; saved conversations and drafts remain available in the workspace.

To inspect a file without a provider, run:

```sh
babel-harness context preview @file README.md --json
```

More commands: [Start here](START_HERE.md), [CLI reference](docs/CLI_QUICKSTART.md), [Troubleshooting](docs/TROUBLESHOOTING.md).

### Credentials and connection recovery

Desktop can store private credentials using operating-system protection. Standalone setup can save a masked key to the OS credential store, use a provider environment variable, or explicitly choose a plaintext private-profile file. Interactive sessions can also keep a key for that process only. Desktop's existing protected key stays private to Desktop until you explicitly choose **Share saved key with CLI**. On Linux the shared store requires Secret Service; on Windows it uses local-machine Credential Manager persistence. WSL uses its own Linux credential service.

Use `/setup` to repair a connection, `/provider` to switch a configured connection, and `/model` to select a model. `/model refresh` explicitly requests public provider model metadata without an inference request; cached and bundled choices remain unverified. A saved connection is shown as unverified; authentication, model availability, and successful coding are separate results. Repair never automatically replays a failed task. Headless jobs must select an explicitly environment-backed connection so they do not trigger a keychain unlock prompt. Optional spending limits and Plan/Deep remain available without being required during setup.

`BABEL_OFFLINE=1` (or `--offline` on commands that support it) blocks remote model transports, model-catalog refresh, connection checks, web context, voice WebSockets, and the guarded embedding and auxiliary model calls. Local model endpoints must use loopback; an external local service may have its own networking behavior. Offline mode is not an OS network sandbox for Babel or commands you authorize. Ambient `OPENAI_API_KEY` alone no longer enables paid embeddings: explicitly configure `BABEL_EMBEDDING_API_KEY`, or opt in with `BABEL_EMBEDDING_ENABLE=1` before using an OpenAI key.

## What to expect

Babel is pre-1.0. A green `doctor` line, a saved key, and a finished answer are three different things.

- `doctor` checks Node, the installed files, whether a key is present, Docker, and a sandbox image. It does not call the provider.
- Ordinary Chat defaults to `host_native`. Eligible project commands run with your OS user's authority; this is not an OS sandbox. Explicitly selecting `safe_repo` keeps the Docker boundary and fails closed without Docker and a usable image. Other workflows may use different profiles.
- `plan` prepares a plan and asks before it applies. `deep` is a heavier command for riskier work. Having the command does not make it more reliable than a normal task.
- Checks Babel runs are the checks it was given or could infer. They are not a guarantee for every task.
- Node may print `ExperimentalWarning` lines about SQLite and WebAssembly. On Node 22.23.4 those warnings showed up while `doctor`, `setup`, and `context preview` still ran. See [Troubleshooting](docs/TROUBLESHOOTING.md).

## How this is different

These are things you can inspect in the current source. They are not a benchmark against other tools.

- The agent runs locally. You bring the model account. Babel does not ship one.
- The instructions it loads are files in this repository: `prompt_catalog.yaml` and the numbered folders `00_` through `07_`. You can open them.
- Ordinary Chat uses the `host_native` profile unless you select another one. Selecting `safe_repo` fails closed when Docker or the sandbox image is missing.
- `babel-harness --help` shows separate `plan` and `deep` commands, plus a default task command.

## Desktop

See the [latest release](https://github.com/gthgomez/Babel/releases/latest) for available Desktop downloads. The source can build a Windows x64 Setup `.exe` and portable `.zip`, as well as a Linux x64 AppImage. The npm CLI is an alternative on Linux, macOS, Windows, and WSL.

The Windows installer is unsigned, and SmartScreen can warn. Setup steps for the v0.2.0 tag: [babel-desktop/docs/INSTALL-WINDOWS.md](https://github.com/gthgomez/Babel/blob/v0.2.0/babel-desktop/docs/INSTALL-WINDOWS.md).

## Providers and the sandbox

Babel's product connections use OpenRouter or Command Code with your own credentials. A ChatGPT or Claude subscription is not a Babel provider credential. Legacy adapters remain in the source for internal compatibility; they are not automatically selected as product connections.

Ordinary Chat does not require Docker. A containerized execution profile such as `safe_repo` requires Docker and a usable image. There is no Babel image and no Dockerfile in this repo. Windows Desktop Setup pulls a pinned public Node image. The same pull is the non-Windows path, if you already have Docker:

```sh
docker pull --platform=linux/amd64 docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0
export BABEL_BENCHMARK_DOCKER_IMAGE=docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0
```

That image is checked for a Linux amd64 OS, a shell, and Git. Desktop also checks Node and npm. It is not a Python or Java toolchain. A Python or Java project needs an image that already contains the tools its tests use. This pull was not run in the docs pass that wrote this page, because Docker was not installed there. Details: [Troubleshooting](docs/TROUBLESHOOTING.md).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Start here](START_HERE.md) | The same npm path, plus Desktop and a source build |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Node version, command names, Docker, keys, warnings |
| [CLI reference](docs/CLI_QUICKSTART.md) | Commands checked on 0.2.0 |
| [Docs index](docs/README.md) | Getting started, CLI, Desktop, architecture, contributing |
| [Project status](docs/STATUS.md) | What is in the tree and what is not claimed |
| [Contributing](CONTRIBUTING.md) | How to work on Babel |
| [Security](SECURITY.md) | How to report a vulnerability |

## License

Babel is licensed under [Apache-2.0](LICENSE). Tagged releases that shipped under MIT stay MIT for those snapshots. Report bugs in [GitHub Issues](https://github.com/gthgomez/Babel/issues).
