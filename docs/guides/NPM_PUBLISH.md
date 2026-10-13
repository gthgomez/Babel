# npm publication checklist (maintainer)

<!--
status: ACTIVE
last_verified: 2026-10-13
-->

This checklist records owner actions required before `babel-harness` can be published from a qualified source commit. Repository automation prepares candidates; it does not register package names, configure trusted publishers, or publish without explicit authorization.

## Preconditions

1. **Package name ownership** — Confirm the `babel-harness` name (or an approved scoped alternative) is owned on npmjs.com by the release operator.
2. **Trusted publisher binding** — Configure npm trusted publishing for repository `gthgomez/Babel`, workflow filename `publish-npm.yml` (not the full `.github/workflows/` path), package `babel-harness`, with environment left blank (see workflow header). The owner binding must allow direct `npm publish`, which this workflow uses; a staged-publish-only binding cannot authorize it. OIDC requires `id-token: write`; do not commit long-lived `NPM_TOKEN` values.
3. **Qualified immutable candidate** — The frozen release source commit must have a successful `typecheck.yml` `consumer-candidate` producer and green nine-row `consumer-artifact` matrix. Publication promotes that exact tarball; it does not rebuild on the publish runner.
4. **Version identity** — Annotated tag `vMAJOR.MINOR.PATCH` must match `babel-cli/package.json` and the candidate manifest version.
5. **Authorization** — Obtain explicit owner approval for the release tag, GitHub release publication, and npm publish (dry run first).

## Publisher client

[The npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/) requires npm CLI 11.5.1 or later and Node 22.14.0 or later (verified 2026-10-13). The publisher pins Node 24.13.1, whose bundled npm is 11.8.0, and checks compatibility before promoting the archive. The qualified immutable consumer producer stays on Node 22.19.0 (bundled npm 10.9.3); it prepares bytes and does not authenticate an npm publication. A dry run omits publication and cannot prove OIDC authentication.

## Dry run

1. Dispatch `publish-npm.yml` with `dry_run: true` against the intended `v*` tag.
2. Confirm logs report the selected candidate archive name and SHA-256 from the qualified consumer artifact.
3. Confirm no `npm publish` occurred.

## Post-publish verification

1. `npm view babel-harness@<version> version dist.integrity` matches the promoted candidate integrity.
2. Attach release evidence (source SHA, candidate digest, workflow run ids) to the GitHub release notes.

## Out of scope for agents

Registering names, creating npm tokens, configuring OIDC on npmjs.com, or running live paid provider evaluations remain human/owner operations.
