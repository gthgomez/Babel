<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# PROJECT_CONTEXT.md - Babel

## Repository Purpose

This repository is the canonical public source of Babel.

It contains the authoritative public product and can be used and verified on its
own:

- a runnable local coding-agent CLI with an interactive TUI (chat, plan, and deep modes)
- the layered prompt library and typed `v9` router contract behind those modes
- the catalog-driven resolver/compiler
- a read-only MCP control-plane surface
- public overlays, examples, release tooling, and security gates

## Public Product Shape

This repo should be treated as a **runnable public-safe release surface**.

Canonical public success means a new user can:

1. build `babel-cli` and start the interactive TUI (`node .\babel-cli\dist\index.js interactive`)
2. send a chat task and watch Babel inspect the repository, edit files with permission, and verify the result
3. move to `plan` or `deep` when the task needs stronger gates
4. validate the catalog and preview a resolved stack/manifest without an API key

Model-backed sessions depend on local provider setup and credentials; the catalog, resolver, and MCP inspection surfaces are fully usable without them.

## Public Vision

Babel should make AI-assisted software work less mysterious and less brittle.

The public repo exists so contributors can:

- inspect the prompt stack before execution
- validate the catalog and resolver deterministically
- reuse or fork prompt layers safely
- connect external clients through read-only MCP
- improve task execution behind explicit verification gates

The public product direction is a usable coding-agent loop first, with
inspectable stack preview, evidence, and governed execution as supporting
harness surfaces. Technical flows may still inspect a resolved stack before
governed execution; that is a control-plane invariant, not the product
category.

## Required Startup Order

1. Read `INTEGRATION.md`
2. Read `PROJECT_CONTEXT.md`
3. Read `README.md`
4. Read `prompt_catalog.yaml`

Consumer repositories may provide optional repo-local rules or project overlays.
Those files are external inputs, not prerequisites for understanding, validating,
or building a clean Babel clone.

## System Topology

- **00_System_Router:** `OLS-v9-Orchestrator.md` is the public default typed lane. `OLS-v8-Orchestrator.md` is retained for historical context only and is not part of the active runtime.
- **01_Behavioral_OS:** Universal execution behavior and evidence discipline.
- **02_Domain_Architects:** Primary technical strategy shells including backend, frontend, and Android/mobile.
- **02_Skills:** Reusable technical rules loaded by the resolver.
- **03_Model_Adapters:** Model-specific delivery shaping.
- **04_Meta_Tools:** Catalog/governance and MCP adapter docs.
- **05_Project_Overlays:** Public example overlays only.
- **06_Task_Overlays:** Public reusable task overlays and public example deltas.
- **babel-cli:** Public runtime harness for the interactive coding agent (chat, plan, deep), resolver preview, read-only MCP, and governed pipeline execution.
- **AGENTS.md / `.agents/`:** Public agent identity, goal-clearance and GitHub workflow rules, and repo-local skills for stack assembly, code review, and control-plane validation.

## Key Contracts

- **Registry Contract:** `prompt_catalog.yaml` is the canonical registry for routable assets.
- **Router Contract:** `OLS-v9-Orchestrator.md` defines the public typed lane.
- **Compiler Contract:** the public resolver expands domain default skills, expands skill dependencies, checks conflicts, and emits the ordered manifest preview.
- **Behavioral Contract:** all assembled stacks include `01_Behavioral_OS`.
- **Release Contract:** `tools/validate-public-release.ps1` is the public integrity gate for this repo.
- **Security Contract:** `tools/run-public-secret-scan.ps1` and `tools/check-public-scrub.ps1` detect credentials and prohibited private identifiers.
- **Public Content Contract:** `tools/check-public-content-policy.ps1` rejects personal-profile content, private paths, unsupported absolute claims, broken links, duplicate active documents, and placeholders.
- **Canonical Independence Contract:** `tools/check-canonical-independence.ps1` verifies that a clean clone has all mandatory startup references and no required parent-workspace, sibling-repository, or removed-export dependencies.
- Maintainer release validation supplies the private supplemental scrub policy outside this repository and passes `-RequireSupplementalPolicy` so missing or empty configuration fails closed.
- **Source Authority Contract:** `docs/adr/ADR-0001-canonical-public-source.md` records this repository as the sole canonical source. Private repositories consume versioned releases and must not publish source back into this repository.

## First-Success Surfaces

- `babel-cli` interactive TUI (`node .\babel-cli\dist\index.js interactive`)
- `babel doctor` environment health check
- `tools/validate-public-release.ps1`
- `tools/resolve-local-stack.ps1`
- `babel mcp`
- `examples/manifest-previews/*.json`

## Hot Paths

- `prompt_catalog.yaml`
- `00_System_Router/`
- `babel-cli/src/control-plane/`
- `AGENTS.md` and `.agents/rules/` / `.agents/skills/`
- public onboarding docs
- public release tooling
- public CI and security scanning
