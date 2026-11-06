# Babel

[![npm](https://img.shields.io/npm/v/babel-harness)](https://www.npmjs.com/package/babel-harness)
[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions/workflows/typecheck.yml)

Babel is an **agent harness**. It runs on your computer, talks to a model you choose, and stands between that model and your repository. The model can propose a change. Babel is what decides which commands and file edits are allowed to happen, and it keeps a local record of the run.

It is for developers who want a coding agent in a project they already have, including Python and Java projects. You do not have to learn Babel's internals first.

Use it when you want the agent on your machine, with a provider you pick, and with project commands kept in a Docker sandbox by default instead of running straight on the host.

<!-- TODO: add a short Desktop demo video here once the recording exists. Do not link a file until it is in the repo. -->

## Try it

You need **Node.js 22.19.0 or newer on the 22 line, or Node.js 24.13.1 or newer on the 24 line**. Other major versions are rejected. Check before you install:

```sh
node --version
```

Then install the published package and run the commands that were checked against `babel-harness@0.2.0`:

```sh
npm install --global babel-harness@0.2.0
babel-harness --version
babel-harness --help
babel-harness doctor
babel-harness setup
```

The command name to use in these docs is `babel-harness`. The installer also adds `babel-agent`, which is the same program. Help text still says `babel` and `babel-agent`. There is no `babel` command on your PATH.

`doctor` exits 1 on a machine without Docker. That means the default sandbox is not ready. The install itself succeeded. `setup` prints a checklist. It does not ask you questions and it does not call a model.

Create a private env file and set **one** key. `setup` on 0.2.0 lists these names:

```sh
mkdir -p ~/.babel/config
```

```dotenv
# ~/.babel/config/.env
OPENROUTER_API_KEY=your-key
```

The same checklist also accepts `DEEPINFRA_API_KEY`, `DEEPSEEK_API_KEY`, `BABEL_OPENCODE_GO_API_KEY`, or `COMMAND_CODE_API_KEY`. Local Ollama does not use a cloud key. On macOS and Linux, make the file owner-only after you write it (`chmod 600 ~/.babel/config/.env`). A saved key is not proof that the provider accepts it.

From the repository you want to work in, this read-only command works with no key:

```sh
cd /path/to/your/repository
babel-harness context preview @file README.md --json
```

This is the smallest model task. Without a key it exits 1 and tells you which key is missing:

```sh
babel-harness "Explain this repository in one sentence. Do not change files."
```

More commands: [Start here](START_HERE.md), [CLI reference](docs/CLI_QUICKSTART.md), [Troubleshooting](docs/TROUBLESHOOTING.md).

## What to expect

Babel is pre-1.0. A green `doctor` line, a saved key, and a finished answer are three different things.

- `doctor` checks Node, the installed files, whether a key is present, Docker, and a sandbox image. It does not call the provider.
- The default execution profile is `safe_repo`. Project commands are meant to run in Docker. Without Docker and a usable image, `doctor` fails those two checks and does not switch to your host.
- `plan` prepares a plan and asks before it applies. `deep` is a heavier command for riskier work. Having the command does not make it more reliable than a normal task.
- Checks Babel runs are the checks it was given or could infer. They are not a guarantee for every task.
- Node may print `ExperimentalWarning` lines about SQLite and WebAssembly. On Node 22.23.4 those warnings showed up while `doctor`, `setup`, and `context preview` still ran. See [Troubleshooting](docs/TROUBLESHOOTING.md).

## How this is different

These are things you can see in this repo and in the published 0.2.0 package. They are not a benchmark against other tools.

- The agent runs locally. You bring the model account. Babel does not ship one.
- The instructions it loads are files in this repository: `prompt_catalog.yaml` and the numbered folders `00_` through `07_`. You can open them.
- Project commands use the `safe_repo` profile unless you choose another one. `doctor` fails closed when Docker or the sandbox image is missing.
- `babel-harness --help` shows separate `plan` and `deep` commands, plus a default task command.

## Desktop

Published Desktop builds are **Windows x64 only** (a Setup `.exe` and a portable `.zip`). [v0.2.0](https://github.com/gthgomez/Babel/releases/tag/v0.2.0) and [v0.1.3](https://github.com/gthgomez/Babel/releases/tag/v0.1.3) both include those files. Linux and macOS should use the npm CLI above.

The Windows installer is unsigned, and SmartScreen can warn. Setup steps for the v0.2.0 tag: [babel-desktop/docs/INSTALL-WINDOWS.md](https://github.com/gthgomez/Babel/blob/v0.2.0/babel-desktop/docs/INSTALL-WINDOWS.md).

## Providers and the sandbox

`babel-harness setup` on 0.2.0 tells you to set one of the five keys above, or to use Ollama. The package also contains ids for OpenAI, Anthropic, Gemini, Groq, OpenCode, and a generic OpenAI-compatible endpoint. In that package those ids are marked untested, and `setup` does not list their keys. The source tree on `main` has moved since 0.2.0, so a later install can differ. Trust `setup` on the version you installed.

Docker is required for the default `safe_repo` profile so project commands run in a container. There is no Babel image and no Dockerfile in this repo. Windows Desktop Setup pulls a pinned public Node image. The same pull is the non-Windows path, if you already have Docker:

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
