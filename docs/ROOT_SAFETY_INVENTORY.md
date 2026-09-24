# Root safety inventory (read-only)

**Audience:** maintainers and stewardship contributors.  
**Updated:** 2026-09-19  
**Source tree:** live `main` at inventory time via GitHub git trees API (`GET /repos/gthgomez/Babel/git/trees/main`).  
**Policy:** this document is **documentation only**. It does **not** authorize moves, renames, or deletions.

Stewardship campaign rule ([#231](https://github.com/gthgomez/Babel/issues/231)): do not relocate runtime-sensitive root paths without **reference proof**. Prefer DOCUMENT / ARCHIVE-candidate notes over filesystem churn.

### Classification legend

| Class | Meaning |
|---|---|
| **KEEP** | Stays at root; public product or OSS community surface. |
| **DOCUMENT** | Stays at root for now; role should be clear from docs links (STRUCTURE / this inventory). |
| **ARCHIVE-candidate** | Likely historical/campaign artifact; may later move under `docs/` **only** with maintainer + reference proof. **No move in this PR.** |
| **DO-NOT-TOUCH** | Runtime, catalog, Prompt OS layers, or agent instruction surfaces. Do not move/rename in stewardship docs PRs. |

---

## Root directories

| Path | Class | Notes |
|---|---|---|
| `00_System_Router/` | **DO-NOT-TOUCH** | Prompt OS / runtime contracts layer. |
| `01_Behavioral_OS/` | **DO-NOT-TOUCH** | Behavioral instruction layer. |
| `02_Domain_Architects/` | **DO-NOT-TOUCH** | Domain routing shells. |
| `02_Skills/` | **DO-NOT-TOUCH** | Cataloged reusable skills. |
| `03_Model_Adapters/` | **DO-NOT-TOUCH** | Model adapter layer. |
| `04_Meta_Tools/` | **DO-NOT-TOUCH** | Prompt maintenance assets. |
| `05_Project_Overlays/` | **DO-NOT-TOUCH** | Project overlays (catalog-linked). |
| `06_Task_Overlays/` | **DO-NOT-TOUCH** | Task overlays (catalog-linked). |
| `07_Pipeline_Stages/` | **DO-NOT-TOUCH** | Pipeline stage prompts. |
| `babel-cli/` | **DO-NOT-TOUCH** | Local coding-agent runtime / TUI package. |
| `prompt_catalog.yaml` *(file)* | **DO-NOT-TOUCH** | Machine-readable catalog contract. |
| `prompts/` | **DO-NOT-TOUCH** | Standalone prompt definitions. |
| `LLM_COLLABORATION_SYSTEM/` | **DO-NOT-TOUCH** | Collaboration / instruction rules surface. |
| `skills/` | **DO-NOT-TOUCH** | Installable agent skills tree (distinct from `02_Skills/`; still instruction/runtime-adjacent). |
| `.agents/` | **DO-NOT-TOUCH** | Contributor agent rules/skills consumed by agents. |
| `config/` | **DO-NOT-TOUCH** | Runtime/policy config examples and seeds. |
| `docs/` | **KEEP** | Public documentation (this inventory lives here). |
| `examples/` | **KEEP** | Golden previews / first-success fixtures. |
| `tools/` | **KEEP** | Public validation, scrub, release helpers. |
| `tests/` | **KEEP** | Test suites. |
| `benchmarks/` | **KEEP** | Benchmarks / fixtures (treat claims carefully; no fabricated results). |
| `scripts/` | **DOCUMENT** | Agent git/PR helpers and ceremonies; not product front door. |
| `.github/` | **KEEP** | CI / community GitHub metadata. |
| `.githooks/` | **DOCUMENT** | Local hook helpers; maintainer-oriented. |

Dotfiles (`.gitignore`, `.gitattributes`, `.rgignore`) are **KEEP** operational metadata.

---

## Root files

| Path | Class | Notes |
|---|---|---|
| `README.md` | **KEEP** | Product front door (progressive disclosure / try-path belongs here). |
| `START_HERE.md` | **KEEP** | **Canonical first-success** path. |
| `LICENSE` | **KEEP** | Apache-2.0 for this tree. |
| `CHANGELOG.md` | **KEEP** | Release history (user-outcome-first Unreleased narrative is a follow-up docs pass). |
| `CONTRIBUTING.md` | **KEEP** | Contributor entry (progressive disclosure later). |
| `CODE_OF_CONDUCT.md` | **KEEP** | Community standard. |
| `SECURITY.md` | **KEEP** | Security reporting. |
| `AGENTS.md` | **DO-NOT-TOUCH** | Agent instruction / startup surface. |
| `CLAUDE.md` | **DO-NOT-TOUCH** | Agent instruction / project invariants. |
| `GEMINI.md` | **DO-NOT-TOUCH** | Agent instruction surface. |
| `ENGINEERING.md` | **DOCUMENT** | Coding standards for agents/contributors. |
| `PROJECT_CONTEXT.md` | **DOCUMENT** | Topology / contracts context for agents. |
| `INTEGRATION.md` | **DOCUMENT** | Model/integration invocation contract. |
| `STRUCTURE.md` | **DOCUMENT** | Human-oriented tree map (companion to this inventory). |
| `ASTRA_PRETEST_READINESS_FINAL.md` | **ARCHIVE-candidate** | Dated campaign readiness report; historical input. |
| `REGRESSION_LEDGER.md` | **ARCHIVE-candidate** | Frozen convergence regression ledger; historical evidence. |

---

## Explicit non-actions

This inventory **does not**:

- move or rename any **DO-NOT-TOUCH** path;
- relocate ARCHIVE-candidates;
- change `babel-cli/`, numbered `00_`–`07_` trees, catalogs, or agent instruction files;
- treat route/command existence as reliability proof.

When a future PR proposes a purely docs-safe relocation, cite this inventory, the reference proof, and keep runtime consumers unchanged.

## Related

- [STRUCTURE.md](../STRUCTURE.md) — existing human tree overview
- [docs index](./README.md) — documentation map
- [public roadmap](./ROADMAP.md) — NOW / NEXT / LATER
- Campaign tracker: [#231](https://github.com/gthgomez/Babel/issues/231)
