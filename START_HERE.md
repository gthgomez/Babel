# Start here

This is the same first path as the [README](README.md): install the published npm package, check that the command runs, then point it at a repository. Babel Desktop for Windows is an alternative. Building from source is for people changing Babel.

The command name in this guide is `babel-harness`. `babel-agent` is the same program. Help text still prints `babel`, and that command is not installed.

## 1. Check Node, then install

Babel needs **Node.js 22.19.0+ on the 22 line, or 24.13.1+ on the 24 line**.

```sh
node --version
npm install --global babel-harness@0.2.0
babel-harness --version
babel-harness doctor
babel-harness setup
```

Those commands are the same in bash and PowerShell. On PowerShell you can also write them one per line without `&&`.

`--version` should print `0.2.0`. `doctor` exits 1 when Docker is missing. Read that as "the sandbox is not ready," not "the install failed." `setup` prints where to put a key. It does not prompt.

On Node 20 the install finishes with an `EBADENGINE` warning, and every command then prints `[babel-agent] Node ^22.19.0 or ^24.13.1 is required.` and exits 1. See [Troubleshooting](docs/TROUBLESHOOTING.md).

## 2. Add one provider key

```sh
mkdir -p ~/.babel/config
```

Put one line in `~/.babel/config/.env` (on Windows: `%USERPROFILE%\.babel\config\.env`):

```dotenv
OPENROUTER_API_KEY=your-key
```

`setup` on 0.2.0 also accepts `DEEPINFRA_API_KEY`, `DEEPSEEK_API_KEY`, `BABEL_OPENCODE_GO_API_KEY`, or `COMMAND_CODE_API_KEY`. Ollama is the local option and does not need one of those keys. Keep the file out of the repository. On macOS and Linux, run `chmod 600 ~/.babel/config/.env`. The loader rejects a private credential file with broader permissions.

A key in the file means the variable is set. It does not mean the provider accepted it.

## 3. Run it in your repository

```sh
cd /path/to/your/repository
babel-harness context preview @file README.md --json
babel-harness "Explain this repository in one sentence. Do not change files."
```

`context preview` reads a file and does not need a key. The sentence task exits 1 until a key is set. With a key, it calls the model. Check the printed target before you trust the answer. This is one request, not a reliability score.

`babel-harness plan "Describe a small safe change"` and `babel-harness deep "Make that change and run the project's tests"` are separate commands listed in `--help`. `deep` is not automatically safer or more reliable than the default task. Project tests need the sandbox in the next section, or they will not run under the default profile.

## 4. Docker, when you want project commands

The default profile is `safe_repo`. It runs project commands in Docker and does not fall back to the host. `doctor` fails `docker` and `sandbox_image` until both are ready.

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

If you are on Windows x64, you can skip npm and use Desktop instead. Download the Setup `.exe` or the portable `.zip` from the [v0.2.0 release](https://github.com/gthgomez/Babel/releases/tag/v0.2.0). Both are Windows x64 only. The installer is unsigned. Follow [the setup guide at that tag](https://github.com/gthgomez/Babel/blob/v0.2.0/babel-desktop/docs/INSTALL-WINDOWS.md).

There is no published macOS or Linux Desktop build. Use the npm steps above.

## Build from source

Use this when you are changing Babel, not for a first try:

```sh
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix ./babel-cli ci
npm --prefix ./babel-cli run build
node ./babel-cli/dist/index.js doctor
```

PowerShell uses `.\babel-cli` in those npm prefixes. The source tree can be ahead of `babel-harness@0.2.0`. Commands you see in source docs, including `work`, `provider`, and `settings`, were not in the 0.2.0 package.

## Where to go next

- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [CLI reference](docs/CLI_QUICKSTART.md)
- [Docs index](docs/README.md)
- [Status](docs/STATUS.md)
- [Contributing](CONTRIBUTING.md)
