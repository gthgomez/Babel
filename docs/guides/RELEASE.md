# Babel Release Policy

<!--
status: ACTIVE
last_verified: 2026-07-22
-->

**This is a policy stub — intent, not automation.** The first canonical release
tag and automated release workflow are deferred to Option A Phase 4.

## Versioning

Babel follows [Semantic Versioning 2.0.0](https://semver.org/).

| Version component | What triggers a change |
|-------------------|----------------------|
| **Major** (`X.0.0`) | Breaking changes to the prompt catalog schema, orchestrator contract, or CLI public API |
| **Minor** (`0.X.0`) | New prompt layers, skills, domain architects, or CLI features (backward-compatible) |
| **Patch** (`0.0.X`) | Bug fixes, security patches, scrub/CI hardening, docs-only changes |

Pre-1.0 caveat: Semver rules apply but the public API surface is still
stabilizing. Breaking changes to `babel-cli/src/agentContracts.ts`, the V9
orchestrator input/output JSON contract, or the prompt catalog file format are
treated as major changes.

## Tags

- **Annotated tags only** (`git tag -a`). Lightweight tags are not used for
  releases.
- **Tag format**: `v<major>.<minor>.<patch>` (e.g. `v1.0.0`)
- **Signed tags**: deferred until a signing key is provisioned (post-1.0)
- **Pre-release tags**: `v<version>-<label>` (e.g. `v1.0.0-rc1`)

Pre-cutover rollback tag (`pre-option-a-cutover`) is protected by repository
ruleset alongside `v*` tags.

## Pinning

Consumers should pin Babel to an **annotated tag + exact commit SHA**:

```jsonc
// Consumer dependency manifest (example)
{
  "babel": {
    "tag": "v1.0.0",
    "sha": "abc123def456..."
  }
}
```

This prevents supply-chain ambiguity — the tag signals intent, the SHA locks
the exact content.

## Changelog

Release notes are published via [GitHub Releases](https://github.com/gthgomez/Babel/releases).
Each release entry describes:

- What changed (layer, component, or subsystem)
- Whether the change is backward-compatible
- Migration steps for breaking changes
- Updated prompt catalog version

The `CHANGELOG.md` at the repository root is a generated artifact produced from
GitHub Release notes at release time.

## Release Process (Future)

The following will be implemented as part of Option A Phase 4:

1. `tools/release.ps1` — automated script that:
   - Validates all CI gates (content policy, scrub, canonical independence, typecheck)
   - Bumps the version in `babel-cli/package.json` and `prompt_catalog.yaml`
   - Creates an annotated tag
   - Publishes a GitHub Release with generated changelog entry
2. CI release workflow — runs on tag push, publishes artifacts
3. Clean-clone proof — a fresh clone of `gthgomez/Babel` at the release tag
   passes all validation without a parent workspace or sibling repo

**First canonical release is gated on Option A Phase 4 acceptance:**
GPCGuard (or equivalent first consumer) pins the release tag + commit SHA in
its own private product repo and confirms it works.

## Security Releases

- Report vulnerabilities via [SECURITY.md](../../SECURITY.md)
- Security patches are released as patch versions on the current minor
- Critical patches may be backported to older minors at operator discretion
