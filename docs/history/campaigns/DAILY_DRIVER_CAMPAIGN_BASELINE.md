<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-04
-->

# Daily Driver Campaign — Phase 0 Baseline

Campaign: **Reconciled Platform → Exceptional Daily Coding Agent**
Canonical audit of GitHub `main` at HEAD `015c7b374a3b2e67f7a5814508db0bd7f14ed263`
(`docs: canonical reconciliation final report (#140)`, pushed 2026-09-04).

Every claim below was verified against code at that SHA. Evidence is cited as
`path:line` relative to the repository root. Historical reconciliation documents
were treated as context only; each load-bearing claim was re-checked against code.

---

## 1. Canonical Repository State

| Item | State at audit time |
| --- | --- |
| Default branch | `main` |
| HEAD | `015c7b3` — canonical reconciliation final report (#140) |
| Open PRs | **0** |
| Recent merged PRs | #140 (final report), #139 (product/runtime consolidation on the canonical trust plane), #138 (TrustRootUpgradeV1), #137/#135/#134/#132/#131 (trust fixes), #133 (recovery + model-intelligence reconciliation), #127 (portable trusted launcher), #121 (trusted independent-review root) |
| Required checks (`protect-main` ruleset, active) | `security`, `public-content-policy`, `linux-validation`, `public-pr-metadata`, `windows-portability` (`.github/workflows/typecheck.yml`); `trusted-control-plane` (privileged `pull_request_target` workflow) |
| CI state on main | All recent Public Release Gate runs **green** (through #140); trusted-control-plane green since the trust-plane landing |
| Latest release / tag | **`v0.1.0` — 2026-07-23** (only release; other tag `pre-option-a-cutover`) |
| Package version | `babel-cli` `0.1.0` (`babel-cli/package.json:3`); **no npm package published** — source-clone install only (`README.md:139-148`) |
| Branch protection | Repo rulesets `protect-main` (active) and `protect-tags` (active); classic branch-protection API returns 404 ("Branch not protected") — rulesets are the enforcement mechanism |
| Local clone reconciliation | The pre-existing local clone sits on `codex/final-recertification-20260830` with uncommitted changes; that branch is **0 ahead / 25 behind** `origin/main` (fully merged ancestor). All campaign work proceeds from a clean worktree at `origin/main` on branch `agent/daily-driver`. Recovery-era worktrees were not used as sources of truth. |

---

## 2. Capability Classification

Legend: **ALREADY_COMPLETE** (implemented, production-usable) · **FOUNDATION_ONLY**
(infrastructure exists, lacks user/operator experience) · **PARTIAL** (exists with
material correctness/usability/platform gaps) · **MISSING** (does not exist) ·
**DEFER** (out of scope for this campaign).

| # | Capability | Classification | One-line verdict |
| --- | --- | --- | --- |
| 1 | Model Intelligence backend (profiles, registry, qualification, resolver, envelopes, routing receipts) | **ALREADY_COMPLETE** (as infrastructure) | 18-module typed library with 969-line adversarial test suite; consumed by runners, invisible to users |
| 2 | Model Intelligence operator surface | **FOUNDATION_ONLY** | `/model` `/policy` `/cost` `/status` exist but cannot answer why/health/fallback; idle UI can display a fabricated default model |
| 3 | Provider routing + waterfall execution | **ALREADY_COMPLETE** | OpenRouter-first live waterfall, per-tier retries, dynamic tier start from telemetry (`execute.ts`, `modelPolicy.ts`, `routingEngine.ts`) |
| 4 | Provider failure instrumentation (receipts, taxonomy, redaction) | **ALREADY_COMPLETE** (as infrastructure) | Hash-chained, causality-validated, secret-redacted receipts on every terminal inference; 13-class V1 taxonomy is dead code in production paths |
| 5 | Provider failure UX (what the user reads) | **FOUNDATION_ONLY** | Terminal failures surface as raw `[deepInfraApi] HTTP 401 …{body}` text; context overflow unclassified; fallback narration suppressed by default |
| 6 | Credential hub | **ALREADY_COMPLETE** | Single resolution point, provider→env-var mapping, fail-closed errors naming the exact env var without leaking values (`runners/credentialHub.ts`) |
| 7 | Chat execution lane | **ALREADY_COMPLETE** | Streaming ChatEngine with turn receipts, cost tracking, compaction, failover; 6,469-line engine, well tested |
| 8 | TUI rendering & interaction | **ALREADY_COMPLETE** | 44k-LOC custom ANSI renderer, ConPTY-aware degradation, two-region streaming, V2 composer with vim mode, 24-scenario cert suite |
| 9 | Chat session lifecycle (create/persist/resume/recover) | **ALREADY_COMPLETE** | Durable thread-store + event log + transcript, three-layer resume, checkpoint/restore/undo, crash-safe cost reset |
| 10 | Chat daily polish (vocabulary, help accuracy, evidence legibility) | **PARTIAL** | Governance vocabulary leaks into `/why-stopped`, `/ship`, `/evidence`, run summaries; help table drifts from dispatch; one dangling doc pointer |
| 11 | Windows core execution (spawn, kill, path jail, PATH, ConPTY) | **ALREADY_COMPLETE** | cmd.exe shim resolution, `taskkill /T /F` tree kill, case-insensitive path jail, junction tests, full required suite green on `windows-latest` CI |
| 12 | Windows verification path | **PARTIAL** (documented P1 debt) | Clean-room verifier cannot spawn `npm` on Windows (platform-skipped test, self-documented); `npx` post-edit check broken; env allowlist strips `Path` casing; wrapper-only kills orphan grandchildren |
| 13 | Evidence system (run bundles, evidence graph, completion gates) | **ALREADY_COMPLETE** (as infrastructure) | Crash-safe run bundles per run; evidence graph with producer identities; presentation skewed to operators |
| 14 | Trusted execution (supervisor assignments, branded read port) | **FOUNDATION_ONLY** | `authority/trustedExecutionSupervisor.ts` + port exist with tests but no CLI/runtime wiring — test-only consumers today |
| 15 | Trust plane verification (base-rooted gate, Ed25519 receipts, TrustRootUpgradeV1) | **ALREADY_COMPLETE** | Immutable base-rooted CI verification, signed receipts + single-use challenge ledger, boundary-tested, green in CI |
| 16 | Signed-review custody & operations (key provisioning, rotation, revocation, `BABEL_TRUSTED_REVIEW_ISSUER`) | **MISSING** | Repo's own P0 debt: no tooling or procedure; `BABEL_TRUSTED_REVIEW_ISSUER` appears nowhere in code; live tier is AUTONOMOUS |
| 17 | Independent review execution side (broker/provider/supervisor/issuer services) | **FOUNDATION_ONLY** | Present as services (`services/independentReview*` names in recovery-era branches); canonical main implements the protocol in `evidence/independentReview.ts` + `scripts/`; no operator-facing issuance surface |
| 18 | Model/routing observations & telemetry storage | **ALREADY_COMPLETE** (as storage) | `05_waterfall_telemetry.json`, `08_routing_decision.json`, session events, turn receipts; no user-facing viewer |
| 19 | Diagnostics (`/doctor`, `models ping`) | **PARTIAL** | Doctor checks env keys + workspace health; no route reachability/qualification/metadata-freshness readout; `models ping` exists but is live-gated and little-known |
| 20 | End-to-end coding evaluations | **PARTIAL** | Benchmark infrastructure exists (`services/agentBenchmark*.ts`, `swebenchProCampaign`, `evals/`, `benchmarks/`) but no reproducible daily-driver evaluation doc/suite with published results |
| 21 | Release automation | **MISSING** (by documented design) | Manual tagging only; `RELEASE.md` defers automation; two dead `test:public-release*` script refs in `package.json` |
| 22 | Release freshness | **PARTIAL** | `v0.1.0` (2026-07-23) vs main 2026-09-04: trust plane, TUI cert suite, dynamic routing, consolidation all unreleased; CHANGELOG `## Unreleased` backlog unregenerated |
| 23 | Installation workflow & docs accuracy | **ALREADY_COMPLETE** (source install) | README/CLI_QUICKSTART steps match reality (`npm --prefix ./babel-cli ci`, build, `doctor`); one stale getting-started doc uses a placeholder clone URL |
| 24 | Public product story (screenshots/recordings) | **MISSING** | No `docs/assets/`; README carries an explicit "do not fabricate imagery" TODO (`README.md:22`) |
| 25 | Test infrastructure | **ALREADY_COMPLETE** | 571 colocated `node:test` files in `babel-cli/src`, 10 PowerShell/MJS policy+trust suites in `tools/tests`, 5-job two-OS release gate |
| 26 | Context-envelope / retry-policy / treatment / attribution machinery | **ALREADY_COMPLETE** (as infrastructure) | `intelligence/` modules complete and tested; used by strict campaign paths only |
| 27 | Remote UI / daemon | **ALREADY_COMPLETE** (out of campaign scope) | TCP daemon on Windows, Playwright-verified remote UI in CI — **DEFER** for this campaign except where it touches daily UX |
| 28 | Voice dictation, plugins, MCP, workflows | **ALREADY_COMPLETE** (out of scope) | Present and tested; **DEFER** — do not expand this campaign |

---

## 3. Findings by Campaign Priority Area

### 3.1 Model Intelligence (Priority 1)

**What exists (strong):**

- Live production path: `babel-cli/src/modelPolicy.ts` (1,175 lines) — `ResolvedModelPolicy`
  with backend key, provider, providerModelId, tier, cost/run, warnings, waterfall,
  stage policies, context window, capabilities; metadata freshness validation with
  source/provenance (`modelPolicy.ts:601-644`).
- Intelligence library: `babel-cli/src/intelligence/` (18 modules) — lab specs,
  provider profiles with lifecycle + drift detection, versioned registry with
  `liveEligibility`, qualification probes Q0–Q7 (paid probes never implicit),
  execution envelopes that intersect model/provider limits, OpenRouter observation
  normalization (`intelligence/routing.ts:48-104`). 969-line adversarial test file.
- Dynamic Routing v1: `babel-cli/src/routingEngine.ts` scores recent run telemetry and
  reorders waterfalls; decision persisted to `08_routing_decision.json`.
- Per-turn routing receipts in Chat (`agent/turnRoutingReceipt.ts:28-61`), status-bar
  routing label (`Flash·mutate`), `/stats` winning-tier rows.

**What the user cannot answer today:**

| Question | Answerable today? |
| --- | --- |
| What model am I using? | Partially — and the **idle status bar defaults to a hardcoded `qwen3-32b`** (`interactive/repl/replSessionUi.ts:41`, `ui/renderers.ts:429-431`) that contradicts the live policy default route (`agent/chatModelPolicy.ts:38-41`) |
| Why was it chosen? | No — only run-bundle JSON (`debug_dynamic_routing_<stage>.json`) |
| Which provider/upstream serves it? | Barely — `/status` prints provider *model id* mislabeled "Provider" (`interactive/commands/info.ts:67-69`); OpenRouter upstream selection never surfaced |
| Is the route healthy? | No — doctor checks only "some provider key exists" (`doctor.ts:367-393`); qualification state has zero presentation anywhere |
| What fallback exists? | No — `/policy` prints flat rows, not stage order; fallback only as post-hoc verbose line |

Also: top-level command `models` is parsed (`cli/argv.ts`) but **has no handler** —
recognized token, missing implementation.

### 3.2 Provider Reliability UX (Priority 2)

**Instrumentation (complete):** runtime + durable V1 failure receipts
(`runners/providerFailureReceipt.ts`, hashed, redacted, causality-enforced in
`agent/sessionEvents.ts:926-965`), 13-class taxonomy with retry-safety helpers
(`providerFailureReceipt.ts:324-380` — currently production-dead), transport retries
(4 attempts, jittered backoff, Retry-After honored, `runners/deepInfraApi.ts:291-299`),
waterfall cascade signals, rate-limit quota widget (`ui/rateLimitWidget.ts`).

**What the user actually sees (broken):**

- Invalid credential → chat answer becomes ``[deepInfraApi] HTTP 401 (model): {200-char body}``
  (`runners/deepInfraApi.ts:987-1007` → `interactive/execution/chatEventDispatch.ts:91-101`).
  No "check `OPENROUTER_API_KEY`" hint, despite `credentialHub.ts` already producing
  exemplary missing-credential messages.
- Context overflow → **not classified end-to-end**: `providerNormalize.ts:25-38` can detect
  it but no production consumer in the live path; user gets a raw 400 body.
- Fallback → narration (`[babel:<stage>] Using backup route: cascading to X`) is gated by
  `verboseFallbackLogs` (`execute.ts:1475-1476`) which is **off by default in real runs**
  (evidence bundles present) — users can miss that a fallback happened at all.
- Retry exhaustion counts are recorded in receipts but never summarized for the user.
- Receipts are stored in `session-events.jsonl` with **no viewer command**.

### 3.3 Chat / TUI (Priority 3)

Overall this is the strongest area (see classification #7–#9: ALREADY_COMPLETE).
Verified polish gaps for the campaign:

1. **Governance vocabulary leakage** (worst offenders, user-visible strings):
   - `/execute-plan` → "Mutations allowed; force-mutate threshold elevated" (`interactive/commands/config.ts:209`)
   - `/why-stopped` → "check force_mutate / read thrash / phase-gate / shell thrash" (`agent/implementorPolicy.ts:575`)
   - `/ship` help → "Implementor ship dry-run (secret scan + evidence PR body)" (`interactive/types.ts:161-162`)
   - Plan/deep summary ends with literal "**Evidence:**" section (`cli/structuredOutput.ts:1512`)
   - Turn-start line "coding profile: quick_inspect (soft fuses, verify:none, HS:3t)" (`config/chatTaskClass.ts:542-567` via `execution/chat.ts:124`)
   - Review card "✓ verifier (exit 0)" (`ui/reviewCard.ts:264-269`)
2. **Help-table drift**: `/settings`, `/reverse-search`, `/thinking` dispatch but are not in
   `INTERACTIVE_COMMAND_GROUPS`; `/cancel` sits in the "Git" group; `/thinking` has a harmless
   double-`break` bug (`interactive/commands.ts:249`).
3. **Dangling pointer**: `/why-stopped` tip references `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md`
   which does not exist (`interactive/commands/info.ts:321`).
4. Diff after completion drops into a raw pager of the entire workspace diff — no per-file
   selection in the TUI (`ui/diffReview.ts:44-106`).
5. Windows Terminal capability flags (`BABEL_WINTERM_SYNC`, `BABEL_SCROLL_REGIONS`) are
   manual opt-ins only advertised in probe output (`ui/terminalProbe.ts:431-435`).

### 3.4 Windows Execution (Priority 4)

Core is genuinely first-class (full required suite green on `windows-latest`; ConPTY treated
as a first-class constraint across the TUI). Proven defects, ordered by impact:

1. **Clean-room verifier broken on Windows** — `execFileSync(structured.executable, …)` with
   no cmd.exe shim (`evidence/independentVerifier.ts:108-132`); test platform-skipped with
   documented reason (`agent/chatOpenCodeProvider.test.ts:440-443`); logged as P1 debt in
   `docs/reconciliation/BABEL_CANONICAL_RECONCILIATION_FINAL.md:146-149`.
2. **Case-sensitive env allowlist** — `utils/safeEnv.ts:14-26,101-105` uses `Set.has(key)`
   over raw env keys; children of sessions launched from cmd/PowerShell/Explorer (env keys
   `Path`, `SystemRoot`) get their PATH silently stripped → `cmd.exe /c npm test` fails.
   Launch-context-dependent; Git Bash sessions are unaffected, which is why CI is green.
3. **Wrapper-only kills orphan grandchildren** — `runners/cliBase.ts:159-175` (model-CLI
   timeout kills only the `cmd.exe` wrapper), same pattern at `tools/mcpTransport.ts:722,1104`,
   `bridge/sessionRunner.ts:213-215`, `services/knowledgeGraphIndexer.ts:137`; the existing
   `terminateChildTree` (`sandbox.ts:344-396`) is not reused.
4. **Docker fail-closed default** — `safe_repo` profile sets `dockerSandbox: true`
   (`config/executionProfiles.ts:115-117`); on Docker-less hosts without operator env vars,
   every pipeline `shell_exec`/`test_run` fails closed (`config/benchmarkContainer.ts:250-297`).
5. **`npx` post-edit check broken on Windows** — bare `execFileSync('npx',…)`
   (`agent/chatEngineSupport.ts:217`) fails without a `.cmd` shim.
6. **Ctrl+Z suspend throws ENOSYS on Windows** — `process.kill(pid,'SIGTSTP')`
   (`ui/waterfall.ts:390,1640`, `ui/keyInput.ts:876`); restore guard re-raises `SIGHUP`/`SIGQUIT`
   (`ui/terminalRestoreGuard.ts:47,208`).
7. **Shell-selection duplicated 5× with drift** — `sandbox.ts:723-732` (robust),
   `tools/ripgrep.ts:76-86` (mirror), `agent/backgroundShell.ts:84-86` (no existence check),
   `runners/cliBase.ts:125` and `tools/mcpTransport.ts:459` (hardcoded `cmd.exe`).
8. Minor: literal `/tmp` fallback on win32 (`lite/contract.ts:814,837`); benchmark
   governance command strings assume POSIX shell syntax (`services/agentBenchmark.ts:734,749`).

### 3.5 Signed Verifier Custody / Certified Review (Priority 5)

- **Verification plane: complete and CI-live.** Ed25519 signed `IndependentReviewReceiptV2`
  + supervisor-signed single-use challenge ledger with atomic consumption
  (`evidence/independentReview.ts:301-515`); PR-comment transport with fail-closed
  materialization (`scripts/materialize-independent-review-receipt.ps1`); base-rooted
  immutable CI verification (`trusted-control-plane.yml`, `scripts/trusted-merge-gate.ps1`);
  `TrustRootUpgradeV1` protocol replaces the retired PR-121 hard-code and is boundary-tested
  (`tools/tests/test-trust-root-boundaries.ps1`).
- **Operator plane: MISSING (repo's own P0 debt).**
  - `BABEL_TRUSTED_REVIEW_ISSUER` — zero occurrences in code; only mentioned as debt in the
    reconciliation final report.
  - `BABEL_REQUIRE_SIGNED_REVIEW` — read only by the gate (`agent-pr-gate.ps1:437`) from a repo
    variable; unset ⇒ the live tier is **AUTONOMOUS**.
  - No key generation/rotation/revocation tooling or procedure; public key registries exist
    (`config/trusted-supervisor-keys.json`, `config/independent-review-keys.json`), private
    custody is explicitly the owner's undocumented responsibility
    (`docs/architecture/TRUST_ROOT_BOOTSTRAP.md:21-25`).
  - Trusted-execution supervisor library (`authority/trustedExecutionSupervisor.ts`) has
    test-only consumers — no runtime wiring.
- **Constraint honored:** no private key will be placed in source, logs, prompts, or the
  builder environment. Whatever cannot be safely completed without human-held secrets ships
  as an exact operator bootstrap checklist.

### 3.6 End-to-End Evaluations (Priority 6)

- Infrastructure exists: benchmark governance harness (`services/agentBenchmark.ts`,
  `services/governanceBenchmark.ts`), SWE-Bench Pro campaign machinery
  (`services/swebenchProCampaign.ts`), `evals/`, `benchmarks/`, live qualification runners.
- **Missing:** a reproducible daily-driver evaluation suite + published methodology/results
  doc (`docs/evals/DAILY_DRIVER_EVAL_V1.md`), fixed comparable model/provider configurations,
  and machine-readable raw results. This phase depends on Priorities 1–4 for meaningful
  identity/routing metrics and reliable spawning on Windows.

### 3.7 Release Readiness (Priority 7)

- `v0.1.0` (2026-07-23) predates: the entire trust plane (#120–#140), the TUI daily-driver
  cert suite, Dynamic Routing v1, provider reliability receipts, product/runtime consolidation.
- CHANGELOG has a large unregenerated `## Unreleased` section; `RELEASE.md` (`last_verified:
  2026-07-22`) describes a generated-from-release-notes changelog process that hasn't run.
- Dead npm scripts: `test:public-export-regressions`, `test:public-release:security`,
  `test:public-release:security:local` reference non-existent `tools/*.ps1`.
- No screenshots/recordings; README explicitly forbids fabricating imagery (`README.md:22`).
- Install docs accurate for source install; Node 22.5+ engine requirement documented.
- Next version: **`v0.2.0`** is the defensible target (pre-1.0, additive UX + platform fixes,
  no breaking CLI contract change identified); 1.0 is not justified by an objective readiness
  bar and remains out of scope.

---

## 4. Known Technical Debt Register (verified)

From the repo's own reconciliation final report §8, re-confirmed at `015c7b3`:

| Priority | Debt | Verified location |
| --- | --- | --- |
| P0 | Signing custody for CI (`BABEL_TRUSTED_REVIEW_ISSUER` / supervisor lane) unprovisioned | no code; `docs/architecture/TRUST_ROOT_UPGRADE.md:166-168` calls forced signing "steady state once custody is provisioned" |
| P1 | Windows POSIX-biased verifier child-process shape | `evidence/independentVerifier.ts:108-132`; test gate `agent/chatOpenCodeProvider.test.ts:440-443` |
| P1 | Autonomous-evidence fail-closed error codes; numstat-digest doc | `scripts/agent-pr-gate-common.psm1` |
| P2 | Windows local full-suite ordering flakes (MCP transport init ordering; liteIndex warmup) | reconciliation final report §8 |
| P2 | Docker-dependent smallFix cases | `services/agentBenchmark*` |
| New (this audit) | `safeEnv` case-sensitive allowlist strips `Path`/`SystemRoot` | `utils/safeEnv.ts:14-26,101-105` |
| New (this audit) | Wrapper-only timeout kills orphan grandchildren | `runners/cliBase.ts:159-175` + 3 more sites |
| New (this audit) | Fabricated idle model default `qwen3-32b` | `interactive/repl/replSessionUi.ts:41`; `ui/renderers.ts:429-431` |
| New (this audit) | `models` CLI token parsed with no handler | `cli/argv.ts:5-56` |
| New (this audit) | Dead `test:public-release*` npm scripts | `babel-cli/package.json:69,72-73` |
| New (this audit) | Dangling `/why-stopped` doc pointer | `interactive/commands/info.ts:321` |
| New (this audit) | `/thinking` double-`break` | `interactive/commands.ts:249` |

Only 2 real `TODO:` comments exist in `babel-cli/src` (legacy ChatMessage path migration,
daemon stdin forwarding) — the repo enforces TODO-free generated code, so debt is tracked
in curated docs rather than inline.

---

## 5. Product-State Assessment (campaign scale)

| Area | Rating | Justification |
| --- | --- | --- |
| Model Intelligence UX | **WEAK** | Backend exceptional, operator surface nearly absent; wrong default model displayed; qualification state has zero presentation |
| Provider reliability UX | **WEAK** | World-class receipts invisible to users; raw 401/400 bodies as chat answers; context overflow unclassified; fallback narration off by default |
| Chat UX | **ACCEPTABLE** | Strong core (streaming, cancel, resume, diffs, cost) with vocabulary leakage and help drift |
| TUI quality | **STRONG** | 44k-LOC renderer, ConPTY-aware, resize-safe, 24-scenario cert suite, vim composer |
| Windows support | **ACCEPTABLE (borderline)** | Core + CI genuinely first-class; verification path and several spawn/kill sites carry proven defects |
| Trust/certification operations | **WEAK** (verification plane STRONG) | Gate green in CI, but zero operator tooling/procedure; AUTONOMOUS tier is the live default |
| Evaluation maturity | **WEAK** | Benchmark machinery exists; no reproducible daily-driver eval suite or published results |
| Release readiness | **WEAK** | 6-week-stale release, unregenerated changelog, no imagery, dead scripts, no release automation |

---

## 6. Explicit Non-Goals (DEFER)

- Remote UI / mobile surface (verified working; CI-covered) — touch only where daily UX overlaps.
- Voice dictation, plugins, MCP catalog expansion, workflow DAG features.
- Any second model-ranking system, new control plane, parallel runtime, or new routing
  architecture — the existing `modelPolicy.ts` + `intelligence/` + `routingEngine.ts` stack
  is canonical.
- Any redesign of the trust plane — `TrustRootUpgradeV1` and the review protocol are
  canonical absent a proven concrete defect.
- macOS parity claims — no evidence gathered in this audit; no claims will be made.
- npm publication — no publish infrastructure exists by design; source install is the
  supported path this campaign.

---

## 7. Baseline Verification

- Repository HEAD audited: `015c7b374a3b2e67f7a5814508db0bd7f14ed263`.
- GitHub state via `gh` CLI: PRs, releases, runs, rulesets (2026-09-04).
- Five read-only deep audits executed against the clean `agent/daily-driver` worktree:
  Model Intelligence, provider reliability, Chat/TUI, Windows, trust/tests/release.
- Baseline typecheck of the worktree: see `DAILY_DRIVER_CAMPAIGN_STATUS.md` §Verification Log.

No product behavior was modified in Phase 0.
