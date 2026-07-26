# Babel Public OSS Qualification — 2026-07-26

<!--
status: ACTIVE
last_verified: 2026-07-26
-->

## Verdict

**Qualified for active product development on `gthgomez/Babel`.**

The public repository is the independent canonical source (Option A). Vault→public
content sync for product surface is complete; remaining private-only material
(security/migration/archive bulk) stays out of public by design.

## Evidence

| Gate | Result |
| :--- | :--- |
| PR [#20](https://github.com/gthgomez/Babel/pull/20) | Merged 2026-07-26 (squash → `main` `a1a9cc7`) |
| CI run [30203373246](https://github.com/gthgomez/Babel/actions/runs/30203373246) | All required jobs green |
| `security` (scrub + gitleaks) | Pass |
| `public-content-policy` (+ independence) | Pass |
| `linux-validation` | Pass |
| `windows-portability` | Pass |
| Local re-scrub before merge | content-policy, scrub, independence, secret-scan (gitleaks 8.30.1), `tsc --noEmit` |

## What landed with qualification

1. **Agent infrastructure** — `AGENTS.md`, `.agents/rules/05`–`09`, three agent skills.
2. **OSS surface** — code of conduct, PR template, package metadata, SECURITY SLAs.
3. **Content hygiene** — private project name placeholders, model-flag ambiguity, vault path leaks, PCONT title collisions.

## Out of scope (intentionally deferred)

- Sanitized port of vault-only `tui-competitive-audit` / retrospective orchestrator
- Full `BABEL_BIBLE.md` enrichment from private history
- Semver bump beyond `0.1.0` / npm publish workflow
- Consumer product pin to a public tag + SHA

## Next product moves

1. Prefer feature work on `main` via short-lived branches in this repo.
2. Treat CI (security + content-policy + linux + windows) as merge-blocking for every PR.
3. Execute remaining document work from [status/README.md](./README.md) when not blocking product features.
