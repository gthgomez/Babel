# Changelog

## Unreleased

- Established `gthgomez/Babel` as the canonical public source; private repositories are consumers, not publishers.
- Added the canonical-source architecture decision and removed active documentation dependencies on a private parent workspace.
- Public changes use branch-and-PR review instead of reverse publication or direct `main` updates.
- Public CI validates the CLI on Windows and Ubuntu and runs the required secret scan.
- Release validation checks the canonical catalog and TypeScript surface.
- Public docs now include current-state and vision material for community onboarding.
- See `docs/release/releases/` for release notes and checklist material.
