# Research V2 shared peer review checklist

**Status:** ACTIVE for Agent A ↔ Agent B contract and fixture work  
**Campaign:** two agents, no merge authority, remote writes held until coordinator release after exact-head review

## Coordinator guards (read first)

| Gate | Blocks | Does **not** block (unless separate repo policy says otherwise) |
|------|--------|------------------------------------------------------------------|
| `validate-public-release.ps1 -Strict -RequireSupplementalPolicy` / missing `BABEL_PRIVATE_SCRUB_POLICY_PATH` | Maintainer **pre-merge** / publication scrub bundle | Independent local implementation, typecheck/tests, export review transport, ordinary **push** readiness once other preflight checks pass |
| `run-public-secret-scan.ps1 -Strict -RequireExternalScanner` | Shipping without **pinned gitleaks** (8.30.1 per `tools/security/policy.json`) | N/A — enforced scan must run with checksum-verified scanner; exit 0 without scanner is not accepted |
| `repo_local_gh_credential_helper_missing` | `agent-preflight` **pushReady** / mutation-ready | Local edits, tests, export bundles; repair is repo-local Git config only (see below) |

No campaign waiver. No merge authority for agents.

## Mandatory cross-agent checks (do not waive)

### B-owned fixture paths (#404 FIX — controlling)

Agent A’s initial peer pass **missed** broken B fixture paths. Treat as a process gap, not a reason to skip B’s repair.

Before APPROVE on either side’s contract/fixture slice:

1. **Path existence:** Every corpus/fixture path referenced in B-owned manifests, tests, and docs exists on disk at the reviewed HEAD (no stale renames, no missing JSON under declared trees).
2. **Test honesty:** Run B colocated tests (e.g. `manifest.test.ts` and general fixture tests) in an isolated worktree with `npm ci` + documented Node import flags — not “file exists” spot checks only.
3. **Independent FIX:** `#404` fixture-path repair remains **B-owned** and **blocking** for dependent adapter work; A does not edit B-owned trees to “fix forward” without explicit coordinator scope.
4. **Normalization seam:** When A changes `normalizeGeneralMissionBrief()` or mission JSON shape, re-verify B corpus samples still parse without casts and that route metadata (`fixture_route`) matches intent.

### A-owned contract seam (checkpoint.2)

1. `SourceAccessPort.fetchContent` + `SourceAdapter.read` — no raw fetch in adapters.
2. Store writes carry `MissionWriteContext`; external operation append APIs present and covered by fake ports + regression tests.
3. Passage locators / text refs validated; integrity vs semantic support enums not conflated.
4. Model outputs validated per operation kind; cancel/fail paths include `usage_settlement`.

### Evidence bar

- Exact **base/head/tree** SHAs recorded in review outcome.
- Secret scan: **pinned gitleaks 8.30.1** (linux tarball SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`) or CI-equivalent install before claiming “strict external scan passed.”
- Do not emit transport base64 before export scan passes.

## Sanctioned `repo_local_gh_credential_helper_missing` repair (operators only)

From `docs/guides/AGENT_GIT_OPERATIONS.md` — **repo-local only**, global Git Credential Manager unchanged:

```powershell
$git = <host git executable>
& $git config --local --unset-all credential.helper 2>$null
& $git config --local --add credential.helper ''
& $git config --local --add credential.helper '!gh auth git-credential'
```

Verify (no credential values): `gh auth status --hostname github.com`, `git config --show-origin --get-all credential.helper`, `git ls-remote origin HEAD`.

**Agent A scope note:** Applying the above mutates `.git/config` in this checkout. Requires explicit coordinator/operator authorization per `AGENTS.md` (repo-local credential-helper edits need explicit scope). Do **not** set global helpers, copy credential files, or add persistent auth beyond this pattern without that scope.

## Review outcome template

| Field | Agent B / independent |
|-------|------------------------|
| Reviewed HEAD | `<sha>` |
| Fixture paths verified | yes / no (list failures) |
| `#404` FIX status | open / closed at SHA |
| Verdict | APPROVE / BLOCK |
| Notes | |
