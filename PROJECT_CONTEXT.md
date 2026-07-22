<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# PROJECT_CONTEXT.md - Babel

## Repository Purpose

This repository is the canonical public source of Babel.

It contains the authoritative public product and can be used and verified on its
own:

- the layered prompt library
- the typed `v9` router contract
- the catalog-driven resolver/compiler
- a read-only MCP control-plane surface
- public overlays, examples, release tooling, and security gates

## Public Product Shape

This repo should be treated as a **runnable public-safe release surface**.

Canonical public success means a new user can:

1. install `babel-cli`
2. validate the catalog and public scrub rules
3. preview a resolved stack/manifest from the public catalog
4. compare the result to deterministic proof artifacts in the repo

The full multi-agent pipeline harness is present, typechecked, and available for experimentation. It remains an advanced surface because real task execution depends on local model setup, credentials, and target-repo rules.

## Public Vision

Babel should make AI-assisted software work less mysterious and less brittle.

The public repo exists so contributors can:

- inspect the prompt stack before execution
- validate the catalog and resolver deterministically
- reuse or fork prompt layers safely
- connect external clients through read-only MCP
- improve task execution behind explicit verification gates

The community direction is preview first, evidence next, execution last.

## Required Startup Order

1. Read `BABEL_BIBLE.md`
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
- **babel-cli:** Public runtime harness for resolver preview, read-only MCP, and advanced pipeline experimentation.

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

- `tools/validate-public-release.ps1`
- `tools/resolve-local-stack.ps1`
- `babel mcp`
- `examples/manifest-previews/*.json`

## Hot Paths

- `prompt_catalog.yaml`
- `00_System_Router/`
- `babel-cli/src/control-plane/`
- public onboarding docs
- public release tooling
- public CI and security scanning
