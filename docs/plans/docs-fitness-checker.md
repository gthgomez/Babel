<!--
Babel Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Docs Fitness Checker Design

Status: design scaffold.
Target command: `babel docs audit`.

## Purpose

Provide deterministic checks for repos using `skill_agent_documentation_architecture` without turning the skill into a long docs-as-code manual.

The checker should verify that a repo has a small maintained documentation graph, not that every repo has the same docs. `.babel/docs-manifest.json` remains optional.

## Non-Goals

- Do not run an LLM cold-start eval.
- Do not require `.babel/docs-manifest.json` for every repo.
- Do not infer architecture correctness from docs alone.
- Do not delete, rewrite, or generate docs automatically in the first version.
- Do not treat historical/generated docs as current authority.

## Inputs

- Repo root.
- Optional `.babel/docs-manifest.json`.
- Existing docs discovered from known names and configured globs.
- Package/build manifests for trusted command existence checks.

Known docs:

- `README.md`
- `PROJECT_CONTEXT.md`
- `AGENTS.md`
- `CODEX.md`
- `CLAUDE.md`
- `GEMINI.md`
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- `QA_CHECKLIST.md`
- `docs/README.md`

## Optional Manifest Schema

Proposed minimum shape:

```json
{
  "schemaVersion": 1,
  "lastVerificationDate": "YYYY-MM-DD",
  "maintainedDocs": ["README.md", "PROJECT_CONTEXT.md", "AGENTS.md"],
  "historicalDocs": ["docs/archive/old-plan.md"],
  "generatedEvidence": ["artifacts/**"],
  "trustedCommands": [
    { "command": "npm test", "source": "package.json" },
    { "command": "adb install app.apk", "source": "external", "justification": "Requires Android SDK/device" }
  ],
  "highRiskPaths": ["app/build.gradle.kts", "src/auth/"],
  "doNotUseAsAuthorityGlobs": ["artifacts/**", "docs/archive/**"],
  "maxLineBudgets": {
    "AGENTS.md": 180,
    "CLAUDE.md": 200,
    "PROJECT_CONTEXT.md": 500
  }
}
```

Manifest validation:

- `schemaVersion` must be a supported integer.
- paths must be relative and must stay inside the repo.
- listed maintained docs must exist.
- listed historical docs must exist or be reported as stale manifest entries.
- trusted commands must have a source of `package.json`, `manifest`, `script`, `external`, or `doc`.
- external commands require a justification.
- line budgets must be positive integers.

## Checks

The first deterministic checker should emit warnings/errors for:

- maintained docs missing
- historical docs without a visible header containing `HISTORICAL`, `ARCHIVE`, `DEPRECATED`, or `DO_NOT_USE_AS_AUTHORITY`
- trusted commands missing from known manifests unless marked `external`
- line budgets exceeded without an explicit nearby justification
- linked relative paths that do not exist
- generated artifacts marked as `CURRENT_AUTHORITY`
- docs map missing classification for current, historical, generated, deprecated, and do-not-use docs in complex repos
- obvious secret material documented

Secret patterns should flag likely values, not harmless placeholder names:

- private key blocks
- API tokens with long high-entropy values
- `.env` assignments with credential-like names
- keystore passwords
- OAuth/client secrets
- cloud access keys

## Severity

- `error`: unsafe or structurally broken docs graph.
- `warn`: likely drift or budget problem that needs review.
- `info`: optional improvement.

Suggested errors:

- maintained doc listed but missing
- generated artifact listed as current authority
- private key or credential value appears in docs
- path escapes repo root

Suggested warnings:

- line budget exceeded with no justification
- historical doc lacks header
- trusted command cannot be found
- stale phrase appears in a current doc
- optional manifest references missing historical docs

## Output

Human output should be concise:

```text
Docs fitness audit:
- Errors: 0
- Warnings: 2
- Info: 1
- Manifest: present
- Cold-start readiness: manual eval still required
```

JSON output should include:

- repo root
- manifest status
- totals by severity
- findings with code, message, path, line when available
- line-budget summary
- checked docs list

## Implementation Notes

Phase 1 can be read-only and file-system based.

Recommended modules:

- manifest loader and schema validator
- doc discovery
- path/link checker
- line-budget checker
- command existence checker
- historical header checker
- generated/current classification checker
- secret pattern scanner

Do not wire this into required CI until false positives are measured on at least three repos.
