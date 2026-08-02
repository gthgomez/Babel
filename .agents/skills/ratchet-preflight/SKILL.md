---
name: ratchet-preflight
description: >
  Pre-push architectural budget check — warns when files approach the CI ratchet
  threshold. Use before pushing to avoid the reactive "extract to pass CI" commit
  cycle. Identifies files nearing their line-count budget and suggests extraction
  targets via dependency analysis.
---

# /ratchet-preflight

Run the architectural budget check locally BEFORE CI discovers it. Warns when
source files approach their line-count ceiling, so you can extract modules
proactively instead of reactively.

Contract: invokes `tools/preflight-ratchet.ps1` and interprets the result.

## Triggers

| Input | Behavior |
|-------|----------|
| `/ratchet-preflight` | Quick check: all tracked files, warn at ≥85% of budget |
| `/ratchet-preflight --full` | Full CI-equivalent check (slower, exhaustive) |
| `/ratchet-preflight --threshold 90` | Warn only at ≥90% of budget |
| "preflight", "check ratchet", "budget check" | Same as default |

## Workflow

1. Run `pwsh tools/preflight-ratchet.ps1` (or with flags)
2. If GREEN — all clear, push without worry
3. If YELLOW — files are within threshold. Suggest extraction plan but don't block.
4. If RED — files are over budget. CI will fail. **Before extracting:**
   - Run `npx madge --image deps.svg <file>` to visualize dependencies
   - Identify a self-contained export subtree (class, function group, constants)
   - Extract into a new file under `babel-cli/src/`
   - Update `config/architectural-budget/file-sizes.json` with the new module entry
   - Run `pwsh tools/check-architectural-budget.ps1 -UpdateBaseline`
   - Re-run `/ratchet-preflight` to confirm GREEN

## Extraction Rules

- Never extract into `babel-cli/src/utils/` without checking existing imports
- Keep the new file under the same architectural budget rules (max 2,000 lines for new files)
- Update both `file-sizes.json` AND add the new file to the budget baseline
- Prefer extracting a cohesive module (class + its helpers) over arbitrary line-count splitting

## Related

- `ci-dry-run` — run the full CI pipeline locally before push
- `catalog-validate-all` — run the catalog validation trio
