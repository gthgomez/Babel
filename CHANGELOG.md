# Changelog

Entries below are taken from git tags and GitHub release notes. They do not add changes that those notes do not list. The published npm versions queried on 2026-11-03 were `0.0.0-stage`, `0.1.3`, and `0.2.0`.

## [0.2.0] - 2026-10-30

GitHub release: [v0.2.0](https://github.com/gthgomez/Babel/releases/tag/v0.2.0). Compare: [v0.1.3...v0.2.0](https://github.com/gthgomez/Babel/compare/v0.1.3...v0.2.0).

### Published

- npm package `babel-harness@0.2.0` (package `engines.node` is `^22.19.0 || ^24.13.1`).
- GitHub release assets observed on that tag: Windows x64 `Babel-Desktop-Setup-0.2.0-win-x64.exe` (plus `.sha256` and `.build.json`), `Babel-Desktop-0.2.0-win-x64.zip`, `babel-harness-0.2.0.tgz`, `manifest.json`, and `SHA256SUMS`.

### Notes

- The release body is the list of pull requests merged since v0.1.3, from #376 through #471, ending with "chore(release): prepare Babel 0.2.0". This changelog does not restate that list.
- The Windows installer was not run while writing this entry.

## [0.1.3] - 2026-10-14

GitHub release: [Babel Desktop 0.1.3](https://github.com/gthgomez/Babel/releases/tag/v0.1.3).

### Published

- Windows x64 Desktop app for the Babel harness, bundling the CLI, prompt resources, production dependencies, and a Node runtime.
- Assets: Setup `.exe`, portable ZIP, CLI tarball, `manifest.json`, and `SHA256SUMS`.

### Notes from the release text

- Download `Babel-Desktop-Setup-0.1.3-win-x64.exe`, or use the ZIP. The installer and portable bundle are unsigned. The release notes tell you to verify Setup against its `.exe.sha256` file.
- Start Docker Desktop with Linux containers. Desktop Setup can prepare the recommended image or validate an existing local toolchain image.
- Open a project, select a provider, add its API key, enable models, and choose a default. API keys are stored in a private profile `.env` (plaintext), not an OS keychain.
- The release notes say Plan and Deep required OpenRouter in this version, and that other supported providers offered Chat.
- Custom project tools may require a custom sandbox image. Automatic Desktop updates are unavailable.
- The release notes also record the post-merge CI run, checksum checks, and installer checks that were done for that release. Those checks are not restated here as a general reliability claim.

## [0.1.2] - 2026-10-14

- Annotated tag `v0.1.2` exists. Compare: [v0.1.1...v0.1.2](https://github.com/gthgomez/Babel/compare/v0.1.1...v0.1.2).
- On 2026-11-03, `gh release view v0.1.2` showed a **draft** GitHub release titled "Babel v0.1.2", with Windows Desktop and `babel-harness` tarball assets attached to that draft.
- `0.1.2` was not in the npm version list queried the same day (`0.0.0-stage`, `0.1.3`, `0.2.0`).
- The draft notes list pull requests from #315 through #374. This changelog does not restate that list and does not treat the draft as a published GitHub Release.

## [0.1.1] - 2026-10-07


### Added
- Agent infrastructure for contributors and coding agents: root `AGENTS.md`, `.agents/rules/` (GitHub workflow, goal clearance, subagent delegation, visual variants, credential-read deny), and `.agents/skills/` (assemble-babel-stack, code-review, validate-control-plane).
- OSS surface polish: `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `.github/PULL_REQUEST_TEMPLATE.md`, `babel-cli/package.json` repository/license metadata, and SECURITY.md response SLAs.
- Coding-task success classifier (`codingTaskSuccess.ts`) so eval gates never treat EARLY_BLOCK_RICH / empty patch as pass (P0-E / HF-05).
- Shared ProviderMessage wire mapper + protocol validator (`providerMessages.ts`) for DeepSeek/DeepInfra native tool turns (P0-B).
- Per-submission TurnRuntime isolation refreshes task-class budgets/limits, clears exploration/stall leak, and records taskClass/gatePolicy on `turn_started` (P0-C).

### Fixed
- Public content hygiene: private project name placeholders in CLI/docs, ambiguous `-Model codex` examples → `-Model deepseek`, and CI failures from machine-specific paths / private-parent terminology / duplicate skill titles in agent skills.
- Windows pre-commit hook path normalization when Git reports POSIX-style repo roots.
- Faster foreground shell cancel: synchronous Windows process-tree kill and immediate abort settlement so chat/TUI cancel stays under the product budget (P0-A).
- Native tool turns seed the user task once into `providerConversation` (no per-turn user retransmit) and record `thinking_disabled_reason` when DeepSeek tools force thinking off.

## [0.1.0] — 2026-07-23

First public pre-1.0 release of the canonical Babel source at `gthgomez/Babel`.

### Added
- Canonical public source layout: prompt layers, `babel-cli`, catalog, docs, and validation tooling.
- Security gates: gitleaks + public scrub + content policy (including PCONT012 warning severity).
- Optional pre-commit hooks (`.githooks/`) with install script; CI remains authoritative.
- Branch and tag protection, secret scanning, and push protection for the public repository.
- Release policy stub (`docs/guides/RELEASE.md`).

### Notes
- Pre-1.0: public API and catalog surface are still stabilizing.
- Consumer pin of this release (e.g. product apps) is intentionally deferred until Babel is used more substantially in those products.
- Pin recommendation when ready: annotated tag `v0.1.0` **plus** the exact commit SHA of this release.

## Earlier unreleased work (folded into 0.1.0)

- Established `gthgomez/Babel` as the canonical public source; private repositories are consumers, not publishers.
- Added the canonical-source architecture decision and removed active documentation dependencies on a private parent workspace.
- Public changes use branch-and-PR review instead of reverse publication or direct `main` updates.
- Public CI validates the CLI on Windows and Ubuntu and runs the required secret scan.
- Release validation checks the canonical catalog and TypeScript surface.
- Public docs now include current-state and vision material for community onboarding.
- See `docs/release/releases/` for release notes and checklist material.
