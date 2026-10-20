# Agent B publication and review receipts

## Draft PR #404

| Item | Recorded fact |
|------|----------------|
| PR | https://github.com/gthgomez/Babel/pull/404 (draft) |
| Branch | `cursor/agent-b-general-fixtures-f617` |
| Pre-review push head | `c7ff361e` (M0 fixtures/design only) |
| Auto-created by platform? | **No.** Agent ran `git push -u origin cursor/agent-b-general-fixtures-f617`, then **`ManagePullRequest` `create_pr`** with `draft: true`. GitHub’s “create a pull request” remote hint is normal post-push messaging, not a separate auto-PR. |
| Reciprocal / exact-head review before #404 | **Not evidenced.** Opened at Agent B first checkpoint before Agent A contract relay and before B non-author review of A’s head. |
| Merge / ready for review | **None.** Draft preserved; no merge, no `draft: false`. |
| Post-review remote writes | **None** after contract review hold (local-only checklist/findings files; not pushed). |

## Pre-push / maintainer guards (this environment)

| Guard | Result |
|-------|--------|
| `pwsh scripts/agent-preflight.ps1` | **Not run** — `pwsh` not installed in cloud VM |
| `pwsh tools/check-public-content-policy.ps1` | **Not run** (same) |
| `pwsh tools/run-public-secret-scan.ps1` | **Not run** (same) |
| Content pushed | Owned-path fixtures/design markdown/HTML/PDF only; no secrets in tree |

## Contract review (Agent A), local only

| Item | Value |
|------|--------|
| Reviewed head | `59cd561b2414fcc32253de568c70285517eae1cd` (`cursor/research-v2-contract-a-fc31`, draft #405) |
| Verdict | **BLOCK** (see `CONTRACT_REVIEW_FINDINGS.md`) |
| Relayed to coordinator | Via Cursor thread; **not** posted as #404/#405 PR review |
| v2 contract tests (local worktree) | 8/8 pass, no network |

## Guard commands (last executed — not re-run for unchanged tree)

Task-local `pwsh`: `/workspace/.tools/powershell-7.5.4/pwsh` (Microsoft **7.5.4**, SHA256 verified).

| Guard | Command | Exit | Result |
|-------|---------|------|--------|
| Preflight | `pwsh scripts/agent-preflight.ps1 -RepoRoot /workspace -GitPath /usr/bin/git -GhPath /exec-daemon/gh` | 1 | `ok: false` — `unexpected_dirty_worktree` (`.tools/` + uncommitted docs); `repo_local_gh_credential_helper_missing` (**user approval pending — not configured**) |
| Public content | `pwsh tools/check-public-content-policy.ps1 -RepoRoot /workspace` | 0 | **Public content policy passed.** |
| Secret scan | `pwsh tools/run-public-secret-scan.ps1 -RepoRoot /workspace -Strict -RequireExternalScanner` | 1 | Scrub **pass**; **gitleaks 8.30.1** — 2 findings in **`.tools/README.md`** (tool artifact examples, not Babel source) |
| Maintainer pre-merge | `pwsh tools/validate-public-release.ps1 -Strict -RequireSupplementalPolicy` | **not run** | **Blocks maintainer merge only** — requires real `BABEL_PRIVATE_SCRUB_POLICY_PATH` or approved `-SupplementalPolicyPath`; does **not** block local B-owned work or ordinary push scrub by itself; **no campaign waiver** |
| Secret scan (after tool relocation) | same + gitleaks on `PATH` from `/tmp/babel-campaign-tools.*` | **0** | **Public secret scan passed with gitleaks 8.30.1** (full repo, untracked source included; no gitignore/scanner exclusions) |

**Campaign tools (outside checkout):** verified copy at `/tmp/babel-campaign-tools.hjmT7z` — pwsh **7.5.4**, gitleaks **8.30.1**, tarballs match `tools/security/policy.json` + Microsoft `hashes.sha256`. **Removed** generated-only `/workspace/.tools/` from checkout (no source mixed).

**Ordinary push** (when authorized): preflight + public-content + strict external secret scan. **Maintainer pre-merge** additionally needs supplemental policy.

### `repo_local_gh_credential_helper_missing` — sanctioned repair (NOT performed)

Per `docs/guides/AGENT_GIT_OPERATIONS.md` § Repository-local GitHub credentials, **repo-local only** (no global config):

```powershell
git config --local --unset-all credential.helper
git config --local --add credential.helper ''
git config --local --add credential.helper '!gh auth git-credential'
```

**Scope if user approves:** mutate only this clone’s `.git/config` credential.helper chain; requires existing `gh auth` session (no token in repo). **Pending user approval** — not applied in this campaign VM.

## Unpublished diff handoff (vs remote #404 `c7ff361e`)

| Scope | SHA-256 |
|-------|---------|
| Committed `origin..HEAD` (2 commits) | `a12d94376e34b1aab5e6c328b80f54b6c3801abbacb8133bb7f9518e18b019c4` |
| Full unpublished vs `c7ff361e` (excl. `.tools/`) | `ea756242127343ed2cacd19c38c9154d6f3b06ac79a9c562e766cf0c2acd2342` |
| Local HEAD | `7aa145b1287fdb88fa6914dc65372ce5fb1171ce` |

## Current gate posture

- Keep **#404** draft; do not delete or hide.
- **No** further push/PR updates until coordinator relays exact-head agreement after A contract + reciprocal review.
- Local independent work allowed under B-owned paths.
