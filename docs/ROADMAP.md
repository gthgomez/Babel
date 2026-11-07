# Public roadmap

**Audience:** developers evaluating Babel, and contributors looking for priorities.  
**Updated:** 2026-11-03 from the public tree and the `babel-harness@0.2.0` package. This is not a delivery schedule.

Buckets match [STATUS.md](./STATUS.md):

- **Available** — the entrypoint or file exists.
- **Narrowly checked** — a specific command or script was run, or a release asset was listed.
- **Not a promise** — work that is not done, including things this docs pass only reported.

Ordinary coding reliability is still not something this page claims.

## Now

| Topic | What is true today |
| --- | --- |
| **Install** | `npm install --global babel-harness@0.2.0` is the first path. Node 22.19+ (22.x) or 24.13.1+ (24.x) is required. Node 20 installs the tarball and then the command exits 1. |
| **First command** | `doctor`, `setup`, and `context preview` run. A model task needs a key you create yourself. `doctor` fails closed without Docker. |
| **Desktop** | Windows x64 installer and zip on the v0.2.0 and v0.1.3 releases. No Linux or macOS Desktop asset. |
| **Docs** | README, Start here, and the CLI reference agree on `babel-harness` and the npm path. |

## Next

These are gaps found while writing the docs. They are not scheduled.

1. **Command text.** `--help` still says `babel` and `Babel Multi-Agent OS`. `setup` says `babel-agent`. Unknown words are run as tasks.
2. **Sandbox for CLI users.** Windows Desktop Setup pulls the pinned Node image. The CLI does not. Linux and macOS users have to pull an image themselves. That image does not include Python or Java toolchains.
3. **Package versus source.** `main` has `provider`, `settings`, and `work`. `babel-harness@0.2.0` does not. The next published package should match the docs, or the docs should keep saying which version they mean.
4. **A real task recording.** The README has a marked spot for a Desktop demo. None is linked, because no recording was added in this pass.

## Later

- Desktop builds for systems other than Windows x64, if and when they exist.
- Moving runtime folders (`00_`–`07_`, `prompt_catalog.yaml`, `LLM_COLLABORATION_SYSTEM/`, root `PROJECT_CONTEXT.md`). They stayed put because the catalog, discovery, or identity checks still use those paths. See [STRUCTURE.md](../STRUCTURE.md).

Internal architecture notes stay under [architecture/](./architecture/). They are not this list.

## How to read this page

- Try Babel: [START_HERE.md](../START_HERE.md)
- What went wrong in a real install: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- Maturity: [STATUS.md](./STATUS.md)
- Docs map: [docs index](./README.md)
