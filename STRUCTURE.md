# Repository Structure

Babel is a local terminal coding agent and coding-agent harness: chat-first daily work by default, with a review-first plan lane and governed deep execution. It is organized around an inspectable prompt operating system — the underlying instruction architecture — plus a local CLI and public validation lane.

This tree is the canonical public source. A clean clone must contain every file
required by the startup chain and validation path; external consumer configuration
is optional and must not become a repository prerequisite.

- `AGENTS.md` - agent identity, values, and startup for coding agents
- `.agents/` - contributor agent rules (`rules/05`–`09`) and skills
- `00_System_Router/` - runtime contracts and the live v9 orchestrator
- `01_Behavioral_OS/` - behavioral rules shared by prompt stacks
- `02_Domain_Architects/` - domain routing shells
- `02_Skills/` - reusable task skills
- `03_Model_Adapters/` - model-specific operating guidance
- `04_Meta_Tools/` - prompt maintenance and evolution assets
- `05_Project_Overlays/` - public example project overlays
- `06_Task_Overlays/` - task-specific reusable overlays
- `babel-cli/` - Node.js CLI runtime
- `docs/` - public documentation
- `examples/` - public examples and manifest previews
- `tools/` - validation and local helper scripts
- `.githooks/` - optional local pre-commit leak/path guards (CI is authoritative)
- `CODE_OF_CONDUCT.md` - community standards

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
