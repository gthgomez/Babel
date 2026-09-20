# Documentation

**Canonical map** for Babel public docs. Prefer this index over hunting the tree.

Babel is a **local coding-agent harness**. Chat is the default daily lane; Plan and Deep add stronger gates. The Prompt OS is the inspectable instruction architecture underneath — useful, but **not** what you must learn before first success.

**Ordinary coding-loop reliability is still under active qualification.** Entrypoint availability is not a reliability claim. Maturity language belongs in [STATUS.md](./STATUS.md) when that page is present on your branch (stewardship PR [#230](https://github.com/gthgomez/Babel/pull/230)); until then, treat README / START_HERE caveats as authoritative.

---

## Product path (try Babel first)

| Doc | Role |
|---|---|
| [START_HERE.md](../START_HERE.md) | **Canonical first-success** — build, doctor, talk to Babel |
| [CLI_QUICKSTART.md](./CLI_QUICKSTART.md) | **Command reference** — chat / plan / deep / doctor / MCP (not a second install recipe home) |
| [CHAT_MODE.md](./CHAT_MODE.md) | Default daily runtime in depth |
| [VISION.md](./VISION.md) | Product principles and public scope |
| [ROADMAP.md](./ROADMAP.md) | Public NOW / NEXT / LATER (evidence-based; not shipped promises) |
| [STATUS.md](./STATUS.md) | Available vs narrowly verified vs active qualification (**via PR #230** if not on `main` yet) |

Root companions: [README.md](../README.md) (product front door), [CHANGELOG.md](../CHANGELOG.md).

## Using Babel (operations)

- [CLI command contract](./CLI_COMMAND_CONTRACT.md) — canonical verbs (`babel`, `plan`, `deep`, `undo`)
- [User-shaped CLI guide](./BABEL_USER_SHAPED_CLI_GUIDE.md) — work-lane-first CLI philosophy
- [TUI visual testing](./guides/BABEL_TUI_VISUAL_TESTING.md) — external Luna/computer-use contract

## Architecture (progressive disclosure)

Read these **after** you can start a session — or when integrating/contributing to the harness:

- [Architecture](./architecture/ARCHITECTURE.md) — Prompt OS layers, catalog, V9 pipeline
- [**Harness architecture v1**](./architecture/HARNESS_ARCHITECTURE_V1.md) — **normative** runtime harness specification (`harness-v1`)
- [Harness hardening roadmap v1](./architecture/HARNESS_HARDENING_ROADMAP_V1.md) — H0–H7 implementation sequence (internal engineering; not a public product promise list)
- [Harness overview](./architecture/HARNESS_OVERVIEW.md) — explanatory map (not normative)
- [Architecture index](./architecture/README.md) — all architecture guides
- [Model intelligence & qualification](./architecture/MODEL_INTELLIGENCE_QUALIFICATION_V1.md) — capability-aware profiles and campaign gates
- [Canonical source decision](./adr/ADR-0001-canonical-public-source.md) — repository authority

## Integrating / contributing

- [Integration guide](../INTEGRATION.md) — model-facing invocation contract
- [Autonomy policy](./AUTONOMY_POLICY.md) — autonomous engineering defaults and authority boundaries
- [Babel chat PR review](./BABEL_PR_REVIEW.md) — every-PR review guidance
- [Autonomy policy changelog](./AUTONOMY_POLICY_CHANGELOG.md) — policy refactor review record
- [Portable agent workflow plan](./guides/PORTABLE_AGENT_WORKFLOW_PLAN.md) — proposed cross-harness contract; subordinate to `harness-v1`
- [Agent Git operations](./guides/AGENT_GIT_OPERATIONS.md) — worktrees, exact-SHA PR gate, non-interactive `gh`
- [CONTRIBUTING.md](../CONTRIBUTING.md)

## Campaigns & stewardship

- Public stewardship tracker: [#231](https://github.com/gthgomez/Babel/issues/231)
- [ROOT_SAFETY_INVENTORY.md](./ROOT_SAFETY_INVENTORY.md) — read-only KEEP / DOCUMENT / ARCHIVE-candidate / DO-NOT-TOUCH matrix for root paths (**no runtime moves**)
- Campaign notes under [campaigns/](./campaigns/) — historical/engineering campaign records; not the product front door
- Internal roadmaps under [roadmaps/](./roadmaps/) — experimental/program notes; prefer [ROADMAP.md](./ROADMAP.md) for the public summary

## Maintainer / release

- Release and scrub docs under [release/](./release/)
- Specs, reconciliation, run-intelligence, and ADR trees support maintainers — link from architecture/campaigns as needed; do not dump on the front door

Active guidance must describe the canonical repository and pass the public content, link, independence, identity, and supplemental scrub checks before release.
