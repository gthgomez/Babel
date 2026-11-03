# Changelog

## [Unreleased]

Changes on `main` after the npm `babel-harness@0.2.0` publish. A source build still reports `0.2.0` until the next version bump.

### Changed
- Default DeepSeek standard Chat routes to the current OpenRouter Flash model (#472).
- Unified first-run setup, provider routing and CLI workflows (#475).
- Repair-batch integration and conservative partial-write recovery (#476, #477).
- README rewritten for users, with reviewed offline CLI captures (#473, #474).

### Fixed
- Python post-edit syntax check no longer hardcodes `python`: it resolves `python3`/`python` (POSIX) or `py -3`/`python` (Windows), honours `BABEL_WORKSPACE_PYTHON`/`BABEL_PYTHON`, and reports `static_check_unavailable` instead of a false `exit_code: 1` when no interpreter exists, so correct `.py` edits are not sent into repair loops.
- `glob` found 0 matches for real files whose name ends in `.` (ripgrep globset quirk); trailing literal dots are now matched exactly.
- Lint-flagged code defects: unsafe optional call in the repo-map tokenizer loader, a useless re-throw, an expression-statement ternary, a silent cleanup catch, and a never-assigned `context_error` local in chat stack compilation.

## [0.2.0] - 2026-10-29

Highlights (full list in the [v0.2.0 release notes](https://github.com/gthgomez/Babel/releases/tag/v0.2.0)):

### Added
- Remote pairing UI, admin boundary, control leases and shared Desktop controller ownership (#391, #393).
- Own-CLI ACP harness adapters for Command Code, OpenCode and Claude Code (#397, #400, #402).

### Fixed
- Chat/coding-loop correctness: multi-file patch rollback reporting, task-owned edits across governed writes, context/compaction recovery, cancellation journal parity, verifier evidence and post-write repair budget (#376, #381, #384–#388, #392, #394, #395, #398, #399, #410, #414).
- CLI install warnings removed (#378); check latency and repeated agent work reduced (#418, #419).

## [0.1.3] - 2026-10-14

### Added
- Babel Desktop 0.1.3 for Windows x64 (unsigned installer and portable ZIP bundling the CLI) with desktop workflow and sandbox readiness fixes (#374, #375).
- `babel-harness@0.1.3` published to npm.


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
