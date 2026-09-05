<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-04
-->

# Daily Driver Campaign — Plan

Companion to [DAILY_DRIVER_CAMPAIGN_BASELINE.md](./DAILY_DRIVER_CAMPAIGN_BASELINE.md)
(canonical `main` @ `015c7b3`). This plan contains the required Initial Output:
product-state assessment, gap map, dependency graph, PR plan, and the stop/go decision.

Campaign engineering rules honored: GitHub authoritative (audited 2026-09-04);
no recovery-era resurrection (clean `agent/daily-driver` worktree from `origin/main`);
no architecture duplication (every gap below extends a named canonical component);
root causes not green-by-bypass; evidence before claims.

---

## A. Current Product-State Assessment

Ratings use STRONG / ACCEPTABLE / WEAK / MISSING, each justified from current code
(full evidence in the baseline §3–§5):

| Area | Rating | Core justification |
| --- | --- | --- |
| Model Intelligence UX | **WEAK** | Deep, tested backend (`modelPolicy.ts`, `intelligence/`, `routingEngine.ts`) with no operator presentation: no "why", no route health, no fallback order, qualification state unpresented, and the idle status bar shows a fabricated `qwen3-32b` default (`replSessionUi.ts:41`) |
| Provider reliability UX | **WEAK** | Hash-chained failure receipts + 13-class taxonomy exist but are production-dead for messaging; users read raw `[deepInfraApi] HTTP 401 …{body}`; context overflow unclassified; fallback narration suppressed by default in evidence-bearing runs (`execute.ts:1475-1476`) |
| Chat UX | **ACCEPTABLE** | Streaming, cancellation, resume, checkpoints, diffs, costs all work well; governance vocabulary (`force_mutate`, `phase-gate`, `Evidence:`, `soft fuses`) leaks into daily surfaces; help table drifts from dispatcher |
| TUI quality | **STRONG** | 44k-LOC custom renderer, ConPTY-aware degradation, two-region streaming, resize-safe, vim composer, 24-scenario deterministic cert suite |
| Windows support | **ACCEPTABLE (borderline)** | Full required suite green on `windows-latest`; core spawn/kill/jail/PATH solid — but clean-room verifier broken (`independentVerifier.ts:118`), `safeEnv` strips `Path` casing (`safeEnv.ts:101-105`), wrapper-only kills orphan grandchildren (`cliBase.ts:159-175`) |
| Trust/certification operations | **WEAK** | Verification plane is STRONG and CI-green; operator custody MISSING — no key tooling/procedure, `BABEL_TRUSTED_REVIEW_ISSUER` unimplemented, live tier is AUTONOMOUS |
| Evaluation maturity | **WEAK** | Benchmark machinery exists (agentBenchmark, swebenchPro) but no reproducible daily-driver eval suite, no published results, no fixed comparable configs |
| Release readiness | **WEAK** | `v0.1.0` (2026-07-23) vs main 2026-09-04; CHANGELOG Unreleased backlog; dead npm scripts; no screenshots; no release automation |

---

## B. Gap Map

Per priority: existing components → missing behavior → user impact → dependency →
risk → scope → recommended PR boundary.

### P1 — Model Intelligence operator surface

- **Existing:** `ResolvedModelPolicy` (+waterfall, cost, capabilities), `resolveStagePolicyRoutes`,
  `routingEngine.ts` RoutingDecision, turn receipts, `05_waterfall_telemetry.json`,
  `validateModelPolicyMetadataFreshness`, qualification states in `intelligence/registry.ts`,
  `/model` `/policy` `/status` `/stats` `/dashboard` command shells.
- **Missing:** single model-detail view (backend/provider/upstream/context/cost/waterfall);
  selection rationale ("why"); route health (metadata freshness + qualification + last-receipt);
  fallback next-tier + last-fallback flag; truthful idle default; `models` CLI handler.
- **User impact:** the five acceptance questions become answerable in-terminal without JSON.
- **Technical dependency:** none — all data already computed and stored; this is presentation.
- **Risk:** low. Output-format churn in existing commands; mitigate with output-snapshot tests.
- **Scope:** M (≈600–900 LOC incl. tests across `interactive/commands/config.ts`, `info.ts`,
  `replSessionUi.ts`, `renderers.ts`, new `interactive/commands/modelDetail.ts`, `cli/argv.ts`).
- **PR boundary:** PR-1 alone.

### P2 — Provider reliability UX

- **Existing:** receipt `failure_class`/`http_status` on `onInvocationCompleted`
  (`deepInfraApi.ts:732-797`), taxonomy + retry-safety helpers
  (`providerFailureReceipt.ts:324-380`), `classifyProviderError`
  (`providerNormalize.ts`), credentialHub messages, quota widget, `session-events.jsonl`.
- **Missing:** failure-class → actionable message mapping at the three terminal surfaces
  (`chatEventDispatch.ts:91-101`, `chatCore.ts:1030-1049`, `BabelRepl.ts:283-305`);
  context-overflow classification + compaction guidance; default-on one-line fallback
  narration; receipts/failure viewer (`babel failures --last` or `inspect` extension);
  promote V1 taxonomy into production classification.
- **User impact:** failures become classified, concise, actionable, non-secret, and
  distinguishable from Babel bugs — without stack traces.
- **Technical dependency:** builds on PR-1's model/status surfaces (shared rendering).
- **Risk:** medium — must not leak secrets (reuse `redactSecrets`), must not hide failures
  (message enrichment, never swallowing). Retry-behavior changes are explicitly out of scope.
- **Scope:** M–L (≈800–1,200 LOC incl. adversarial message tests).
- **PR boundary:** PR-2 alone.

### P3 — Daily Chat/TUI polish

- **Existing:** command groups + dispatcher, review cards, `/why-stopped`, `/ship`, `/evidence`,
  `structuredOutput` summary builder, `terminalProbe`.
- **Missing:** plain-language rewrites of governance strings (keep evidence accessible via
  dedicated inspection commands, not removed); help-table truth; dangling doc pointer fix;
  WT auto-enable where safe; `/cancel` regrouping; double-`break` fix; `/clear` confirmation.
- **User impact:** Chat reads like a coding tool, not a governance console.
- **Technical dependency:** after PR-1/PR-2 to avoid reworking the same output strings twice.
- **Risk:** low-medium — vocabulary changes touch test snapshots; safety wording must not be
  weakened (rewrites reviewed against `.agents/rules/` and evidence requirements).
- **Scope:** M (≈400–700 LOC incl. snapshot updates).
- **PR boundary:** PR-3 (strings/help) — diff-per-file UX improvement **DEFER** unless trivial.

### P4 — Windows execution polish

- **Existing:** `terminateChildTree` (`sandbox.ts:344-396`), `resolveWindowsCommandShell`
  (`sandbox.ts:723-732`), `runtimePreflight` locators, windows-portability CI job.
- **Missing (root-cause fixes, each with regression test):** case-insensitive `safeEnv`
  allowlist; verifier `.cmd` shim resolution; `terminateChildTree` reuse at orphan-kill
  sites; `npx` post-edit shim; SIGTSTP/restore-guard guards; centralized shell resolution;
  `/tmp` → `os.tmpdir()`; docker fail-closed default guidance for Docker-less hosts
  (message + docs, not silent behavior change).
- **User impact:** verification and timeout behavior become predictable on Windows 11 +
  PowerShell, matching Linux semantics.
- **Technical dependency:** PR-4 must land before P6 evals (eval harness spawns processes).
- **Risk:** medium — safeEnv and kill paths are security-adjacent; changes need targeted
  adversarial tests (there are existing suites to extend: `sandbox.test.ts` win32 block).
- **Scope:** M–L (≈600–1,000 LOC incl. tests).
- **PR boundary:** PR-4 alone (single theme: process lifecycle + env correctness).

### P5 — Signed verifier custody / certified review

- **Existing:** complete verification plane (receipts, ledger, gate, TrustRootUpgradeV1),
  public key registries, boundary tests, `BABEL_REQUIRE_SIGNED_REVIEW` gate read.
- **Missing:** operator tooling to generate/import/rotate/revoke registry keys
  (public halves committed, private halves never touch the builder env);
  documented provisioning/enabling/rotation/revocation/recovery procedure;
  an issuer-lane integration that matches `BABEL_TRUSTED_REVIEW_ISSUER` semantics
  (documented contract + gate support); runtime wiring decision for the
  trusted-execution supervisor (wire a minimal, safe read-only surface or explicitly defer).
- **User impact:** maintainers can move PRs from AUTONOMOUS to CERTIFIED review without
  improvising key ceremonies; builder agent provably never holds signing material.
- **Technical dependency:** independent of P1–P4; must precede P7 release claims about trust.
- **Risk:** high-safety (cryptography, custody) but low blast-radius if scoped to tooling +
  docs; **never** implement by placing private keys in repo/logs/prompts/CI build env.
  Human-held secret step → exact bootstrap checklist if not completable here.
- **Scope:** M (key ceremony script + docs + gate variable support; ≈500–800 LOC).
- **PR boundary:** PR-5.

### P6 — Real end-to-end coding evaluations

- **Existing:** benchmark governance harness, SWE-Bench Pro machinery, evals/benchmarks dirs,
  evidence bundles (metrics source), cost tracker, turn receipts, failure receipts.
- **Missing:** compact task suite (bug fix, test repair, small feature, refactor, repo
  comprehension, dependency migration, debugging, security-sensitive change, multi-file,
  Windows-specific where practical); metric collection (success, tests, regressions,
  attempts, duration, tokens, cost, tool calls, provider/model, failure class, evidence
  completeness); fixed comparable model/provider configs; `docs/evals/DAILY_DRIVER_EVAL_V1.md`
  + machine-readable raw results.
- **User impact:** proof the product codes well — not just that gates pass.
- **Technical dependency:** P1/P2 (identity metrics), P4 (reliable Windows spawning).
- **Risk:** medium — evaluation-vs-benchmark-gaming boundary: suite measures the product as
  configured for users; no benchmark-specific hardcoding.
- **Scope:** L (harness ≈800–1,200 LOC + docs + first results).
- **PR boundary:** PR-6 (harness) then results committed in the same PR or PR-6b if runs are long.

### P7 — Release readiness

- **Existing:** `tools/validate-public-release.ps1`, prepublishOnly provenance checks,
  accurate install docs, two-OS CI.
- **Missing:** CHANGELOG regeneration from actual merged PRs; version bump (`0.2.0`);
  real screenshots/recordings (captured, not fabricated); release notes; upgrade notes
  (v0.1.0 → v0.2.0); dead-script cleanup; release workflow (tag-gated, minimal);
  publication decision (GitHub Release creation is irreversible → human gate).
- **User impact:** the public artifact matches the product.
- **Technical dependency:** all prior PRs.
- **Risk:** low in code, high in care — no fabricated evidence, no premature 1.0.
- **Scope:** M.
- **PR boundary:** PR-7 (readiness) + human-approved tag/publish step outside the campaign.

---

## C. Dependency Graph

Verified order (adjustments to the campaign list justified by code reality):

```
P1 Model Intelligence UX ──┐
                           ├─► P3 Chat/TUI polish ─┐
P2 Provider reliability UX ┘                       │
                                                   ├─► P7 Release readiness
P4 Windows execution fixes ──► P6 Evaluations ─────┤
                                                   │
P5 Signed-review operations ───────────────────────┘ (independent lane)
```

Deviations from the campaign's listed order and why:

1. **P3 (Chat polish) after P1/P2** — the same output strings/surfaces are reworked by
   P1/P2; polishing first would be thrown away. The campaign list ordering is preserved
   for the heavy UX work; P3 is a presentation-consistency pass over their results.
2. **P4 before P6** — the eval harness spawns processes and must run on this Windows host;
   landing the verifier/env/kill fixes first prevents measuring around defects.
3. **P5 is an independent lane** — no dependency on P1–P4; can proceed whenever its PR slot
   opens. It must complete (tooling + docs) before P7 makes any certification claim.
4. **P6 after P1/P2** — evaluation metrics include provider/model identity and failure
   classification, which P1/P2 surface.

---

## D. PR Plan

Each PR: independently reviewable, lands on a feature branch off current `main`,
rebased immediately before opening, gated by the repo's required checks.

| # | Title | Objective | Expected files/components | Dependencies | Tests | Risks | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR-1 | `feat(model-intel): model, routing, and health operator surface` | Answer what/why/where/healthy/fallback in-terminal | `interactive/commands/config.ts`, new `interactive/commands/modelDetail.ts`, `interactive/commands/info.ts`, `interactive/repl/replSessionUi.ts`, `ui/renderers.ts`, `cli/argv.ts` (`models` handler), `cli/userFacingStatus.ts` | — | Output-format unit tests; extend `config.modelInvalidate.test.ts`; snapshot tests for new views; new tests assert no fabricated default | Output churn for existing users of `/model`; keep old formats as strict supersets | All five MI acceptance questions answerable from the TUI without JSON; idle UI never displays a model the policy didn't resolve; `npx tsx --test` for touched suites + typecheck green |
| PR-2 | `feat(reliability): actionable classified provider failures` | Classify + explain failures at terminal surfaces; surface receipts | `interactive/execution/chatEventDispatch.ts`, `interactive/execution/chatCore.ts`, `interactive/BabelRepl.ts`, `runners/deepInfraApi.ts`, `runners/deepSeekApi.ts`, `runners/providerFailureReceipt.ts`, `execute.ts` (fallback line default), new `commands/failures.ts` | PR-1 | Extend `providerReliabilityAdversarial.test.ts` with message-assertion cases; secret-leak redaction tests; context-overflow classification tests; new `failures` command tests | Message enrichment must never swallow errors or leak secrets; retry semantics untouched | Each failure mode in the campaign list produces a classified, actionable, non-secret message; fallback line visible by default; `babel failures --last` summarizes receipts; suites green |
| PR-3 | `polish(chat): daily-driver legibility` | Remove governance jargon from daily surfaces; fix help drift | `interactive/types.ts`, `interactive/help.ts`, `interactive/commands/config.ts`, `interactive/commands/info.ts`, `agent/implementorPolicy.ts` (message strings only), `cli/structuredOutput.ts`, `config/chatTaskClass.ts` (presentation), `ui/reviewCard.ts`, new doc replacing dangling pointer | PR-1, PR-2 | Snapshot updates with explicit review of removed wording; help-vs-dispatch consistency test (new); `/why-stopped` content tests | Must not weaken safety meaning — evidence still accessible via `/evidence`/`/inspect` | All identified vocabulary offenders rewritten in plain language; help table matches dispatcher exactly; dangling pointer resolved; suites green |
| PR-4 | `fix(windows): process lifecycle and env correctness` | Root-cause Windows defects with regression tests | `utils/safeEnv.ts`, `evidence/independentVerifier.ts`, `runners/cliBase.ts`, `tools/mcpTransport.ts`, `bridge/sessionRunner.ts`, `services/knowledgeGraphIndexer.ts`, `agent/chatEngineSupport.ts`, `ui/waterfall.ts`, `ui/keyInput.ts`, `ui/terminalRestoreGuard.ts`, `lite/contract.ts`, new shared `utils/winShell.ts` (centralized shell resolution) | — (independent lane) | New win32 regression test per defect (case-insensitive env allowlist incl. `Path` casing; shim resolution for `npm`/`npx`; tree-kill on timeout; SIGTSTP no-op guard; tmpdir); extend `sandbox.test.ts` | Security-adjacent paths (env filtering, kill trees) — adversarial tests required; no loosening of existing allowlists | Each baseline §3.4 defect has a failing-test-first fix; full required Windows CI job green; no behavior change on Linux (CI green) |
| PR-5 | `feat(trust): signed-review operator tooling and custody docs` | Make CERTIFIED tier operable without handing keys to the builder | new `scripts/review-key-ceremony.ps1` (generate/import/rotate/revoke — public halves only written to repo), `docs/architecture/TRUST_ROOT_OPERATIONS.md` (provision/enable/rotate/revoke/recover), gate support + docs for issuer-lane contract (`BABEL_TRUSTED_REVIEW_ISSUER` semantics), `tools/tests/` ceremony tests | — (independent lane) | Ceremony script tests (non-interactive, temp registries); boundary tests asserting no private material paths in repo; existing trust suites stay green | Custody mistakes; script must refuse private-key material in repo tree; human key step documented as checklist if not completable here | Operator can follow the doc to provision keys and set `BABEL_REQUIRE_SIGNED_REVIEW=1`; rotation/revocation procedures tested against temp registries; no private key ever enters repo/logs/prompts |
| PR-6 | `feat(evals): daily-driver evaluation harness and first results` | Reproducible real-coding-task evaluation | new `babel-cli/src/evals/dailyDriver/` (task specs, runner, metrics), `docs/evals/DAILY_DRIVER_EVAL_V1.md`, raw results JSON | PR-1, PR-2 (identity metrics), PR-4 (reliable spawning) | Harness self-tests (deterministic fixtures); metric extraction tests; results schema validation | Do not optimize Babel against the suite; keep tasks distinct from unit fixtures | Harness runs ≥ the compact task suite end-to-end with fixed model/provider config; metrics + raw results committed; methodology/limitations documented |
| PR-7 | `chore(release): v0.2.0 readiness` | Make the public artifact match the product | `CHANGELOG.md`, `babel-cli/package.json` (version + dead-script removal), `docs/guides/RELEASE.md` refresh, real `docs/assets/` captures, release notes draft, minimal tag-gated release workflow | PR-1…PR-6 | `tools/validate-public-release.ps1`; install-from-scratch verification; link-check | No fabricated imagery; no premature 1.0 | Version `0.2.0`; CHANGELOG reflects actual merges; README shows real TUI capture; all required checks green; publication itself remains a human-gated step |

PR sizing guidance honored: no campaign-mega-PR; each PR's tests run locally
(`npm run test:unit` subset + `test:ui` where touched) before push, and the five required
checks + trusted-control-plane gate the merge.

---

## E. Stop/Go Decision

**CAMPAIGN_READY_TO_EXECUTE**

Basis:

- Phase 0 baseline complete; every material claim verified against `main` @ `015c7b3`.
- All P1–P4 gaps are presentation/correctness extensions of existing canonical components —
  no new control planes, runtimes, or routing architectures required.
- No blocking external dependency: P1–P4 and P6 are fully delegable; P5 is delegable except
  the human-held private-key ceremony (covered by an exact operator checklist); P7's final
  publication (tag + GitHub Release) is irreversible and remains a human gate.
- Baseline typecheck on the campaign worktree is green; CI on main is green; zero open PRs.
- Working branch: `agent/daily-driver` (clean worktree at `origin/main`).

Execution begins with PR-1 (Model Intelligence operator surface).
