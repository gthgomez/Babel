# Project status

**Audience:** developers deciding whether to try Babel.  
**Updated:** 2026-11-03, from the published `babel-harness@0.2.0` package, the v0.2.0 GitHub release assets, and this checkout of `main`. This is not a scorecard.

Babel is **pre-1.0**. A command existing is not evidence that everyday repository work is already reliable.

## Available

- **npm package `babel-harness@0.2.0`.** `npm view babel-harness versions` on 2026-11-03 listed `0.0.0-stage`, `0.1.3`, and `0.2.0`. The package requires Node `^22.19.0 || ^24.13.1`.
- **Commands that ran** on that package: `--version`, `--help`, `doctor`, `setup`, `setup --json`, `context preview`, `models --help`, `plan --help`, `deep --help`, `undo --help`, and `advanced`. A quoted task with no key exited 1 and named the missing `OPENROUTER_API_KEY`.
- **Windows x64 Desktop downloads** on the [v0.2.0](https://github.com/gthgomez/Babel/releases/tag/v0.2.0) and [v0.1.3](https://github.com/gthgomez/Babel/releases/tag/v0.1.3) releases (Setup `.exe` and `.zip`). They were not installed in this pass.
- **Source build** of `babel-cli` (`npm --prefix ./babel-cli ci` and `run build`). The source tree is ahead of the 0.2.0 package: it registers `provider`, `settings`, and a `work` alias that the published package did not accept as commands.
- **Instruction stack** in this repo: `prompt_catalog.yaml` and the numbered layer folders.

Exact commands: [START_HERE.md](../START_HERE.md) and [CLI_QUICKSTART.md](./CLI_QUICKSTART.md).

## Narrowly checked

- The 0.2.0 package launches on Node 22.23.4 and refuses Node 20.20.2 after a successful install.
- `doctor` reports Node, bundled resources, credential presence, Docker, and the sandbox image. It does not call a provider. Without Docker it exits 1.
- `context preview` can read a file with no provider key.
- The public release gate workflow is `.github/workflows/typecheck.yml`. Whether it is green depends on the commit you are looking at. This page does not record a CI result.

## Environment-dependent

- **A provider key** has to be written into `~/.babel/config/.env` or the environment. `setup` on 0.2.0 does not collect it for you. The checklist names DeepInfra, DeepSeek, OpenCode Go, OpenRouter, Command Code, and local Ollama.
- **Docker plus an image** for the default `safe_repo` profile. There is no Babel image in this repo. Desktop Setup on Windows pulls a pinned `node:24-bookworm` image. That image is not a Python or Java toolchain.
- **`deep`** is a separate, heavier command. Route availability is not a reliability claim.

## Known limitations

- No macOS or Linux Desktop build is attached to the v0.2.0 or v0.1.3 releases.
- Help text says `babel` and `Babel Multi-Agent OS`. The installed names are `babel-harness` and `babel-agent`.
- Unknown words such as `settings show` are executed as tasks on 0.2.0.
- Node prints experimental SQLite and WebAssembly warnings during ordinary commands.
- Tag `v0.1.2` exists. Its GitHub release was still a draft on 2026-11-03, and `0.1.2` was not in the npm version list queried that day.

## Not claimed

- Parity with any other coding agent, or any benchmark score.
- That a saved key or a listed model means the provider accepted it.
- That verification covers every task.
- That `safe_repo` behaves the same on every host. The Docker pull in the docs was not executed in the pass that wrote this page.
- A stable 1.0 API.
- That ordinary coding-loop reliability is settled.

## Related

- [VISION.md](./VISION.md)
- [ROADMAP.md](./ROADMAP.md)
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- [CHANGELOG.md](../CHANGELOG.md)
