# Project status

**Audience:** developers evaluating or trying Babel.  
**Updated:** 2026-09-19 (docs stewardship pass; derived from public README, START_HERE, and release notes — not a marketing scorecard).

Babel is **pre-1.0**. This page separates what the public tree currently supports from what we are not claiming.

## Verified / working (public proof)

These are things a clone of `main` is expected to support when documented requirements are met:

- **Local CLI build** from this repository (`babel-cli` install + build).
- **Chat, plan, and deep routes** as product modes of the CLI/TUI.
- **Doctor / environment checks** via `node ./babel-cli/dist/index.js doctor`.
- **Deterministic catalog and stack/manifest validation** (including model-free preview paths documented in START_HERE / README).
- **Typed routing and runtime contracts** exercised by the public release gate.
- **Read-only MCP inspection** surface for control-plane style inspection.
- **Public hygiene gates** — typecheck CI, scrub, and secret-scan tooling described in release docs.

Exact commands: [START_HERE.md](../START_HERE.md), [CLI_QUICKSTART.md](./CLI_QUICKSTART.md).

## Experimental / environment-dependent

- **Provider-backed model sessions** — require local credentials and a working provider; quality varies by model.
- **Execution profiles** — default `safe_repo` expects Docker isolation and can fail-closed without it; `dev_local` runs approved tools on the host (use only on repos you own / code you reviewed).
- **Deep mode** — intended for higher-risk work with stricter controls; treat as maturing, not finished product surface.
- **TUI polish and recovery UX** — usable; some recovery paths are CLI-first (see START_HERE notes on `undo` / checkpoints).

## Known limitations (be honest with newcomers)

- **No published npm/npx package today** — install is clone + build.
- **No real TUI screenshot/recording in the README yet** — the landing example is labeled illustrative; capture runbook: [assets/README.md](./assets/README.md).
- **Not a zero-config cloud agent** — Babel is local; you bring providers and policy.
- **Pre-1.0 API/catalog surfaces may change**.

## In progress (engineering; not user promises)

Public issues and draft PRs currently emphasize ordinary coding-loop reliability, terminal truthfulness, and related harness hardening. Treat those as engineering workstreams, not as shipped features, until they land on `main` and are reflected here.

## Not currently claimed

Do not interpret Babel's docs or marketing-adjacent language as claiming:

- parity with any specific commercial coding agent;
- unrestricted autonomous operation without human-set permissions/policy;
- universal verification that always proves correctness;
- sandbox behavior identical on every OS/host configuration;
- a stable 1.0 package API.

## Related

- [VISION.md](./VISION.md) — product principles and public scope
- [ARCHITECTURE.md](./architecture/ARCHITECTURE.md) — deeper system shape
- [CHANGELOG.md](../CHANGELOG.md) — release history
