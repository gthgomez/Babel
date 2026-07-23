# Changelog

## Unreleased

- (none yet)

## [0.1.0] — 2026-07-23

First public pre-1.0 release of the canonical Babel source at `gthgomez/Babel`.

### Added
- Canonical public source layout: prompt layers, `babel-cli`, catalog, docs, and validation tooling.
- Security gates: gitleaks + public scrub + content policy (including PCONT012 warning severity).
- Optional pre-commit hooks (`.githooks/`) with install script; CI remains authoritative.
- Branch and tag protection, secret scanning, and push protection for the public repository.
- Release policy stub (`docs/guides/RELEASE.md`).

### Notes
- Pre-1.0: public API and catalog surface are still stabilizing.
- Consumer pin of this release (e.g. product apps) is intentionally deferred until Babel is used more substantially in those products.
- Pin recommendation when ready: annotated tag `v0.1.0` **plus** the exact commit SHA of this release.

## Earlier unreleased work (folded into 0.1.0)

- Established `gthgomez/Babel` as the canonical public source; private repositories are consumers, not publishers.
- Added the canonical-source architecture decision and removed active documentation dependencies on a private parent workspace.
- Public changes use branch-and-PR review instead of reverse publication or direct `main` updates.
- Public CI validates the CLI on Windows and Ubuntu and runs the required secret scan.
- Release validation checks the canonical catalog and TypeScript surface.
- Public docs now include current-state and vision material for community onboarding.
- See `docs/release/releases/` for release notes and checklist material.
