# Babel Public-Export Proof

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Date: 2026-06-05

## Scope

This proof keeps public/export messaging conservative for an **autonomous Coding Agent CLI with optional governed pipeline mode**.

It covers:

- Babel Lite behavior and safety envelope
- prompt catalog integrity
- resolver/stack compilation behavior
- rollback/worktree safety evidence
- MCP adapter integrity
- current public-export limitations and known blockers

## Exact Validation Commands

1. `powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1`

   - Result: **PASS**
   - Verified: 163 catalog entries, 0 warnings, 0 errors.

2. `powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-local-stack.ps1`

   - Result: **PASS**
   - Verified: 7 resolver regression cases.

3. `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\resolve-local-stack.ps1 -Project example_saas_backend -TaskCategory backend -Model deepseek -PipelineMode verified -Format json`

   - Result: **PASS**  
   - Verified: selected stack includes backend architect/skills/policies for `example_saas_backend`.

4. `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\resolve-local-stack.ps1 -Project Project_Android -TaskCategory mobile -Model deepseek -Format json`

   - Result: **PASS**  
   - Verified: selected stack includes Android architect/skills for `Project_Android`.

5. `node .\babel-cli\dist\index.js benchmark lite --json`

   - Result: **PASS**  
   - Verified: `summary.scenarios: 4`, `summary.pass: 4`, `summary.fail: 0`.

6. `npm --prefix .\babel-cli exec -- tsx --no-warnings=ExperimentalWarning --test babel-cli/src/services/worktreeSafety.test.ts`

   - Result: **PASS**  
   - Verified: rollback/snapshot behavior in covered scenarios: 6 tests passed.

7. `npm --prefix .\babel-cli run test:mcp-adapter`

   - Result: **PASS**  
   - Verified: MCP adapter regression test suite passed.

8. `npm --prefix .\babel-cli run build`

   - Result: **PASS**  
   - Verified: `babel-cli/dist/index.js` produced and used in subsequent public-release validation.

9. `npm run test:public-export-regressions`

    - Result: **PASS**
    - Verified: scrub checker pass/fail boundary covers warning fixtures and strict mode: legacy placeholders pass in non-strict mode, fail in strict mode, while `.env.fake` and key-pattern matches still hard-fail.

10. `npm run test:public-release`

   - Result: **PASS**
   - Verified: full public-release script completed end-to-end on this workspace in 189 seconds after build, including scrub and local-stack parity checks.

11. `npm run test:public-release:strict`

   - Result: **PASS**
   - Verified: strict public-release validation runs the exported tree scrub with warnings promoted to failures.

## Claims-to-Evidence Map

| Claim area | Evidence status | Evidence / proof | Limitation |
| --- | --- | --- | --- |
| Lite command surface (ask/plan/proposal/fix/do) | GREEN | `node .\babel-cli\dist\index.js benchmark lite --json` and `tools\test-resolve-local-stack.ps1` stack output behavior. Current implementation uses proposal-only `bl patch`; target docs prefer `bl propose` / `bl diff` with `patch` as compatibility. | Lite remains experimental; no formal public benchmark parity against external agent tools yet. |
| Prompt catalog integrity | GREEN | `tools\validate-catalog.ps1`; `docs/status/claims-matrix.md` (`prompt_catalog` row). | No semantic catalog quality grading beyond structural resolution checks. |
| Resolver/compiler output consistency | GREEN (targeted evidence) | `tools\test-resolve-local-stack.ps1`; backend/mobile resolver command outputs. | Not yet exhaustively proven across all catalog permutations. |
| Rollback/worktree safety | GREEN | `babel-cli/src/services/worktreeSafety.test.ts` (6 passed). | No hostile-repo corpus stress matrix has been captured in this proof artifact. |
| MCP support surface | GREEN | `npm --prefix .\babel-cli run test:mcp-adapter`; `docs/architecture/MCP_Adapter-v1.md`. | MCP runtime end-to-end behavior is validated only in regression scope, not as a full cross-system benchmark. |
| Public export safety limitations | GREEN | `npm run test:public-export-regressions`, `npm run test:public-release`, and `npm run test:public-release:strict` are green on this workspace; legacy scrub warning fixtures remain regression-only and strict mode promotes warnings to failures. `.env.fake` and likely secret patterns remain hard failures. | Public export proof does not imply production-agent or market-parity readiness. |

## Status

This document is intentionally conservative:

- The current position is a proof-oriented, public-facing prototype of an autonomous coding agent.
- Public-release gating is currently command-green in this workspace after build, including strict scrub validation with warnings promoted to failures.
