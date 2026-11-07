# Troubleshooting

Checked against published `babel-harness@0.2.0` on Linux, Node.js 22.23.4, with a separate Node.js 20.20.2 install. Docker was not installed on that machine (`docker` exited 127). No product code was changed to hide these results.

## Node 20 installs, then every command fails

`package.json` requires `^22.19.0 || ^24.13.1`. The launcher accepts Node 22 only when the minor version is at least 19, and Node 24 only from 24.13.1 up. Other major versions are rejected.

On Node 20.20.2:

- `npm install babel-harness@0.2.0` exits 0.
- npm prints `EBADENGINE` for `babel-harness@0.2.0` itself, and also for `log-update` and `slice-ansi`.
- `babel-harness --version` and `babel-harness doctor` each print `[babel-agent] Node ^22.19.0 or ^24.13.1 is required.` and exit 1.

Check `node --version` before you install. Use Node 22.19.0+ on the 22 line, or 24.13.1+ on the 24 line.

## The help text says `babel`, but that command does not exist

The package installs two names for one file: `babel-harness` and `babel-agent`.

On 0.2.0, `--help` starts with `Usage: babel-agent` and the title `Babel Multi-Agent OS`. Its examples use `babel`. `setup` tells you to run `babel-agent ...`. These docs use `babel-harness` and treat `babel-agent` as the alias.

`command -v babel` was empty after install. Typing `babel` will not start this project.

## `doctor` fails on Docker and the sandbox image

A failing `doctor` can still mean the CLI is installed. On a machine without Docker the 0.2.0 output was:

```text
ok: node
ok: resources
ok: provider or a warning that no key is selected
fail: docker — Docker server unavailable; safe_repo requires Docker. Start Docker before executing tasks; no fallback is enabled.
fail: sandbox_image — Sandbox image unavailable or unusable. In Desktop Setup prepare the recommended image or validate an existing image. CLI users configure BABEL_BENCHMARK_DOCKER_IMAGE; host fallback is not enabled.
```

`doctor` exited 1. It did not call a model.

Docker is how the default `safe_repo` profile runs project commands in a container. Read-only commands such as `context preview` can still run. A model task that needs tests or other project commands will not get those commands until Docker and an image are ready.

**Desktop Setup is a Windows app button.** It is not a command on Linux or macOS.

There is no Dockerfile in this repository and no image published under a Babel name. Desktop Setup pulls this public image (the pin in `babel-desktop/native/sandbox-setup.mjs` on the v0.2.0 tag and on current `main`):

```sh
docker pull --platform=linux/amd64 docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0
export BABEL_BENCHMARK_DOCKER_IMAGE=docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0
```

That pull was not executed here. After a pull, `doctor` still inspects the local image. It accepts a Linux amd64 image that can run `git --version` and a shell. The recommended image is a Node 24 Bookworm image. Python, Java, and other toolchains are not part of that check. Use an image that contains the tools your tests need, or those tests cannot run inside the sandbox.

The published package also has a `dev_local` execution profile. Its own description says host inspection commands can run without Docker, and that project test and build commands are denied without Docker. It is not a substitute for a Python or Java toolchain.

## Provider setup is a file you write

`babel-harness setup` on 0.2.0 prints a checklist and exits 0. It does not ask for a key. Create `~/.babel/config/.env` and set one of:

- `DEEPINFRA_API_KEY`
- `DEEPSEEK_API_KEY`
- `BABEL_OPENCODE_GO_API_KEY`
- `OPENROUTER_API_KEY`
- `COMMAND_CODE_API_KEY`

Or configure local Ollama, which `setup` describes as not needing a cloud key.

Without a key, this task exits 1:

```sh
babel-harness "Explain this repository in one sentence. Do not change files."
```

The message observed was: `[provider:openrouter] OPENROUTER_API_KEY is not set.` The default route looks for OpenRouter even if you meant to use a different provider. Put the key in the env file, or export the variable, and run the task again. Diagnostics do not send the key anywhere by themselves. A present key is still not proof of authentication.

On macOS and Linux the loader throws `Private credential file permissions are too broad` when `~/.babel/config/.env` is readable by group or others. `chmod 600` that file. That error was not reproduced in the docs pass; it is what `babel-cli/src/config/envBootstrap.ts` throws.

## Unknown words are treated as a task

On 0.2.0 these are real commands: `setup`, `doctor`, `interactive`, `plan`, `deep`, `undo`, `resume`, `context`, `models`, `advanced`, and a quoted task.

These are **not** commands in that package, even though current source and some older docs mention them: `work`, `provider`, and `settings`.

Observed:

- `babel-harness settings show` with no key exited 1 as a chat task: `Cannot start chat` because `OPENROUTER_API_KEY` is not set.
- `babel-harness provider --help` and `babel-harness work --help` printed `run` help and exited 0.
- With a provider credential already in the environment, `babel-harness provider status` was answered by the model as if it were a coding task. It did not print a provider status table.

Use `babel-harness --help` for the command list. Do not assume a word from a source doc exists in the installed package.

## ExperimentalWarning from Node

On Node 22.23.4, `doctor`, `setup`, and `context preview` printed:

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
ExperimentalWarning: Importing WebAssembly module instances is an experimental feature and might change at any time
```

The commands still completed (with `doctor` exiting 1 only because Docker was missing). The warnings come from Node, not from a failed Babel check. If the command also exits 1, read the Babel lines above the warning before treating the warning as the failure.

## Desktop

Published Desktop assets are Windows x64 Setup `.exe` and `.zip` files on the [v0.2.0](https://github.com/gthgomez/Babel/releases/tag/v0.2.0) and [v0.1.3](https://github.com/gthgomez/Babel/releases/tag/v0.1.3) releases. There is no macOS or Linux Desktop download. The installer is unsigned, and the Windows guide says SmartScreen will warn. Those installers were not run during this docs pass.
