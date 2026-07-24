<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: NPM OSS Release (v1.0)
**Category:** Framework / Release
**Status:** Active
**Pairs with:** `domain_swe_backend`, `skill_nodejs_cli`
**Activation:** Load for any task that prepares a Node.js package or CLI for public npm or open-source release, especially when the work includes package metadata, README install/use examples, tarball contents, licensing, or publish-readiness review.

---

## Purpose

Shipping a working local Node.js tool is not the same thing as shipping a public package.

Public release failures cluster around four surfaces:

1. metadata is incomplete or misleading (`name`, `repository`, `homepage`, `bugs`, `files`, `engines`)
2. the published tarball contains the wrong files or omits required ones
3. the README describes behavior that no longer matches the actual package contract
4. the project is called "OSS-ready" without a real license file, clean install path, or disclaimer placement

This skill turns those failure modes into a release-hardening checklist before a package is declared public-ready.

---

## Step 1 — CLASSIFY THE PUBLIC SURFACE

Before editing, declare the release surface:

| Question | Values |
|----------|--------|
| Package type | `library` / `cli` / `hybrid` |
| Runtime | `node` / `deno` / `bun` / `mixed` |
| Artifact source | `source files` / `build output` / `mixed` |
| Distribution target | `npm public` / `npm scoped` / `git-only release` |
| Public-claim level | `internal beta` / `public preview` / `public stable` |

**Rule:** A package can be publishable without being public-stable. Do not collapse those two claims.

---

## Step 2 — PACKAGE CONTRACT

Audit the release-facing package contract:

| Surface | Minimum check |
|---------|---------------|
| `name` | final publish name is intentional and available or intentionally scoped |
| `version` | release version matches the public contract being shipped |
| `bin` / `exports` | entrypoints match actual files |
| `type` | `module` / `commonjs` matches import style |
| `files` | package includes only runtime assets required by consumers |
| `engines` | minimum Node version is explicit |
| `repository` / `homepage` / `bugs` | point to the correct repo path |
| `license` field | matches the actual repo license decision |

**CLI-specific rule:** If the package exposes a CLI, verify the shebang, bin path, and runtime file extensions.

**Rule:** Do not call a package OSS-ready if the package metadata suggests openness but the repository still lacks the final license file.

---

## Step 3 — PACKAGED-CONTENTS PROOF

Use packaged output as evidence, not guesswork.

Minimum proof path:

1. run `npm pack --dry-run`
2. inspect the tarball file list
3. confirm no private fixtures, reports, local notes, test-only artifacts, or generated junk are being shipped
4. confirm required runtime files are present

Classify the result:

| Result | Meaning |
|--------|---------|
| `CLEAN` | tarball contains only intended public/runtime files |
| `LEAKING` | tarball contains private, noisy, or irrelevant files |
| `INCOMPLETE` | tarball is missing runtime assets, docs, or entrypoints |

**Rule:** README correctness without a clean tarball is not release readiness.

---

## Step 4 — README TRUTH CHECK

Audit every public-facing README claim against the actual package:

| Claim surface | What to verify |
|---------------|----------------|
| install instructions | commands work on a clean machine or are clearly labeled as inferred |
| usage examples | flags, filenames, entrypoints, and output fields match current code |
| schema examples | JSON examples match the real emitted contract |
| readiness claims | no "OSS-ready" or "public-ready" statement survives if licensing or packaging is incomplete |
| limitation/disclaimer copy | appears where a public user will actually see it |

**Rule:** Example output is part of the contract. A stale example is a broken public interface.

---

## Step 5 — RELEASE BLOCKERS

A public release is blocked if any of these remain unresolved:

- no final OSS license file in the repo
- package name not confirmed for publish intent
- `npm pack --dry-run` leaks non-public files
- install path not verified or explicitly marked unverified
- README examples drift from runtime behavior
- disclaimers or safety scoping appear only in source comments, not public docs/output

When the skill is used, end with:

```text
OSS RELEASE VERDICT
───────────────────
Package contract: [READY / BLOCKED]
Tarball contents: [CLEAN / LEAKING / INCOMPLETE]
README truth:     [ALIGNED / DRIFT]
License state:    [PRESENT / MISSING / UNDECIDED]
Remaining blockers:
- ...
```

---

## Hard Rules

1. Never call a package OSS-ready without checking for a real license file in the repository.
2. Never infer publish contents from `files` alone; verify with `npm pack --dry-run`.
3. Never leave example JSON or CLI output stale after a schema or flag change.
4. Never describe package naming or versioning as finalized if availability or publish intent is still unknown.
5. If a package is publishable but not truly public-ready, say so explicitly instead of flattening the distinction.
