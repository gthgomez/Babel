# Babel Release Policy

<!--
status: ACTIVE
last_verified: 2026-10-07
-->

The first public pre-1.0 tag is
[**v0.1.0**](https://github.com/gthgomez/Babel/releases/tag/v0.1.0). Automated
release workflows build draft portable releases and publish npm packages;
tagging and distribution authorization remain separate operator actions.

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

## Release identity and qualification

The release workflows resolve the exact annotated `refs/tags/<tag>` object
using read-only code from the workflow revision before executing project
lifecycle code. A branch-only input, branch/tag collision, lightweight tag,
malformed version or unavailable API fails qualification. Checkout uses the
frozen peeled commit with persisted credentials disabled. Package version and
source commit must match that identity before installation, and the tag object
and source are checked again immediately before promotion.

Automated qualification currently accepts stable `vMAJOR.MINOR.PATCH` only.
The broader prerelease tag policy above does not select npm dist-tags or make
a preview build a stable release. Preview channel support and source-release
eligibility enforcement remain explicit owner decisions; this campaign does
not change rulesets, protected environments, permissions or publishing access.

`npm --prefix babel-cli run package:release -- <output-directory>` is the
common clean-source path for consumer CI, npm dry runs and real publication.
It validates source provenance and installed-dependency consistency, checks the
reviewed advisory snapshot, builds once, stages runtime assets and packs once
with lifecycle scripts disabled. It compares every archive member to the
validated distribution bytes, including ignored `dist/` files, and records
source SHA, source tree SHA, package version, SHA256, SHA512 integrity, the
package file manifest, an advertised-payload inventory (bin aliases, required
runtime assets, core/optional classes and test-only exclusion) and the advisory
review digest.

`npm run check:advisories` fails when `babel-cli/package-lock.json` no longer
matches `config/dependency-advisory-review.json`; a `remediated` entry must
install a version outside its recorded ranges, and a `deferred` or
`accepted_risk` entry blocks only the artifact scopes it names. The recorded
Electron advisory currently blocks Desktop artifacts, not the npm tarball.

Publication promotes the **same immutable `consumer-candidate` archive** that passed the nine-row matrix for the frozen source commit. The `publish-npm.yml` workflow downloads that qualified artifact (or fails closed when retention expired) and rechecks digest and source identity; it does not run `package:release` on the publish runner. Promotion also binds the candidate metadata to the checked-out frozen source: version, bin aliases, dependency-lock digest, advisory review, source-provenance record and the explicit unsigned publisher status. Registry verification compares the published version's immutable integrity.

Consumer CI transports one frozen archive to all nine OS/Node rows. Each row
checks source and digest supplied independently of the downloaded manifest
before installation. Fresh homes, caches and empty npm configuration isolate
the installed consumer from ambient provider variables and Node preload state.
The original nine build-toolchain rows remain separately required.

The tag release does not repack the CLI. Both Desktop packagers accept
`--cli-archive=<qualified candidate>` and the release workflow passes the exact
`consumer-candidate` tarball for the frozen source, so the GitHub
`babel-harness-<version>.tgz` and the npm-promoted archive are the same bytes;
the draft step rejects a mismatch. Opening the draft also requires the exact
staged `SHA256SUMS` to verify, the Windows/Linux build records to name the
frozen source and version as unsigned, and a successful launch of that AppImage
under Xvfb with evidence bound to its digest. A portable bundle's embedded CLI
is still qualified only on the consumer rows that actually ran; hosted
cross-platform qualification and npm trusted-publisher access remain unverified
until those operations succeed.

A successful portable build must contain exactly one `BUILD.json` whose source
and version match the frozen tag. `release-evidence.json` records tag object,
source, workflow/run identity and the verified BUILD record. Missing or
ambiguous provenance fails; success-only evidence upload treats missing files
as an error. Inspect this evidence and archive checksums before authorizing
distribution. No release was performed by the CI implementation campaign.

The same tag workflow also builds `Babel-Desktop-<version>-linux-x64.AppImage`
on `ubuntu-latest` (`babel-desktop/scripts/package-linux.mjs`, pinned Node
24.13.1 linux-x64, Electron 44.5.1 linux-x64, appimagetool 1.9.1, and
type2-runtime 20251108). The draft release is created only after the Windows
and Linux jobs both finish. `SHA256SUMS` lists the Windows portable ZIP and
the Linux AppImage. The Linux
file inventory is attached as `manifest-linux-x64.json` so it does not replace
the Windows `manifest.json`. The Setup.exe checksum stays in its `.exe.sha256`
sidecar. The AppImage is unsigned and has no AppImage update channel. A `.deb`
is not published. npm publish is unchanged and is still a separate workflow.
The packager sets `SOURCE_DATE_EPOCH=0` and asks mksquashfs for one
processor so a rebuild from the same commit and the same pinned archives
can match. The `SHA256SUMS` file attached to the draft release is still
the authority for the published bytes. Verify a download against that
file. A checksum copied from another machine is not a substitute.

## Additional release automation (Future)

The following will be implemented as part of Option A Phase 4:

1. `tools/release.ps1` — automated script that:
   - Validates all CI gates (content policy, scrub, canonical independence, typecheck)
   - Bumps the version in `babel-cli/package.json` and `prompt_catalog.yaml`
   - Creates an annotated tag
   - Publishes a GitHub Release with generated changelog entry
2. Further release automation must preserve frozen source and archive identity
3. Clean-clone proof — a fresh clone of `gthgomez/Babel` at the release tag
   passes all validation without a parent workspace or sibling repo

**First public tag (`v0.1.0` and later) may ship without a consumer pin.**
Shipping a tag makes the tree pinable. **Canonical cutover complete** (Option A)
still requires a real external consumer to pin the tag + commit SHA and confirm
it works. That pin is deferred until a product has used Babel substantially.

## Security Releases

- Report vulnerabilities via [SECURITY.md](../../SECURITY.md)
- Security patches are released as patch versions on the current minor
- Critical patches may be backported to older minors at operator discretion
