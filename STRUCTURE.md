# Repository Structure

Babel is a local terminal coding agent and coding-agent harness: chat-first daily work by default, with a review-first plan lane and governed deep execution. It is organized around an inspectable prompt operating system — the underlying instruction architecture — plus a local CLI and public validation lane.

This tree is the canonical public source. A clean clone must contain every file
required by the startup chain and validation path; external consumer configuration
is optional and must not become a repository prerequisite.

## Startup chain and agent rules

- `AGENTS.md` - agent identity, values, and startup for coding agents
- `CLAUDE.md` - project invariants, high-risk zones, special rules, common task paths
- `ENGINEERING.md` - coding standards agents follow
- `PROJECT_CONTEXT.md` - system topology, contracts, and runtime state
- `START_HERE.md` - first deterministic success path
- `INTEGRATION.md` - Babel invocation sequence for control-plane work
- `.agents/` - contributor agent rules (`rules/05`–`09`) and skills

## Prompt operating system

- `00_System_Router/` - runtime contracts and the live v9 orchestrator
- `01_Behavioral_OS/` - behavioral rules shared by prompt stacks
- `02_Domain_Architects/` - domain routing shells
- `02_Skills/` - reusable task skills
- `03_Model_Adapters/` - model-specific operating guidance
- `04_Meta_Tools/` - prompt maintenance and evolution assets
- `05_Project_Overlays/` - public example project overlays
- `06_Task_Overlays/` - task-specific reusable overlays
- `07_Pipeline_Stages/` - pipeline stage prompts (CLI executor, QA/adversarial reviewer, TUI deep auditor)
- `prompt_catalog.yaml` - machine-readable layer catalog consumed by the resolver/compiler
- `prompts/` - standalone prompt definitions
- `LLM_COLLABORATION_SYSTEM/` - collaboration rules (`RULES_CORE`, `RULES_GUARD`) and human/LLM reading guide

## Runtime, code, and validation

- `babel-cli/` - Node.js CLI runtime (has its own `AGENTS.md` and `PROJECT_CONTEXT.md` router)
- `scripts/` - agent git/PR gate helpers, evidence receipts, and trust-root ceremony scripts
- `skills/` - installable agent skills
- `tests/` - test suites
- `benchmarks/` - datasets, fixtures, schemas, and baselines (`PROVENANCE.json` records provenance)
- `config/` - repository configuration
- `docs/` - public documentation (`VISION`, `CLI_QUICKSTART`, `AUTONOMY_POLICY`, `CLI_COMMAND_CONTRACT`, `adr/`, `architecture/`, `benchmarks/`)
- `examples/` - public examples and manifest previews
- `tools/` - validation and local helper scripts
- `.githooks/` - optional local pre-commit leak/path guards (CI is authoritative)

## Governance and community

- `CHANGELOG.md` - release history
- `REGRESSION_LEDGER.md` - known-regression tracking
- `SECURITY.md` - security policy
- `CONTRIBUTING.md` - contribution guide
- `CODE_OF_CONDUCT.md` - community standards
- `LICENSE` - Apache-2.0
- `.github/workflows/` - CI (`typecheck`, `trusted-control-plane`, `public-pr-metadata`)

Most new users should read these first:

- `README.md` - public overview and current state
- `START_HERE.md` - first deterministic success path
- `AGENTS.md` - how coding agents should operate in this repo
- `docs/VISION.md` - product direction and contribution priorities
- `docs/CLI_QUICKSTART.md` - copy-paste CLI commands

Release and safety tooling lives in `tools/`:

- `validate-public-release.ps1` - public integrity gate
- `check-public-scrub.ps1` - private fingerprint and secret-pattern scrub check
- `run-public-secret-scan.ps1` - local scrub plus pinned external scanner support
- `resolve-local-stack.ps1` - deterministic stack/manifest preview
