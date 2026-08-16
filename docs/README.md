# Documentation

This directory contains the public documentation for Babel. It is organized so a new
contributor can find the current product story, the authority documents, and the history —
without confusing one for the other.

## Start Here

- [Vision](./VISION.md) — what Babel is and its product principles
- [CLI quick start](./CLI_QUICKSTART.md) — first commands, setup, and mode map
- [Chat mode](./CHAT_MODE.md) — the default daily coding-agent loop

## Current Product Contracts

- [CLI command contract](./CLI_COMMAND_CONTRACT.md) — canonical user-facing CLI semantics
- [Runtime modes](./architecture/RUNTIME_MODES.md) — runtime use vs instruction-only use, sessions, execution profiles

## Architecture

- [Architecture index](./architecture/README.md) — grouped map of all architecture docs
- [Harness architecture v1](./architecture/HARNESS_ARCHITECTURE_V1.md) — **normative** runtime harness specification (`harness-v1`)
- [Harness hardening roadmap v1](./architecture/HARNESS_HARDENING_ROADMAP_V1.md) — single implementation sequence under harness-v1
- [Harness overview](./architecture/HARNESS_OVERVIEW.md) — explanatory map (not normative)
- [Prompt OS architecture](./architecture/ARCHITECTURE.md) — layer model, catalog, routing

## Decisions

- [Architecture decision records](./adr/README.md) — every ADR (0001–013) with statuses

## Guides

- [Guides](./guides/) — operator status taxonomy, OTel local validation, TUI visual testing, portable workflow contract

## Release / Public Content

- [Release](./release/) — release policy, public content policy, release checklist, surface classification gate

## Status / Evidence

- [Status](./status/) — revision-bound audit chains (GPT-5.6 audit chain under `status/audits/`); live governance evidence and production proof are local-only by policy

## Historical Material

- [Archive](./archive/) — retired documents, preserved for history; archived content is not current authority

## Documentation Authority

| Document | Authority |
|----------|-----------|
| [HARNESS_ARCHITECTURE_V1.md](./architecture/HARNESS_ARCHITECTURE_V1.md) | **Normative** runtime harness (`harness-v1`) |
| [HARNESS_HARDENING_ROADMAP_V1.md](./architecture/HARNESS_HARDENING_ROADMAP_V1.md) | Implementation sequencing, subordinate to harness-v1 |
| [ARCHITECTURE.md](./architecture/ARCHITECTURE.md) + `prompt_catalog.yaml` | Prompt OS layer model, catalog, routing |
| [CLI_COMMAND_CONTRACT.md](./CLI_COMMAND_CONTRACT.md) | Canonical user-facing CLI contract |
| [ADR](./adr/) | Decision rationale (why), not permission to contradict newer decisions |
| `config/model-policy.json` | Mutable provider/model roster truth — docs never duplicate it |
| [PUBLIC_REPO_CONTENT_POLICY.md](./release/PUBLIC_REPO_CONTENT_POLICY.md) | Normative public-content policy |

Lifecycle statuses distinguish current material (`CANONICAL`, `ACTIVE`, `EXPERIMENTAL`)
from history (`HISTORICAL`, `SUPERSEDED` — retained in `archive/`). Historical material is
intentionally preserved and is **not** current product/runtime authority.

Active guidance must pass the public content, link, independence, and scrub checks before
release.
