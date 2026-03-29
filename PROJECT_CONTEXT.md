<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# PROJECT_CONTEXT.md - Babel-public

## Repository Purpose

`Babel-public` is the public-facing, sanitized export of Babel.

It packages a public-safe subset that can be used and verified on its own:

- the layered prompt library
- the typed `v9` router contract
- the catalog-driven resolver/compiler
- a read-only MCP control-plane surface
- public overlays, examples, and release tooling

## Public Product Shape

This repo should be treated as a **runnable public-safe control-plane subset**.

Canonical public success means a new user can:

1. install `babel-cli`
2. validate the catalog and public scrub rules
3. preview a resolved stack/manifest from the public catalog
4. compare the result to deterministic proof artifacts in the repo

The full multi-agent pipeline harness is present but is an advanced surface, not the primary public claim.

## Required Startup Order

1. Read `BABEL_BIBLE.md`
2. Read `PROJECT_CONTEXT.md`
3. Read `README.md`
4. Read `prompt_catalog.yaml`

## System Topology

- **00_System_Router:** `OLS-v9-Orchestrator.md` is the public default typed lane. `OLS-v8-Orchestrator.md` remains compatibility-only.
- **01_Behavioral_OS:** Universal execution behavior and evidence discipline.
- **02_Domain_Architects:** Primary technical strategy shells including backend, frontend, and Android/mobile.
- **02_Skills:** Reusable technical rules loaded by the resolver.
- **03_Model_Adapters:** Model-specific delivery shaping.
- **04_Meta_Tools:** Catalog/governance and MCP adapter docs.
- **05_Project_Overlays:** Public example overlays only.
- **06_Task_Overlays:** Public reusable task overlays and public example deltas.
- **babel-cli:** Public runtime harness for resolver preview, read-only MCP, and advanced pipeline experimentation.

## Key Contracts

- **Registry Contract:** `prompt_catalog.yaml` is the canonical registry for routable assets.
- **Router Contract:** `OLS-v9-Orchestrator.md` defines the public typed lane.
- **Compiler Contract:** the public resolver expands domain default skills, expands skill dependencies, checks conflicts, and emits the ordered manifest preview.
- **Behavioral Contract:** all assembled stacks include `01_Behavioral_OS`.
- **Public Safety Contract:** `docs/PUBLIC_REPO_SANITIZATION_RULES.md` and `tools/check-public-scrub.ps1` define the public boundary gate.

## First-Success Surfaces

- `tools/validate-public-release.ps1`
- `tools/resolve-local-stack.ps1`
- `babel-cli/scripts/preview_manifest.ts`
- `babel mcp`
- `examples/manifest-previews/*.json`

## Hot Paths

- `prompt_catalog.yaml`
- `00_System_Router/`
- `babel-cli/src/control-plane/`
- public onboarding docs
- public release tooling
