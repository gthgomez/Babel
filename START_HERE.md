# Start here

This is the same first path as the [README](README.md): install the published npm package, check that the command runs, then point it at a repository. Babel Desktop for Windows is an alternative. Building from source is for people changing Babel.

The command name in this guide is `babel-harness`. Version 0.3.0 also installs `babel` and `babel-agent` as names for the same program. This guide describes 0.3.0 and later; older releases use different setup and provider options.

## 1. Check Node, then install

Babel needs **Node.js 22.19.0+ on the 22 line, or 24.13.1+ on the 24 line**.

```sh
node --version
npm install --global babel-harness
babel-harness --version
```

Those commands are the same in bash and PowerShell. On PowerShell you can also write them one per line without `&&`.

Check the version before following this guide. `npm install` selects the latest published package, which may be older than the current source.

Other Node major versions are unsupported. See [Troubleshooting](docs/TROUBLESHOOTING.md).

## 2. Start and connect a provider

```sh
cd /path/to/your/repository
babel-harness
```

The composer opens first. Submit a task and choose OpenRouter or Command Code when prompted. Connect your own credential, then accept a suggested model or enter an exact model ID. You can also run `babel-harness setup` before opening the workspace. Setup does not send an inference request.

Private credentials can use OS-protected storage when available, a provider environment variable, or an explicitly chosen private-profile file. A saved key and model are unverified until the provider accepts a request. Linux shared credentials require Secret Service; WSL uses its own Linux credential service.

## 3. Run it in your repository

```text
Explain this repository in one sentence. Do not change files.
```

Sending the task uses the selected provider and model. Review the result against the repository. A successful connection or a single answer does not establish overall task reliability.

Use `/setup` to repair a connection, `/provider` to switch connections, and `/model` to select a model. `/model refresh` explicitly requests public model metadata without inference. A failed task is not automatically replayed after repair. `plan` and `deep` remain optional workflows.

## 4. Choose an execution boundary

Ordinary Chat defaults to `host_native`: eligible project commands run with your OS user's authority, not in an OS sandbox. Docker is not required for that profile. Selecting `safe_repo` uses a Docker sandbox and fails closed when Docker or the configured image is unavailable. Other workflows may use different profiles.

There is no Babel-published image. Windows Desktop can prepare one. On any machine with Docker, this is the same public image Desktop pulls:

```sh
docker pull --platform=linux/amd64 docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0
export BABEL_BENCHMARK_DOCKER_IMAGE=docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0
babel-harness doctor
```

PowerShell:

```powershell
$env:BABEL_BENCHMARK_DOCKER_IMAGE = 'docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0'
```

That image has a shell, Git, and Node. It does not have a Python or Java toolchain. If your tests need those, use an image that contains them and set `BABEL_BENCHMARK_DOCKER_IMAGE` to that image. `doctor` then checks that the image is local, Linux amd64, and can run Git and a shell.

## Windows Desktop

If you are on Windows x64, you can skip npm and use Desktop instead. Download a Setup `.exe` or portable `.zip` from the [latest release](https://github.com/gthgomez/Babel/releases/latest). The current installer is unsigned; follow the installation guide included with the selected release.

See the release page for available platform builds. The npm CLI is an alternative on Linux, macOS, and WSL.

## Build from source

Use this when you are changing Babel, not for a first try:

```sh
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix ./babel-cli ci
npm --prefix ./babel-cli run build
node ./babel-cli/dist/index.js doctor
```

PowerShell uses `.\babel-cli` in those npm prefixes. The source tree can be ahead of the published package. To exercise the exact repository build, pack it and install the archive into a clean directory:

```sh
npm --prefix ./babel-cli pack --pack-destination ./artifacts
npm install --prefix /tmp/babel-consumer --omit=dev ./artifacts/babel-harness-0.3.0.tgz
/tmp/babel-consumer/node_modules/.bin/babel-harness --version
/tmp/babel-consumer/node_modules/.bin/babel --help
```

## Where to go next

- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [CLI reference](docs/CLI_QUICKSTART.md)
- [Docs index](docs/README.md)
- [Status](docs/STATUS.md)
- [Contributing](CONTRIBUTING.md)
