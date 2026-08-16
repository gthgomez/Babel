# Convergence Regression Ledger

Frozen baseline for the authority-trust-boundary convergence branch.
Every test is accounted for — a red turning green is a demonstrated fix;
a red that disappears without a green is a regression to hunt.

**Counts**: 49 tests · 2 red (outcome ×2) · 47 green · parser 33/33 · integrity 10/10.

Integrity fix (commit 8f…): shared `patchTargets.ts` extractor (toolExecutor + wire both consume it),
canonical type-aware manifest (file/symlink/dir/missing, symlink-safe walk, deterministic sort),
drift evaluated before privileged decisions, `DENY_POLICY_INTEGRITY_DRIFT`, permanent lease
invalidation. Baseline lifecycle capture remains a caller seam (session start) — step 5 wiring.

## Parser family — `convergence-parser.regression-gate.test.ts` (33)

| ID | Invariant | Baseline | Current | Expected | Gap |
|----|-----------|----------|---------|----------|-----|
| L01 | `git -C <path> push` — option arg consumed | RED | GREEN | GREEN | #86 |
| L02 | `git -c <key=value>` — option arg consumed | RED | GREEN | GREEN | #86 |
| L03 | `git push origin +HEAD:refs/heads/x` → force_push | RED | GREEN | GREEN | #86 |
| L04 | `git push --mirror` → force | RED | GREEN | GREEN | #86 |
| L05 | quoted `;` in `python -c "x=1; …(.env)"` — one segment | RED | GREEN | GREEN | #87 |
| L06 | quoted `&&` in `sh -c "echo ok && rg . .env"` | RED | GREEN | GREEN | #87 |
| L07 | PowerShell `-Command "& { Get-Content .env }"` block form | RED | GREEN | GREEN | #87 |
| L08 | `rg` credential read | RED | GREEN | GREEN | both |
| L09 | `Select-String` credential read | RED | GREEN | GREEN | both |
| L10 | `grep` credential read | RED | GREEN | GREEN | both |
| L11 | `gh api --method=POST` single-token method | RED | GREEN | GREEN | #86 |
| L12 | `gh api -X POST` (guard) | GREEN | GREEN | GREEN | — |
| L13 | `psql -c "DROP TABLE"` → destructive (guard) | GREEN | GREEN | GREEN | — |
| L14 | `git --git-dir <path> push` | RED | GREEN | GREEN | #86 |
| L15 | `git --work-tree <path> push` | RED | GREEN | GREEN | #86 |
| L16 | `git --namespace <name> push` | RED | GREEN | GREEN | #86 |
| L17 | `git --config-env <key=ENV> push` | RED | GREEN | GREEN | #86 |
| L18 | `git push -f` → force_push (guard) | GREEN | GREEN | GREEN | — |
| L19 | `git push --force` → force_push (guard) | GREEN | GREEN | GREEN | — |
| L20 | `git push --force-with-lease` → force_push (guard) | GREEN | GREEN | GREEN | — |
| L21 | `+HEAD:refs/heads/x` refspec → force (dup of L03, family) | RED | GREEN | GREEN | #86 |
| L22 | `:refs/heads/x` → delete scope_expansion (guard) | GREEN | GREEN | GREEN | — |
| L23 | `--delete origin x` → delete (guard) | GREEN | GREEN | GREEN | — |
| L24 | `gh api --method POST` separate tokens (guard) | GREEN | GREEN | GREEN | — |
| L25 | `gh api -X POST` (guard, family dup) | GREEN | GREEN | GREEN | — |
| L26 | `gh api -XPOST` attached form | RED | GREEN | GREEN | #86 |
| L27 | `gh api … --method=POST` method after endpoint | RED | GREEN | GREEN | #86 |
| L28 | `gh api GET` stays pr_inspect (safe control) | GREEN | GREEN | GREEN | — |
| L29 | `git -C repo status` safe local inspect | RED | GREEN | GREEN | #86 |
| L30 | `grep something README.md` NOT credential | GREEN | GREEN | GREEN | — |
| L31 | `Select-String normal.txt` NOT credential | GREEN | GREEN | GREEN | — |
| L32 | `python -c "print(';')"` NOT credential | GREEN | GREEN | GREEN | — |
| L33 | `echo "a && b"` one segment, NOT credential | GREEN | GREEN | GREEN | — |

## Integrity family — `convergence-integrity.regression-gate.test.ts` (10)

| ID | Invariant | Baseline | Current | Expected | Gap |
|----|-----------|----------|---------|----------|-----|
| I01 | `write_file` to governance path → DENY_POLICY_SELF_MUTATION (guard) | GREEN | GREEN | GREEN | — |
| I02 | `apply_patch` mutating governance path → denied (extract targets) | RED | **GREEN** | GREEN | #86 |
| I03 | file added under governance directory detected | RED | **GREEN** | GREEN | #86 |
| I04 | governance-file creation/deletion after baseline detected | RED | **GREEN** | GREEN | #86 |
| I05 | `decideWithLease` denies on baseline drift (DENY_POLICY_INTEGRITY_DRIFT) | RED | **GREEN** | GREEN | #86 |
| I06 | regular file replaced by symlink detected | — | GREEN | GREEN | #86 |
| I07 | symlink target change detected | — | GREEN | GREEN | #86 |
| I08 | governance symlinks recorded, never followed outside repo | — | GREEN | GREEN | #86 |
| I09 | new nested directory introduced detected | — | GREEN | GREEN | #86 |
| I10 | drift permanently invalidates lease (second decision still denies) | — | GREEN | GREEN | #86 |

## Outcome family — `convergence-outcome.regression-gate.test.ts` (6)

| ID | Invariant | Baseline | Current | Expected | Gap |
|----|-----------|----------|---------|----------|-----|
| O01 | stale receipt → FALSE_COMPLETION (kernel guard) | GREEN | GREEN | GREEN | — |
| O02 | non-authoritative verifier → FALSE_COMPLETION (kernel guard) | GREEN | GREEN | GREEN | — |
| O03 | visible pass + contract fail → FALSE_COMPLETION (kernel guard) | GREEN | GREEN | GREEN | — |
| O04 | accurate unverified patch NOT false completion (kernel guard) | GREEN | GREEN | GREEN | — |
| O05 | adapter must not certify authoritative/fresh from `verifierOk` alone | RED | RED | GREEN | #87 |
| O06 | adapter surfaces contract-check results | RED | RED | GREEN | #87 |

## Verification state (branch commit 7effe24 + decoder work)

- `tsc --noEmit` — clean
- Parser gate + baseline suites (authority.test.ts 24, commandSemantics.test.ts 15, outcomeSemantics, codingTaskSuccess): 144/144 of the non-regression set
- Red set: exactly I02–I05, O05–O06 (6) — the integrity/outcome fix phases, untouched by the parser work
