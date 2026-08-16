# Public Release Checklist

<!--
status: ACTIVE
last_verified: 2026-08-15
-->
Operational checklist derived from the [public content policy](./PUBLIC_REPO_CONTENT_POLICY.md).
The policy defines the rules; this checklist is the runbook. Run the checks below before
opening a public PR or cutting a release.

## 1. Content classification

For every file to be published, classify it:

| Class | Action |
|-------|--------|
| Safe as-is | `README.md`, `START_HERE.md`, public examples, release notes, generic layers/skills, non-environment-specific runtime code, public validation tooling |
| Needs generalization | Project/task overlays with environment specifics → convert to example deltas or omit; catalog entries referencing private IDs → generalize |
| Do not include | Credentials/secrets, personal notes, local machine paths, private project identifiers, package/bundle/product IDs, deployment URLs/endpoints, raw run telemetry, operational tuning tables |

## 2. Mandatory gates (run and confirm pass)

1. [ ] `pwsh tools/check-public-content-policy.ps1 -RepoRoot .` — content policy + markdown links
2. [ ] `pwsh tools/run-public-secret-scan.ps1 -RepoRoot . -Strict -RequireExternalScanner` — zero leaks
3. [ ] `pwsh tools/check-public-scrub.ps1 -RepoRoot . -Strict` — identifiers, paths, lockfile safety
4. [ ] `pwsh tools/validate-catalog.ps1` — catalog integrity (if catalog/routing touched)
5. [ ] `cd babel-cli && npx tsc --noEmit` — types (if CLI/tooling touched)
6. [ ] `pwsh tools/preflight-ratchet.ps1` — file-size budgets (if large files touched)
7. [ ] `pwsh tools/check-docs-integrity.ps1` — docs lifecycle, ADR index, links, authority refs

## 3. Clean-clone and portability proof

- [ ] A fresh clone of the public repo passes all validation **without** a parent workspace,
      sibling repos, or the maintainer's machine layout
- [ ] No absolute workstation paths anywhere in tracked content
- [ ] Public docs use relative links only
- [ ] Windows-first assumptions that remain are documented

## 4. Release/version discipline (see [RELEASE.md](./RELEASE.md))

- [ ] Version bumped per semver policy; breaking catalog/orchestrator/CLI changes = major
- [ ] Release notes/changelog describe changes, compatibility, and migration steps
- [ ] Annotated tag planned; consumers pin tag + commit SHA

## 5. Positioning and docs safety

- [ ] README says what Babel is **and** what it is not (vs prompt libraries, eval tools,
      prompt frameworks, agent orchestration frameworks)
- [ ] Docs teach only current CLI surfaces (chat / plan / deep / chat-headless / undo /
      resume / doctor) and the current runtime architecture
- [ ] Public docs describe what Babel does and does not do with data; examples avoid
      embedding secrets or private environment details

## 6. Public/private split

- [ ] Public core contains the framework (router, behavioral OS, domain architects, model
      adapters, generic skills, validator, examples)
- [ ] Private overlays, internal naming, workstation assumptions, and generated manifests
      stay out of the public repo
