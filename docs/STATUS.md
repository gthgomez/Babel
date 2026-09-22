# Project status

**Audience:** developers evaluating or trying Babel.  
**Updated:** 2026-09-19 (docs stewardship pass; derived from public README, START_HERE, and release notes — not a marketing scorecard).

Babel is **pre-1.0**. This page separates **what is present in the public tree** from **narrow, evidence-scoped verification**, and from what we are not claiming.

**Ordinary coding-loop reliability is still under active qualification.** A route or CLI command existing in the tree is not evidence that everyday repository work is already reliable.

## Available in the public tree

These surfaces are present in a current `main` checkout and documented for trial. **Availability means the entrypoint or artifact exists** — not that end-to-end coding reliability is established.

- **Local CLI build** path via `babel-cli` (`npm --prefix ./babel-cli ci` / `run build`).
- **Chat, plan, and deep modes** as CLI/TUI entrypoints (see START_HERE / CLI_QUICKSTART).
- **Doctor / environment checks** via `node ./babel-cli/dist/index.js doctor`.
- **Catalog and stack/manifest validation tooling**, including model-free preview paths documented in START_HERE / README.
- **Typed routing and runtime contracts** covered by the public release gate workflows.
- **Read-only MCP inspection** entrypoint for control-plane style inspection.
- **Public hygiene gates** — typecheck CI, scrub, and secret-scan tooling described in release docs.

Exact commands: [START_HERE.md](../START_HERE.md), [CLI_QUICKSTART.md](./CLI_QUICKSTART.md).

## Narrowly verified properties

These items have **scoped** public evidence (CI gates, documented validation scripts, or checked-in contracts). They are **not** a general reliability rating for agent coding sessions.

- The public checkout **builds and typechecks** under the Public Release Gate when that workflow is green on the commit you are evaluating.
- Catalog / stack validation and related release hygiene checks run as documented in the public tools and CI.
- The documented install path remains **clone + build** (no published npm package on the public docs path today).

## Environment-dependent / maturing

- **Provider-backed model sessions** — require local credentials and a working provider; quality varies by model.
- **Execution profiles** — default `safe_repo` expects Docker isolation and can fail-closed without it; `dev_local` runs approved tools on the host (use only on repos you own / code you reviewed).
- **Deep mode** — available as a higher-ceremony path intended for riskier work; still maturing. Route availability does **not** mean Deep is more reliable than chat for ordinary tasks.
- **TUI polish and recovery UX** — interactive TUI surfaces are present in the public tree; some recovery paths (including `undo` / checkpoints) remain CLI-first (see START_HERE).

## Active qualification (engineering; not user promises)

Public issues and draft PRs currently focus on **ordinary coding-loop reliability**, terminal truthfulness, and related harness hardening. Treat that work as **in progress**. Do not read mode or command availability as proof that the daily coding loop is already reliable.

## Known limitations

- **No published npm/npx package today** — install is clone + build.
- **No real TUI screenshot/recording in the README yet** — the landing example is labeled illustrative.
- **Not a zero-config cloud agent** — Babel is local; you bring providers and policy.
- **Pre-1.0 API/catalog surfaces may change**.

## Not currently claimed

Do not interpret Babel's docs or marketing-adjacent language as claiming:

- parity with any specific commercial coding agent;
- unrestricted autonomous operation without human-set permissions/policy;
- verification outcomes that hold for every task and environment without scoped evidence;
- sandbox behavior identical on every OS/host configuration;
- a stable 1.0 package API;
- that everyday coding-loop reliability is already settled.

## Related

- [VISION.md](./VISION.md) — product principles and public scope
- [ARCHITECTURE.md](./architecture/ARCHITECTURE.md) — deeper system shape
- [CHANGELOG.md](../CHANGELOG.md) — release history
