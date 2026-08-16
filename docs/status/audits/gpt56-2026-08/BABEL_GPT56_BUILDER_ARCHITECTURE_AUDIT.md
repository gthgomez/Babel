# Babel Architecture Audit — Against the GPT-5.6 Builder's Guide

**Status**: READ-ONLY AUDIT — deliberately **uncommitted** (repo policy: audits are evidence, not ship artifacts).
**Date**: 2026-08-15
**Base commit**: `d92c02dbbc5bd5fb9940646fcb7a0aad2b70021c` on `fix/session-event-lifecycle-identity` (dirty worktree: `.agents/rules/09`, `.gitattributes`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `babel-cli/CLAUDE.md`, `babel-cli/src/config/chatTaskClass.ts` modified; untracked: `.agents/rules/10-autonomy-policy.md`, `.claude/`, `.cursor/`, `artifacts/`, `babel-cli/src/config/autonomyPolicy.ts` + test).

---

## 0. Freeze record & method

| Item | Value |
|------|-------|
| Repository root | `<REPO_ROOT>` (public canonical `gthgomez/Babel`) |
| Branch | `fix/session-event-lifecycle-identity` |
| Commit SHA | `d92c02dbbc5bd5fb9940646fcb7a0aad2b70021c` |
| Working tree | DIRTY (policy-work in flight; autonomy policy files untracked) |
| Node | v24.12.0 · npm 11.19.0 |
| Git | 2.49.0 · PowerShell 7.6.3 |
| Audit mode | Search/read/static inspection + targeted unit test execution. No installs, no lockfile mutation, no commits, no pushes, no external calls, no spend. |

**Status tags** used throughout (per audit rules): `DOCUMENTED` (mentioned in docs) · `IMPLEMENTED` (code exists) · `TESTED` (assertions exist) · `EXERCISED` (observed in real runs on disk) · `EXPERIMENTAL` (implemented but gated/opt-in/unwired) · `PLANNED` (documented as future) · `ABSENT` (no evidence).

**Evidence conventions**: every load-bearing claim carries a `file:line` or test name. Where a claim is asserted by code but not executed during this audit, it is tagged accordingly. The new `src/config/autonomyPolicy.ts` module was **executed during this audit**: `npx tsx --test src/config/autonomyPolicy.test.ts` → 16/16 pass.

**OpenAI-side sourcing caveat (disclosed)**: the primary page `https://openai.com/index/builders-guide-to-gpt-5-6/` returned HTTP 403 (bot-blocked) and was not directly fetchable from this environment. Guide-level claims were recovered from two independent secondary summaries and **every mechanism was independently cross-verified on live official pages** (`developers.openai.com` / `openai.github.io`) — 17 pages fetched, listed in §19. Anything not verified on a live official page is flagged `UNVERIFIED` inline. In particular, `budget_tokens` is **not** an OpenAI parameter in current docs (it is Anthropic's `thinking.budget_tokens`) and should not enter a neutral contract.

---

## 1. Executive Verdict

### `TARGETED_IMPROVEMENTS`

Babel is **not** behind the GPT-5.6 guide's architectural lessons on most axes — it is ahead on several. The guide's three headline interventions (retained reasoning + native compaction, multi-agent orchestration, programmatic tool calling) map onto mechanisms Babel has already built in provider-neutral form: an **H1 compaction commit with an opaque state capsule** (`compactionCommit.ts`, `providerCapabilities.ts`), **harness-managed subagents with worktree isolation** (`agentTeams.ts`, `implementWorktreeAgent.ts`), and **deterministic orchestration code** (gates, kernels, receipts, waterfalls — the guide's own recommendation that deterministic code beats model-driven loops for predictable flow).

The verdict is `TARGETED_IMPROVEMENTS` — not `MAJOR_ARCHITECTURAL_OPPORTUNITY` and not `MOSTLY_ALREADY_ALIGNED` — because four evidence-backed gaps sit exactly on the guide's axes:

1. **Prompt construction is cache-blind** (no stable-prefix discipline, no cache-region markers; only passive accounting) while the guide makes exact-prefix caching a first-order cost lever (0.1× cached input pricing).
2. **The autonomy policy's deterministic spine is unwired**: `classifyAutonomyAction` (Class C/D command patterns) has **zero live consumers**; C/D presets (`ask_before_mutation`/`read_only`) are documented seams, not applied. `git push --force` and `cat .env` execute ungated inside Babel's own runtime today.
3. **The shared provider contract is OpenAI-shaped, and the live lane is DeepSeek-only** — provider-neutrality is aspirational, not structural. Capability negotiation exists (`providerCapabilities.ts`, Capability Broker) but defaults are inferred from model-name heuristics, not announced by providers.
4. **Routing evidence supports tier reordering only** — 652 telemetry entries justify the existing waterfall reorder; nothing justifies automatic provider/model routing (SWE-Pro campaign: 121 cells, **zero live agent passes**).

The central architectural question (model router vs capability-aware execution environment) resolves decisively from evidence: **Babel already is — and should remain — the latter.** It has durable authoritative state, deterministic verification, capability records, and policy layers. It should *expose and negotiate* provider capabilities (reasoning continuity, effort, caching, compaction) rather than absorb provider shapes or become an eval-driven router.

---

## 2. Current Babel Architecture (evidence-based)

**Layers** (from `CLAUDE.md`, verified against code): control plane (prompt layers → compiled instruction stacks), runtime (`babel-cli/` TypeScript), support (`tools/`, `docs/`, `.agents/`). The runtime has a normative spec: `docs/architecture/HARNESS_ARCHITECTURE_V1.md` (CANONICAL, `harness-v1`), a subordinate roadmap (`HARNESS_HARDENING_ROADMAP_V1.md`, H0–H7), and ADRs 0001–0013.

**Task flow**: `runBabelPipeline` (`src/pipeline.ts:1023`) → orchestrator stage (`buildOrchestratorTask`, `runWithFallback`) → mode dispatch `plan | chat | deep | swarm` (`pipeline.ts:1908`) → executor/chat loops. Interactive path: `chatCore.ts` → `ChatEngine` (`src/agent/chatEngine.ts`, ~5,200 lines) → `deliberateTurn` → runner. Every stage goes through `runWithFallback` (`src/execute.ts:1741`) with per-stage tier waterfalls sourced from `config/model-policy.json`.

**Providers**: shared interface `LlmRunner` (`src/runners/base.ts:228`) — `execute<T>(prompt, schema, callbacks?, systemPrompt?)` plus optional `executeWithToolsStream`. **Live**: `DeepSeekApiRunner`, `DeepInfraApiRunner`, `OllamaApiRunner` (OpenAI-compatible chat-completions). **Dormant legacy**: `OpenAiApiRunner` ("Structural Backup — Tier 2"), `ClaudeCliRunner`, `CodexCliRunner`, `GeminiCliRunner/Api`, `OpenRouterApiRunner`. Live routing hard-filters to DeepSeek (`execute.ts:1783-1790`); `assertDeepSeekLiveModelId` caps live models to `deepseek-v4-flash`/`deepseek-v4-pro` (`src/modelPolicy.ts:21-38`). Every vendor family in `model-policy.json` (Codex/Gemini/Claude/DeepSeek) maps to DeepSeek backends.

**State**: durable event-sourced `ThreadEventLog` (`src/agent/threadEventLog.ts`) is the authoritative record; the provider message array is **rebuilt from events every turn** (`rebuildProviderMessagesFromEvents`). Dual-written `session-events.jsonl` (25 event kinds incl. tool lifecycle, gates, approvals, compaction, failover, repairs; `src/agent/sessionEvents.ts`) and hash-linked `episode-events.jsonl` (`src/evidence/episodeStream.ts`, SHA-256 `prevHash` chain). Run dirs under `runs/` hold `EvidenceBundle` artifacts (manifest, telemetry, cost ledger, verifier plan/summary, terminal status). Session resume is fail-closed with causality assertions (`sessionRunValidator.ts`, `sessionEventDiagnostics.ts`).

**Verification**: `kernel.completion.decide` (`src/executor/kernel.ts:141-203`) is the sole completion authority; `VERIFIED_COMPLETE` requires `gate.allow && proof.compliant`, else downgrade to `UNVERIFIED_PATCH`. Honesty gate (`completionGatePolicy.ts`) with adversarial signals (`tests_deleted`, `shortcut_noop`, `hardcoded_fixture`, `flaky_green`, `verifier_def_tampered`), verifier promotion gate (14 denial reasons, `verifierKernel.ts`), agent-owned `_verify*` probe rejection, revision-bound receipts (`evidence/revisionBoundReceipt.ts`), verifier-definition tamper hashing (`verifierIntegrity.ts`), clean-room verifier (opt-in), diff critic (second-LLM patch review).

**Autonomy**: Class A–D taxonomy (`.agents/rules/10-autonomy-policy.md`; canonical external contract `AGENT_AUTONOMY_POLICY.md` is **not in the repo** — session-supplied). New native module `src/config/autonomyPolicy.ts` (untracked, TESTED 16/16) maps classes onto task tunes, permission presets, approval sessions, and the completion gate. Enforcement today: task-class tune + completion gate + approval sessions + Claude-Code-harness credential deny/hook + CI gates. **Not wired**: action classifier, C/D presets.

**Worker selection**: explicit `--model` override → orchestrator-produced `assigned_model` (LLM-produced field validated against `TargetModelSchema`) → per-stage waterfall from config → dynamic reorder of *tier order only* (`src/routingEngine.ts`, min 3 samples, opt-out `BABEL_DYNAMIC_ROUTING=false`).

**Context**: three compaction mechanisms (H1 LLM-summarize + heuristic fallback; pipeline step-level log pruning; opt-in LLM file stubbing) + turn summaries; tool-result char caps per path; budgets (`maxTurns 200`, `maxCostUsd $2`, `maxWallMs 10 min`, `maxEstimatedTokens 128k`); task re-injected every turn and frozen into `CompactionCapsule`.

---

## 3. What Babel Already Gets Right

(Evidence-cited; deliberately not inflated.)

1. **Completion is never the model's word alone** — TESTED: `kernel.test.ts` asserts an incomplete proof is rejected "even with a green verifier"; `proofCarryingCompletion.test.ts` asserts `VERIFIED_COMPLETE` requires claim coverage + valid evidence-graph nodes. The model's `finish` tool only logs a claim; the terminal outcome is computed and gated (`chatEngine.ts:3017`, `kernel.ts:171-202`).
2. **False-completion is a first-class, mechanically detected state** — adversarial signals and a 14-reason promotion gate (`completionGatePolicy.ts:45-114`, `verifierKernel.ts:181-308`); benchmark scoring defines `falseComplete = claimedComplete && mutationOk && !verifierOk` (`agentBenchmark.ts:423`).
3. **Durable authoritative state is separated from model memory** — task contract with frozen hash (`taskContract.ts`), `CompactionCapsule` carrying changedPaths/verifierFreshness/workspaceRevision/evidenceRefs through compaction, revision-bound receipts, event-sourced history with `MODEL_VISIBLE_EQUALS_PERSISTED` invariant (`runtimeInvariants.ts`). The exact "don't entrust to model memory" list from this audit's §7 exists as code.
4. **Compaction preserves what matters and is honest about what it drops** — never compacts the system prompt or task, keeps tool pairs, immutable SHA-256 `obs:` refs for dropped messages (`compactionCommit.ts:107-113`), rollback on persistence failure, `measureCriticalFactRetention` H1 exit gate.
5. **Isolated execution is real** — path-jailed SafeExecutor with symlink/credential denial (`sandbox.ts:1048-1283`), Docker fail-closed isolation (`benchmarkContainer.ts`), git worktrees with snapshot/rollback promote gates (`worktreeIsolation.ts`, `worktreeSafety.ts`, `implementWorktreeAgent.ts`).
6. **Parallelism is conservative and contention-aware** — only consecutive reads parallelize (`chatEngine.ts:3329`); mutations sequential; overlapping write scopes rejected before worktree creation (`agentTeams.ts:357-361`); per-child AbortControllers (`agentRunCoordinator.ts:91`); tool identity stable across out-of-order completion (commits `7bf95c2`, `d92c02d`, `toolExecutionIdentity.ts`).
7. **The session/evidence spine is exceptionally honest** — hash-chained episode stream, fail-closed resume, admission that clean-room verification is opt-in and CI runs only harness subsets. Docs say what is NOT implemented (V1 §6.3.x gaps; ADR-013 deferral).
8. **Capability records exist with provenance** — `ProviderCapabilities` per model with context-window budget formula, `CapabilityProvenance` (`policy|provider|provider_default|unknown`), and a Capability Broker (PARTIAL per V1 §6.3.4).
9. **Cost/latency budgets are enforced, not decorative** — budget kill policy, stall detectors, per-task-class tunes, DeepSeek stall multiplier, cost confirmations on expensive runs (`pipeline.ts:1963-1998`).
10. **Failover is honest about what it isn't** — `decideProToFlashFailover` sets `countsAsVerification: false` (`providerCapabilities.ts:330`); retryable-failure classification is deterministic.

---

## 4. Highest-Value Gaps (ranked)

| # | Gap | Evidence | Impact |
|---|-----|----------|--------|
| G1 | **Autonomy classifier & C/D presets unwired** — Class C/D enforcement is prose + task-tune only; `classifyAutonomyAction` has no live consumer; `chatEngine.ts:4129-4136` hardcodes `workspace_write` for non-plan; `BABEL_BENCHMARK_AUTO_APPROVE=1` bypasses asks; `cat .env` / `git push --force` execute ungated in the runtime | `autonomyPolicy.ts:151-179` (grep: tests only), `toolExecutor.ts:742`, `chatEngine.ts:4129-4136`, `chatApproval.ts:118-121`, `policy.ts:64-70` | Policy claims ≠ enforcement; Class-D session can still mutate files (`autonomyPolicy.ts:281-285` claim vs wiring) |
| G2 | **Cache-blind prompt construction** — no stable-prefix layout discipline, no cache-region markers, no cache-key affinity; caching is passive provider KV only; cost tracker ignores cache pricing (`costTracker.ts:68-77` vs `modelPricingRegistry.ts:191-202`) | grep `cache_control|cacheControl|prompt_cache|ephemeral` → zero construction-side hits; `providerMessages.ts:37-76` | Token/cost waste on every turn of every long session; wrong cost telemetry |
| G3 | **Live lane is DeepSeek-only; shared contract is OpenAI-shaped** — "provider-neutral" is aspirational; `LlmRunner` messages/tools mirror OpenAI shapes; adapters for OpenAI/Claude/Gemini dormant | `base.ts:170-226`, `execute.ts:1783-1790`, `modelPolicy.ts:21-38`, `config/model-policy.json:39-86` | Capability negotiation can't express provider differences (reasoning carriers, caching, effort) without shape leakage; multi-provider claim unverifiable |
| G4 | **No reasoning-effort dial** — `reasoning_effort`/effort levels absent; `thinkingWithTools: 'unsupported'` for deepseek recorded but no per-task effort mapping; task classes tune budgets, not inference compute | `providerCapabilities.ts:61-131`, `chatTaskClass.ts` TUNES | Misses the guide's cheapest lever (effort escalation, Sol-at-low > predecessor-at-high); no per-provider effort mapping |
| G5 | **No provider-native continuation** (reasoning carriers, `previous_response_id`, conversation objects) — full history re-sent every turn; identity is internal-only | grep → only internal IDs; `threadEventLog.ts:283-341` rebuild-every-turn | Token waste on long sessions; can't ride provider-side retained reasoning when it arrives; but stateless-by-design (ADR-004) is defensible — see §15 |
| G6 | **Routing evidence insufficient beyond tier reorder** — 652 telemetry entries, 121 SWE-Pro cells with **0 live passes**; no task-class×worker success tables | `runs/*/05_waterfall_telemetry.json` (652 entries), `runs/agent-benchmark/swe-pro/*/campaign-report.json` | Automatic model/provider routing is NOT evidence-justified (see §11) |
| G7 | **Deterministic reduction of model-bound evidence is shallow** — tool results are char-trimmed (1000–3000), not parsed/aggregated/deduplicated; no normalized evidence envelope | `chatToolDefinitions.ts:661-688`, `chatEngine.ts:4383-4420`, `utils/truncate.ts:36-43` | Every test/lint/diff dump re-enters context as raw text; tokens × distraction × hallucination surface |
| G8 | **No general config-drift detection mid-run** (only verifier-def tamper R9 + contract hashes) | `verifierIntegrity.ts`, absence of other detectors | Silent policy/schema drift during long runs undetected |
| G9 | **Two token estimators disagree** — js-tiktoken `o200k_base` (pipeline) vs 4-char/token heuristic (compaction); compaction decisions use the heuristic | `services/tokenCounter.ts:8`, `chatCompaction.ts:97-106` | Compaction may trigger late/early vs true budget |
| G10 | **Independent verification is default-off** — clean-room `BABEL_INDEPENDENT_VERIFIER=1` opt-in; diff critic default-on only headless/CI; no heterogeneous (cross-provider) reviewer exercised | `evidence/independentVerifier.ts:76-94`, `diffCritic.ts:81-88`, V1 §6.8 | Interactive runs lean on deterministic gates alone; the guide's multi-model independence lesson untested |
| G11 | **Harness doc staleness** — V1 §6.12 lists durable compaction as priority gap #1 while §2 marks H1 IMPLEMENTED | `HARNESS_ARCHITECTURE_V1.md` §2 vs §6.12 | Roadmap/priority confusion for implementers |
| G12 | **Approval ledger not durable per-request** — in-memory history + `policy-events.jsonl` only | `approvalRequests.ts:48-59`, `chatEngine.ts:3052` | Post-hoc audit of who-approved-what is partial |

---

## 5. GPT-5.6-Specific Opportunities (provider-specific — keep provider-specific)

Verified against live official docs (URLs in §19). Each is listed with its provider mechanism and the neutral lesson; do **not** lift the mechanism into core.

| Provider mechanism | Official status | Babel relevance |
|---|---|---|
| `reasoning.context` (`auto`/`current_turn`/`all_turns`) + encrypted reasoning items | GPT-5.6 family supports `all_turns`, uses by default; older models `current_turn`; reasoning items are encrypted, opaque | Babel would need an **opaque carrier** lane in its message model to ride this when an OpenAI live adapter exists. Not needed for DeepSeek lane |
| Server-side compaction (`context_management` + `compact_threshold`, in-stream encrypted compaction item, `POST /responses/compact`) | Compaction is machine state, not human summary; pass-through unchanged | Babel already has client-side compaction with the same "carrier is opaque" philosophy (`CompactionCapsule`). A future OpenAI adapter can map its compaction item onto Babel's capsule lane |
| Prompt caching: exact-prefix, ≥1024 tokens, 0.1× cached / 1.25× write, **explicit** `prompt_cache_breakpoint`/`prompt_cache_options` (not `cache_control`) | Verified on official caching page | Neutral lesson (layout discipline + region markers) is directly applicable to Babel's prompt construction — this is a G2 fix |
| `programmatic_tool_calling` (hosted V8) | Official guidance: deterministic code for predictable flow; **direct tool calling for side-effects/approvals to preserve the authorization boundary**; app-level approval regardless of caller | Babel does NOT need a hosted JS runtime. Its deterministic gates/waterfalls/receipts already implement the same principle in harness form. The guide's rule of thumb validates Babel's design |
| `needs_approval`, `ToolApprovalItem` interruptions, resumable `state.approve()/reject()` | Approval is a run-lifecycle state with pause/resume, sticky decisions, fail-closed review | Babel's approval sessions (`allow_once`/`allow_session`/`narrow_rule`, headless deterministic deny) cover the same ground — **except** pause/resume of the run is re-entrant rather than provider-state-resumed (fine; harness-owned is the neutral form) |
| Subagents: `Agent.as_tool()` vs handoffs | Decision rule: *who owns the final answer*; code-based orchestration for determinism; "limit unnecessary subagent calls" | Babel's harness-managed subagents with write-scope ceilings implement the neutral topology; no provider-native subagents (by design, §9) |
| Tiered family `gpt-5.6-sol/terra/luna` + `reasoning.mode: "pro"` | Model selection = resource scheduling; accuracy first, cost second; effort escalation cheaper than model size | Babel's tier concept exists (`cheap|standard|triage|fallback|escalation`) but tiers are single-vendor now; effort dial missing (G4) |
| Reasoning effort (`none..max`; `low` for tool-use, `medium` default, `high` for hard reasoning) | "A tuning knob, not the primary way to recover quality" | Neutral principle: per-task effort knob with per-provider level mapping — G4 |
| Eval ladder: trace grading → dataset evals with deterministic graders | **Evals platform deprecated** (read-only 2026-10-31, shutdown 2026-11-30; Datasets recommended) | Babel's `harnessEval.ts` (offline factorial, promotion records) already implements the neutral form; do NOT bind to OpenAI evals API. Babel's evals are not CI-wired (G6-adjacent) |
| Tracing: traces + nested spans, default-on, custom exporters, sensitive-data redaction | Verified | Babel's `episode-events.jsonl`/session events are the same concept, provider-native and already dual-written. No change needed |

**`UNVERIFIED` flags**: `budget_tokens` (not an OpenAI parameter — Anthropic's; do not design around it). Guide headline numbers (ARC-AGI-3 13.3%→38.3%, BrowseComp Luna $1.33 vs $33.27, Sol-at-low > GPT-5.5-at-high on Agents' Last Exam) come from secondary sources only — treat as directional evidence, not spec.

---

## 6. Provider-Neutral Architectural Opportunities

1. **Stable-prefix prompt construction** (fix G2): freeze policy/instructions/schemas in a fixed order ahead of per-turn variable content; add a cache-region abstraction (`stable_head` / `dynamic_tail`) the adapter can map to provider cache controls when they exist. Provider-neutral: *prompt-layout discipline* + *cache-region markers* + *cache-aware accounting*.
2. **Capability negotiation completes the existing record** (fix G3 partially): `ProviderCapabilities` already has provenance; extend the Capability Broker (V1: PARTIAL) so adapters *announce* capabilities (reasoning carriers, effort levels, caching, compaction, native continuation) instead of name-heuristic defaults. Core consumes capabilities; adapters provide them. This is the correct non-coupling shape.
3. **Opaque state-carrier lane** (G5, future): a `carriers[]` field on the message model that adapters may fill with provider-native opaque items (reasoning items, compaction items) with a strict pass-through, never-edit contract. Zero effect on current DeepSeek lane; unblocks GPT-5.6 when a live OpenAI adapter returns.
4. **Normalized evidence envelope** (G7): a deterministic reducer that parses test/lint/typecheck/diff output into `{summary, failed[], passed_count, exit_code, rev}` before it reaches the model — the guide's "return a smaller structured result" principle, harness-native, no hosted runtime needed.
5. **Per-task effort/verification dial** (G4): map task classes to a provider-neutral effort level (`low|medium|high`) with per-adapter translation (DeepSeek: thinking on/off today; OpenAI: `reasoning_effort` when live).
6. **Independent review as a scheduled, bounded capability** (G10): treat reviewer/clean-room passes as budgeted stages (like the guide's "scheduling rules" for subagents) rather than opt-in flags.

---

## 7. Verification / False-Completion Analysis (explicit)

The audit's required distinction exists **structurally but not by name**:

| State | Babel equivalent | Evidence |
|---|---|---|
| `worker_claim_success` | `requestedOutcome` / model `finish` tool | `chatEngine.ts:3835` (logs claim only), `kernel.ts:181` |
| `visible_checks_pass` | green verifier receipts (authoritative, revision-bound) | `verifierKernel.ts:23-54`, `revisionBoundReceipt.ts` |
| `contract_checks_pass` | proof compliance + claim coverage + evidence-graph validity | `kernel.ts:180`, `evidence/completionEvidence.ts`, `acceptanceContracts.ts:18-36` |
| `independent_review_pass` | diff critic + clean-room (opt-in) | `diffCritic.ts`, `independentVerifier.ts` |
| `verified_success` | `VERIFIED_COMPLETE` (only when gate.allow ∧ proof.compliant) | `kernel.ts:180-196` |

**Can Babel detect `{claim=true, visible=true, contract=false}`?** Yes — this is exactly the promotion gate: `authorize_verified_complete` requires zero denials (incl. `targeted_cannot_satisfy_full`, `wrong_revision`, `tampered_verifier_def`) AND a green receipt (`verifierKernel.ts:290-308`). TESTED (`kernel.test.ts:48,70,85`). The state Babel names is `completion_downgraded` → `UNVERIFIED_PATCH`.

**Captured per run**: worker claim (toolCallLog), visible tests (receipts with exit codes, stdout/stderr hashes, scope, flake history), contract checks (promotion gate, task-contract hash), changed files (mutation batches), unexpected config mutations (verifier-def tamper only — G8), review result (diffCritic verdicts, review lanes), environment/provider/harness failures (terminal outcomes `INFRA_FAILURE`/`AGENT_FAILURE`/`BLOCKED_*`), timeout/budget (`BUDGET_EXHAUSTED`), cost/token/duration (telemetry, cost ledger, stall state).

**Gaps in capture**: (a) no durable per-request approval ledger (G12); (b) no general config-drift detection (G8); (c) `worker_claim_success`/`verified_success` terminology absent — the distinction is encoded in three different names across files; naming it once would help benchmarking and post-hoc analysis (cheap, P2).

---

## 8. Context and Reasoning-State Analysis

**What the provider sees each turn** (native path): full structured `ProviderMessage[]` rebuilt from the event log — system prompt (regenerated per turn, in-memory cached), compaction capsule if present, full history, current task. Text path: entire conversation flattened into Markdown prose (`chatToolDefinitions.ts:537-573`) — a protocol violation by Babel's own validator (`providerMessages.ts:95-101`). **Full history is re-sent every turn, every time.** Provider-native conversation IDs / `previous_response_id` / reasoning carriers: **ABSENT** (internal session IDs only).

**What Babel retains**: event-sourced thread log (authoritative), session events, capsule, receipts, workspace revision. **What is discarded**: messages reduced by compaction (with immutable `obs:` digests), tool logs beyond per-path caps, pre-compaction reasoning (none exists — providers are stateless-by-design per ADR-004).

**Reconstruction cost**: `rebuildProviderMessagesFromEvents` re-derives the wire request from events each turn; `assertNativeRequestMatchesDurable` re-derives it *again* for the invariant check (`chatEngine.ts:2917-2939`). Deterministic, but adds CPU and means every turn pays full input tokens — the single largest recurring token cost. For a 1M-token window (deepseek-v4) the practical trigger is `maxEstimatedTokens` 128k default, so compaction fires well before the model limit.

**Likely waste identified**:
- Full re-send every turn (bounded only by compaction at ~128k); cache-blind ordering (G2) means even the stable head may not hit provider KV caches optimally.
- Tool results char-trimmed but not reduced (G7): repeated `pytest`/`npm test` outputs with 90% identical tails re-enter context verbatim each iteration.
- Two estimators disagree (G9); compaction decisions use the rougher one.
- Text-path flattening (legacy surface) duplicates structure in prose.

**Task-constraint safety**: strong — task re-injected each turn (`chatToolDefinitions.ts:558-559`), frozen into the capsule, system prompt never compacted, tool pairs preserved. Original-constraint loss via truncation is effectively mitigated.

**Cognitive vs authoritative**: the distinction exists as code (capsule + receipts + event logs vs model-visible summaries). Verdict: mostly solved; the residual risks are the estimator inconsistency and missing provider-side continuation for long sessions.

## 9. Multi-Agent Analysis

**Harness-managed heterogeneous agents (Babel's actual design)**: `sub_agent` tool with `write_scope`/`mutation`/per-agent `model` override (`chatToolDefinitions.ts:1155-1177`); team specs with `isolation: copy|git_worktree|none` and `merge_strategy: auto_disjoint|manual|review_only` (`agentTeams.ts:73-91`); worktree-isolated implement children with parent-cleanliness gates (`implementWorktreeAgent.ts`); disjoint-scope conflict rejection before any worktree exists (`agentTeams.ts:357-361,945-963`); read-only research delegation per rule 07. `awaitAll()` is explicitly a no-op barrier today (`agentRunCoordinator.ts:210-215`) — concurrency is mostly sequential fan-in, not concurrent fan-out.

**Provider-native homogeneous subagents (OpenAI Agents SDK)**: ABSENT by design — `openAiApi.ts` is a plain chat-completions loop; no Agents SDK anywhere. `babel-cli/CLAUDE.md:41-44` states the design: Babel runs its own loop and does not delegate tool execution.

**What each is good for** (guide's decision rule: *who owns the final answer*):
- Provider-native subagents: cheap when the provider already holds conversation state and you trust one vendor's orchestration; correlated errors and no independence across models.
- Harness-managed heterogeneous agents: independence of review, per-agent provider/effort choice, uniform write-scope/approval ceilings, worktree isolation. Costlier; must schedule (bounded) — Babel already bounds: read-only max 4 rounds, mutation 8 (`chatToolDefinitions.ts`).

**Verdict**: do not add provider-native subagents to core. Keep harness-managed as the one topology; optionally expose provider subagents as a *capability* an adapter could offer (map `sub_agent` onto it) — provider-neutral: the tool exists, the backend negotiates. Priority P3, only when a live non-DeepSeek adapter demands it.

**Parallelism risks audited**: concurrent-edit corruption is defended (worktree + scopes + sequential mutations); "consensus without independence" does not exist as a pattern in runtime code (no voting — aggregation weights in `Parallel-Swarm-Governance-v2.md` are advisory prose, no implementation); correlated-error risk is minimal because independent review today is a single second-model critic, not a correlated swarm. Expensive redundant work is bounded by per-task budgets and the read-only/mutation round caps.

---

## 10. Autonomy and Approval Boundary Analysis

**The desired principle** ("cheap+reversible → autonomy; destructive/public/secret/costly → gate") is the exact wording of the Class A–D contract (`.agents/rules/10-autonomy-policy.md:14`) and is encoded in `autonomyPolicy.ts` profiles. **But enforcement is partial and has bypass paths.**

**What is enforced today (live)**:
1. `BABEL_AUTONOMY_CLASS=A|B|C|D` → task-class tune via `resolveChatTaskClass` (`chatTaskClass.ts:479-480`) → governance tune for C/D = strict verification + phase gates + hard tool restrict (`chatTaskClass.ts:251-273`). LIVE, TESTED, EXERCISED.
2. Completion honesty gate (strict/headless hard-block; adversarial signals). LIVE, TESTED.
3. Approval sessions: `allow_once|allow_session|narrow_rule`, headless deterministic deny, subagent ceiling (`chatEngine.ts:3537-3548`). LIVE, TESTED.
4. Credential deny: technical in Claude Code harness (`.claude/settings.json` permissions.deny + PreToolUse hook `block-credential-read.sh`), CI gitleaks pinned SHA-256, `.gitignore` `.env*`. LIVE.
5. Network-command deny in Babel's policy layer: curl/wget/npm install → deny under `workspace_write` (`policy.ts:64-70`). LIVE (partial coverage).

**Bypass paths (evidence)**:
- `classifyAutonomyAction` (C/D command patterns: force-push, `rm -rf`, `.env` dump, IAM/billing…) has **zero live consumers** — grep shows only `autonomyPolicy.test.ts`. `git push --force origin main` via `run_command` → `non_idempotent_local_effect` (allowed) → `decideAction` allow → **executes ungated in chat mode**.
- C/D presets unwired: `chatEngine.ts:4129-4136` hardcodes `plan→read_only else workspace_write`; a `BABEL_AUTONOMY_CLASS=D` session gets governance *tuning* but **not** the profile's claimed `read_only` mutation denial (`autonomyPolicy.ts:281-285` vs wiring). The profile table overstates today's enforcement.
- `BABEL_BENCHMARK_AUTO_APPROVE=1` auto-allows approvals and mutations (`chatApproval.ts:118-121`, `chatEngine.ts:4126-4128`) — an env-setting wrapper bypasses the ask path.
- Credential reads inside Babel's own runtime: `run_command: cat .env` executes (rule 09's deny is technical for the Claude Code harness, prose for Babel's own executor).
- `.githooks/pre-commit.ps1` is optional/bypassable (`--no-verify`); commit/push/PR/merge are prose-only at runtime (rule 05:61-86).
- Hook scope: `block-credential-read.sh` matches Bash|PowerShell only; fail-open if bash missing or timeout.
- Subagent delegation rules carry no gates (rule 07 is research-only prose; fan-out skills carry prose gates only).

**Policy gap table** (per action: enforcement layer → status):

| Action | Enforcement | Status |
|---|---|---|
| Commit / push / PR / merge | Prose (05) + optional githooks; no runtime gate | DOCUMENTED / ABSENT (runtime) |
| Force-push / history rewrite / branch delete | Prose hard stops; classifier patterns **unwired** | DOCUMENTED / ABSENT |
| `rm -rf` / destructive delete | Prose Class C; classifier unwired; `decideAction` allows | DOCUMENTED / ABSENT |
| Installs | curl/wget/npm deny (`policy.ts:64-70`); pip/go get etc. unmatched | IMPLEMENTED (partial) |
| Credentials | Technical (CC harness + CI); prose (Babel runtime, Cursor, Codex) | IMPLEMENTED (CC) / ABSENT (runtime) |
| External messages / financial / publish / deploy | Prose Class C; regexes unwired | DOCUMENTED / ABSENT |
| Hiding failures / fabricating evidence / claiming tests passed | Honesty gate + adversarial signals | IMPLEMENTED + TESTED + EXERCISED |

**Verdict**: this is the P0 cluster. The design is right and testable (`autonomyPolicy.test.ts` 16/16); the wiring is missing. Two concrete, small, high-leverage changes: (1) consult `classifyAutonomyAction` in the tool-dispatch path (or a subset — see adversarial review §17); (2) apply preset selection per autonomy class at `chatEngine.ts:4129-4136` with `ask_before_mutation`/`read_only` actually honored, and gate `BABEL_BENCHMARK_AUTO_APPROVE` behind benchmark mode.

---

## 11. Model Routing / Worker Selection Analysis

**Current selection chain** (evidence): explicit `--model` → orchestrator-produced `assigned_model` (LLM-chosen, schema-validated, `agentContracts.ts:382-395`) → per-stage waterfall from `config/model-policy.json` → dynamic tier reorder (`routingEngine.ts`, min 3 samples, opt-out). Chat: `resolveChatModelPolicy` (explicit key > family resolve > default DeepSeek standard → `deepseek-v4-pro`). Enterprise allow/deny gating exists (`enterprisePolicy.ts`).

**Empirical substrate**:
- Waterfall telemetry: **652 entries / ~161 runs** — per-stage per-tier win/retry/fallback/cost/latency/tokens. This *is* `P(success|stage, tier)` data with meaningful-ish sample at tier granularity; already consumed (tier reorder).
- SWE-Pro campaign: **121 cells, 0 live agent passes** (`phase: infra` only) — no model discrimination.
- No task-class × worker × outcome tables; no false-completion-by-worker tables; no cost-by-worker tables joined to outcomes.

**Categorization** (per audit rules):
- Dynamic tier reorder per stage: `EXPERIMENTAL` — small-but-real dataset, bounded action (reorder only, never skips verification), opt-out available. **Keep**, but publish its measured win/loss.
- Automatic provider/model routing per task class: `INSUFFICIENT_EVIDENCE` / `NOT_RECOMMENDED`. Zero live cross-model discrimination exists; a router would be fitting noise.
- Manual/explicit selection (CLI flag, env, task-class tune): correct current default.

**Verdict**: do not build an automatic router. Harden the *manual* path: keep explicit override, keep tier reorder, add a measurement ledger that tracks `P(verified_success|worker, task_class)`, `P(false_completion|…)`, cost, latency per cell — the SWE-Pro campaign infrastructure already produces per-cell results; join them with telemetry once live passes exist. Revisit routing only after ≥100 live per-cell samples.

---

## 12. Capability Matrix

| Capability | Current Babel state | Evidence | OpenAI lesson | Provider-neutral principle | Gap | Benefit | Risk | Recommended action | Experiment needed | Priority |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. Reasoning continuity | Client-side via compaction capsule; provider-native ABSENT; full history re-sent each turn | `providerCapabilities.ts:160-223`, `threadEventLog.ts:283-341`, grep (no provider continuation) | `reasoning.context all_turns` (opaque encrypted carriers) | Opaque state-carrier lane, pass-through never-edit | No carrier lane; no provider-side retention | Lower long-session token cost; rides future provider wins | Vendor lock-in; hidden state; irreproducibility | `EXPERIMENT_FIRST` (carrier lane behind adapter capability, measured) | E6 (passthrough vs rebuild, requires live OpenAI adapter — BLOCKED_REQUIRES_APPROVAL) | P3 |
| 2. Long-horizon context/state preservation | IMPLEMENTED: event-sourced rebuild, capsule, resume with causality assertions | `threadEventLog.ts`, `sessionRunValidator.ts`, `compactionCommit.ts:233-439` | Response chains bill all prior input tokens; conversations API for durable state | Harness-owned durable state, rebuilt deterministically | H2 dual-write completeness is Chat-only; V9 Plan/Deep partial | Exact resume; no provider dependency | — | `KEEP_AS_IS` + `HARDEN` (finish H2 exit gates per roadmap) | — | P1 |
| 3. Compaction | IMPLEMENTED: LLM summarize → heuristic fallback, token-triggered, capsule commit w/ rollback; TESTED (941+545-line suites) | `chatCompaction.ts`, `compactionCommit.ts` | Server-side compaction at `compact_threshold`; opaque carrier | Compaction primitive with pass-through carrier contract | Two token estimators disagree (G9); trigger 128k vs 1M window | Correct budget enforcement | Over-compaction losing constraints | `HARDEN` (unify estimators; calibrate trigger) | E3 (trigger calibration w/ `measureCriticalFactRetention`) | P1 |
| 4. Prompt caching | ABSENT (construction); passive accounting only; cost tracker ignores cache pricing | grep (no cache constructs), `costTracker.ts:68-77` vs `modelPricingRegistry.ts:191-202` | Exact-prefix ≥1024 tokens; 0.1× cached; explicit breakpoints | Stable-prefix layout discipline + cache-region markers + cache-aware accounting | No layout discipline; wrong cost telemetry | Recurring token/cost savings on every turn | Premature micro-opt if tokens cheap | `HARDEN` (layout + accounting fix) then `EXPOSE_PROVIDER_CAPABILITY` (breakpoints) | E1 (prefix-order A/B on DeepSeek cache stats) | P1 |
| 5. Deterministic computation outside model context | IMPLEMENTED (gates, receipts, waterfall, token counting); shallow for raw tool output | `kernel.ts`, `verifierKernel.ts`, `utils/truncate.ts:36-43` | Programmatic tool calling (hosted code) returns smaller structured results | Deterministic reduction stages before model | No normalized evidence envelope (G7) | Token ↓, distraction ↓, hallucination ↓ | Brittle parsers | `EXPERIMENT_FIRST` (normalized envelope on benchmark cells) | E2 | P2 |
| 6. Programmatic tool orchestration | IMPLEMENTED (deterministic orchestration code; parallel batching reads-only; mutations sequential) | `chatEngine.ts:3343-3379`, `execute.ts` waterfalls | Code-based orchestration for predictable flow; direct tool calling for side-effects | Deterministic control flow where flow is predictable | No hosted-code executor (correctly — not needed) | — | — | `KEEP_AS_IS` | — | P3 |
| 7. Selective parallel/subagent execution | IMPLEMENTED + TESTED (worktrees, disjoint scopes, ceilings, read-only parallel) | `agentTeams.ts`, `implementWorktreeAgent.ts`, `chatEngine.ts:3329` | Schedule/bound subagent calls; parallel where independent | Bounded fan-out with ownership partitioning | `awaitAll` barrier no-op; fan-out mostly sequential | — | — | `KEEP_AS_IS` (+ wire `awaitAll` when a consumer needs it) | — | P3 |
| 8. Native provider-side multi-agent | ABSENT by design | `openAiApi.ts` (plain loop), `babel-cli/CLAUDE.md:41-44` | Agents-as-tools vs handoffs; who owns the final answer | Delegation topology is a harness decision; adapter may map onto provider | None (design correct) | — | Correlated errors; lock-in; fake consensus | `DEFER` / `REJECT` for core; optional adapter mapping later | — | P3 |
| 9. Model/effort specialization | IMPLEMENTED (task-class tunes, strict critic tiers, budgets); effort dial ABSENT | `chatTaskClass.ts` TUNES, `diffCritic.ts:45-59` | Effort levels `none..max`; low for tool-use, medium default | Per-task inference-compute dial, per-provider mapping | No effort knob (G4) | Cheapest quality/cost lever | Provider translation complexity | `ADD_PROVIDER_NEUTRAL_ABSTRACTION` (effort field on task class → adapter mapping) | E4 (thinking on/off on deepseek benchmark cells) | P1 |
| 10. Eval-driven model selection | PARTIAL: telemetry-driven tier reorder only; benchmarks exist, not CI-wired; 0 live SWE-Pro passes | `routingEngine.ts`, `agentBenchmark.ts`, campaign reports | Accuracy-first; measured evals; smallest tier meeting bar | Eval-gated routing policy; never rule-of-thumb | No cross-model dataset; no task-class×worker tables | — | Overfit to noise | `EXPERIMENT_FIRST` (join telemetry×cells; re-evaluate at ≥100 live samples) | E5 (telemetry-ledger join) | P2 |
| 11. Verification & false-completion detection | IMPLEMENTED + TESTED + EXERCISED (kernel decide, promotion gate 14 reasons, adversarial signals) | `kernel.ts:141-203`, `verifierKernel.ts:181-308`, `completionGatePolicy.ts:45-114` | Trace grading → dataset evals; deterministic graders first | Model claims are proposals; deterministic verification is authoritative | `worker_claim_success`/`verified_success` not named uniformly | — | — | `KEEP_AS_IS` + minor `HARDEN` (naming; G8 config drift) | — | P1 (G8), P2 (naming) |
| 12. Explicit approval/authority boundaries | PARTIAL: classes A–D + sessions live; classifier & C/D presets UNWIRED; benchmark auto-approve bypass | `autonomyPolicy.ts`, `chatEngine.ts:4129-4136`, `chatApproval.ts:118-121` | Approval = run-lifecycle state, fail-closed, app-level approval regardless of caller | Gate at the tool boundary; pause/resume; sticky decisions | Enforcement gaps (G1) | Matches the product's core principle | False positives from regex gates | `HARDEN` (wire classifier + presets + gate auto-approve) | E7 (adversarial fixture suite) | **P0** |
| 13. Trace/evidence capture | IMPLEMENTED + EXERCISED (hash-linked episode stream, session events, receipts, telemetry) | `episodeStream.ts:74-95`, `sessionEvents.ts`, `05_waterfall_telemetry.json` on disk | Traces + nested spans, default-on | Structured end-to-end run observability | No pluggable exporters (not needed yet) | — | — | `KEEP_AS_IS` | — | P3 |
| 14. Provider capability negotiation | PARTIAL: capability records w/ provenance; name-heuristic defaults; Capability Broker core-gate only | `providerCapabilities.ts:61-131`, V1 §6.3.4 | — (no direct OpenAI analogue; model guidance is eval-based) | Adapters announce; core consumes; provenance tracked | Broker incomplete; no adapter announcement | Correct multi-provider behavior without shape leakage | Abstraction overhead | `HARDEN` (complete broker; adapter `announce()`) | — | P1 |
| 15. Stateful vs stateless execution | Stateless provider calls + durable harness state — BY DESIGN (ADR-004) | ADR-004, `threadEventLog.ts` | Stateless by default; previous_response_id / conversations for state | Harness owns state; providers may offer continuation as a capability | No provider-continuation option (fine today) | — | — | `KEEP_AS_IS` (+ optional capability later) | — | P3 |
| 16. Cost/latency/context efficiency | IMPLEMENTED (budgets, kill policy, telemetry, cost confirmations) | `chatEngineLimits.ts`, `budgetKillPolicy.ts`, `pipeline.ts:1963-1998` | Cost second after accuracy; effort escalation cheaper than size | Measured budgets; telemetry-driven tuning | Cache pricing ignored (G2-part); estimator split (G9) | Correct cost signals | — | `HARDEN` (fix accounting) | E1, E3 | P1 |
| 17. Durable authoritative state vs model memory | IMPLEMENTED + TESTED (task contract hash, capsule, receipts, revision binding) | `taskContract.ts:79-167`, `revisionBoundReceipt.ts` | — | Facts live in harness state, never only in model memory | — | — | — | `KEEP_AS_IS` | — | P3 |
| 18. Retry/escalation policies | IMPLEMENTED (waterfall fallback, retryable classification, failover w/ `countsAsVerification:false`, FailureClass budgets) | `execute.ts:1039-1343`, `providerCapabilities.ts:333-358`, `taskContract.ts:36-58` | — | Deterministic retry with honest verification semantics | — | — | — | `KEEP_AS_IS` | — | P3 |
| 19. Independent model/provider verification | PARTIAL: diff critic (default headless/CI), clean-room opt-in, review lanes; no heterogeneous reviewer exercised | `diffCritic.ts:81-88`, `independentVerifier.ts:76-94`, `lanes/` | Trace grading; multi-agent independence | Reviewer is a separate, budgeted capability | Default-off on interactive; same-vendor critic | Catches implementation-blind spots | Cost; reviewer availability | `EXPERIMENT_FIRST` (heterogeneous reviewer on governance cells) | E7-part | P2 |
| 20. Future-proof provider-neutral architecture | PARTIAL: OpenAI-shaped shared contract; live DeepSeek-only; dormant adapters; capability records exist | `base.ts:170-226`, `execute.ts:1783-1790`, `modelPolicy.ts:21-38` | Guide mechanisms are per-provider; neutral principle is capabilities+state+verification | Core understands capabilities/contracts/state/evidence/policy, not provider shapes | Shape leakage in message model; live single-vendor lane | Multi-provider claim becomes real; GPT-5.6 lane possible | Big refactor with no live consumer | `HARDEN` incrementally (carrier lane + effort + capability announce first; contract cleanup when a 2nd vendor goes live) | — | P1 |

## 13. One Concrete End-to-End Trace (chat task, daily driver)

Trace of a representative mutation task ("fix the failing test in `src/foo.ts`", interactive chat mode) — every transition with its state, authority, model-visible content, waste, and gates. (Required by audit rules §15.)

```
task intake        user text → chatCore.runChatEngineOnce (interactive/execution/chatCore.ts:385)
  └ in: raw task text            out: ChatEngine + compiled chat stack
  └ authority: user             model-visible: nothing yet

policy resolution   resolveChatTaskClass({taskText, autoClassify}) (chatEngine.ts:722-725)
  └ BABEL_CHAT_TASK_CLASS > BABEL_AUTONOMY_CLASS > text auto-classification > default
  └ e.g. "failing test suite" → general_swe (multi-file signal, chatTaskClass.ts:422-428)
  └ out: tune (maxTurns 250, strictCritic, verificationPolicy required, budgets)
  └ authority: deterministic code — model-visible: task-class label in logs only

provider selection  resolveChatModelPolicy / resolveDeliberationRunner (chatEngine.ts:4647-4717)
  └ explicit key > family resolve (default DeepSeek) > deepseek-v4-pro, fallback deepseek-v4-flash
  └ authority: config + env (no automatic routing)

prompt construction getOrBuildSystemPrompt (cached) + rebuildProviderMessages
  └ stable-ish head: system prompt, compaction capsule? (threadEventLog.ts:304-313)
  └ dynamic tail: full history + current task re-injected ("## Current Request")
  └ TOKEN WASTE: full history re-sent every turn; no cache-region construction (G2);
                  text path would flatten everything into prose (legacy)
  └ authority: harness; provider sees plaintext messages only (no native continuation)

model request       runner.executeWithToolsStream → POST api.deepseek.com/v1/chat/completions
  └ provider-specific: DeepSeek OpenAI-compatible; thinking support recorded
  └ failure: retryable classification (providerCapabilities.ts:333) → retry/fallback
              failover countsAsVerification=false (never inflates evidence)

tool invocation     executeActions → planToolBatches (chatEngine.ts:3343-3379)
  └ reads parallelize; mutations sequential; per-action idempotencyKey
  └ dispatch: executeActionWithPolicy (toolExecutor.ts:604+) →
       capability broker effect class (unknown → deny) → decideAction (policy.ts:57-72)
       → circuit breaker → approval session (headless: deterministic deny)
  └ APPROVAL BOUNDARY: C/D classifier NOT consulted here (G1 — bypass);
       workspace_write preset hardcoded for non-plan (chatEngine.ts:4129-4136)
  └ mutations: SafeExecutor path jail + shadow root (sandbox.ts); write scope checks
  └ state out: tool_* events appended to session-events.jsonl + thread log;
       tool result trimmed (2000-char cap native path) before re-enter

repeated loop       per-turn: budgets checked (cost/wall/stall, chatEngine.ts:1181-1199)
  └ compaction check before each turn (compactIfNeeded, chatEngine.ts:4527-4580):
       token estimate > 128k → LLM summarize (Qwen3-32B) or heuristic truncation →
       capsule commit (task, changedPaths, verifierFreshness, workspaceRevision, evidenceRefs)
       → dual-write thread + session events; failure → degraded/blocked status
  └ state: authoritative = thread log + session events + receipts; model sees only rebuilt array

verification        verifier run (e.g. `npm test`) → receipt (exit_code, hashes, scope, revision)
  └ authoritative verifier prefixes only; agent-owned _verify* probes rejected
  └ receipt bound to workspace revision; staleness re-checked at completion

completion decision model "finish" claim → computeTerminalOutcome (chatEngine.ts:3017)
  └ honesty gate (evaluateCompletionGateForEngine): no_writes / missing / red / stale /
       scope / adversarial signals → reject paths
  └ kernel.completion.decide: VERIFIED_COMPLETE iff gate.allow ∧ proof.compliant
       else downgraded → UNVERIFIED_PATCH (exit 0, honest label)
  └ events: completion_decision appended; terminal_status_summary.json written
  └ authority: deterministic kernel, NOT the model — TESTED (kernel.test.ts:70)
```

**Per-transition summary**: state input/output is harness-owned at every step; the model-visible surface is a rebuilt plaintext array; the two real waste points are full-history resend (mitigated by compaction, not by caching) and raw tool-result re-entry (trimmed, not reduced); the two real authority gaps are the unwired C/D classifier at tool dispatch and the hardcoded preset; provider-specific behavior is confined to the runner and `modelPolicy` — with the exception that the shared message/tool shapes are OpenAI-typed (G3).

---

## 14. Proposed Experiments (falsifiable, frozen tasks/worktrees)

All experiments: run on the existing agent-benchmark/parity harness (`npm run benchmark:agent`, mock first, live with approval), frozen per-cell tasks, report JSON per cell, metrics: verified success, false-completion rate, contract-pass rate, input/output/cached tokens, tool calls, wall-clock, cost, environment/provider/harness failures, retries, human interventions. No single-run winners.

**E1 — Prompt-layout discipline for cache hits** (G2)
- *Hypothesis*: reordering the system prompt so all static policy/schema text precedes per-turn variable content (unchanged text, reordered only) raises provider-reported `prompt_cache_hit_tokens / prompt_tokens` ratio on DeepSeek by ≥25% relative over a run, at zero quality cost.
- *Setup*: current order vs stable-prefix order, identical conversations (fixture), `chatEngine` unit level + N live cells.
- *Controls*: same model, same task text, same budgets; only ordering differs.
- *Sample*: n=30 live chat cells (or 200 mock), 2 arms.
- *Success threshold*: cache-hit ratio ≥0.25 relative gain AND verified-success rate unchanged (Δ ≤1 cell).
- *Failure threshold*: no gain or any verified-success regression → keep current order.
- *Confounders*: DeepSeek KV cache policy (1M window → cache may rarely bind below 128k trigger); provider-side eviction; concurrency.

**E2 — Normalized evidence envelope vs raw trim** (G7)
- *Hypothesis*: parsing test/lint/diff output into `{summary, failed[], counts, exit_code, rev}` (raw retained in evidence, envelope to model) reduces input tokens ≥30% on test-heavy cells and does not reduce verified success.
- *Setup*: envelope reducer for `npm test`/`pytest` receipts; A/B on benchmark parity cells.
- *Controls*: same cells, same verifier commands; only model-facing representation differs.
- *Sample*: n=20 parity/governance cells per arm.
- *Success*: token reduction ≥30% AND verified-success rate ≥ baseline −1 cell.
- *Failure*: success rate drop >1 cell (model needed raw output) → revert to trim-only.
- *Confounders*: receipt content variability; parser bugs on exotic runners (mitigate: envelope falls back to trimmed raw).

**E3 — Compaction trigger calibration** (G9-adjacent)
- *Hypothesis*: current 128k/100k triggers fire long before the 1M window and drop working context that `measureCriticalFactRetention` would retain; raising the trigger to 256k reduces compaction frequency without violating budgets or retention.
- *Setup*: `BABEL_CHAT_MAX_TOKENS`/compaction config at 128k vs 256k vs 384k on long-session fixtures; measure `measureCriticalFactRetention` score, tokens, cost, verified success.
- *Controls*: same fixtures, budgets otherwise identical.
- *Sample*: 3 arms × 10 long-session cells.
- *Success*: retention ≥ baseline AND cost ≤ baseline ×1.05.
- *Failure*: retention drop or cost increase → keep 128k.
- *Confounders*: estimator error (heuristic vs tiktoken) — run the same experiment under both estimators to expose G9 magnitude.

**E4 — Reasoning/thinking dial** (G4)
- *Hypothesis*: enabling DeepSeek thinking on benchmark cells (vs off, current) trades output tokens for verified-success on hard cells only (governance/general_swe), and is neutral-or-negative on quick_fix.
- *Setup*: per-task-class thinking on/off; `thinkingWithTools: 'unsupported'` caveat means tools may need to be exercised via non-tool path or a provider that supports both — if unsupported, this experiment becomes **BLOCKED_REQUIRES_APPROVAL** for the DeepSeek lane and moves to the OpenAI adapter when live.
- *Sample*: 3 classes × 10 cells × 2 arms.
- *Success*: verified-success gain ≥2 cells on hard classes with cost ≤ +40%; else effort dial stays off by default.
- *Failure*: no gain or cost explosion → do not build the dial yet.

**E5 — Routing evidence ledger join** (G6)
- *Hypothesis*: joining `05_waterfall_telemetry.json` with SWE-Pro campaign per-cell reports (task class × worker × outcome × cost) yields ≥100 live samples within 2 campaign waves, after which tier ordering decisions can be made with confidence bounds instead of heuristic scores.
- *Setup*: extend `causalLiveEvidence.ts`/campaign harvest to emit a joined ledger row per cell; no behavior change; report only.
- *Controls*: none needed (measurement only).
- *Sample*: 100+ live cell-rows.
- *Success*: ledger produced with per-class × worker tables; tier-reorder decisions reproducible from it.
- *Failure*: live pass rate stays ~0 (current state) → routing claims remain INSUFFICIENT_EVIDENCE and must be labeled experimental.
- *Confounders*: env-specific failures (Windows runners); dataset difficulty drift.

**E6 — Opaque reasoning-carrier passthrough** (G5; requires live OpenAI adapter)
- *Hypothesis*: carrying provider-native reasoning/compaction items as opaque payloads (never interpreted, never edited) and replaying them per provider rules yields ≥30% input-token reduction on long sessions vs Babel's rebuild-every-turn, with identical verified outcomes.
- *Setup*: adapter capability `reasoning_continuity: session_native` on an OpenAI-compatible runner; compare `carriers[]` passthrough vs rebuild on the same tasks.
- *Status*: **BLOCKED_REQUIRES_APPROVAL** — requires live GPT-5.6 API spend and a revived OpenAI runner; do not run until then. Cost gate: bounded budget, explicit approval.
- *Confounders*: hidden state, provider version drift, TTL/retention changes.

**E7 — Autonomy-gate wiring + heterogeneous reviewer** (G1, G10)
- *Hypothesis A*: dispatching through `classifyAutonomyAction` (D→deterministic deny, C→ask) blocks ≥90% of injected Class C/D command attempts (adversarial fixture suite) while blocking ≤2% of legitimate runs.
- *Setup A*: adversarial fixtures (force-push, `.env` dump, publish, rm -rf) run against current vs wired dispatch, mock mode.
- *Hypothesis B*: a cross-provider reviewer (e.g., DeepSeek implementer, Qwen/OpenRouter reviewer via `diffCritic` tier) catches ≥1 false completion the same-model critic misses on governance cells, at ≤+30% cost.
- *Setup B*: reviewer provider A/B on n=20 governance cells.
- *Success*: A: ≥90% block rate, ≤2% false positives; B: ≥1 additional caught false completion (measured against ground-truth patch) at ≤+30% cost.
- *Failure*: any threshold miss → keep classifier advisory / keep same-model critic.
- *Confounders*: fixture design bias; reviewer model availability/quality.

---

## 15. Recommended Architecture (current → proposed)

**Direction: Babel stays a capability-aware execution, state, orchestration, and verification environment — not a model router.** The OpenAI-specific mechanisms (reasoning carriers, server compaction, hosted program execution, provider subagents) stay at the adapter layer; core consumes capabilities.

```text
CURRENT                                          PROPOSED (delta marked ~)
┌─────────────────────────────┐                  ┌─────────────────────────────────────┐
│ Policy layer (classes A-D,  │                  │ Policy layer  ──(wire classifier +  │
│ task tunes, gates)          │                  │                presets)──► G1 FIX    │
└──────────────┬──────────────┘                  └──────────────┬──────────────────────┘
               │ task class + budgets                           │ + provider-neutral effort dial (G4)
┌──────────────▼──────────────┐                  ┌──────────────▼──────────────────────┐
│ Capability records          │                  │ Capability Broker completes:        │
│ (providerCapabilities.ts)   │                  │ adapters ANNOUNCE caps (announce());│
│ name-heuristic defaults     │                  │ core consumes only                  │
└──────────────┬──────────────┘                  └──────────────┬──────────────────────┘
┌──────────────▼──────────────┐                  ┌──────────────▼──────────────────────┐
│ Prompt construction         │  ─── G2 ────►    │ Stable-prefix layout (fixed order,   │
│ cache-blind                 │                  │ static head / dynamic tail),        │
│ full re-send every turn     │                  │ cache-region markers mapped by      │
│                             │                  │ adapter; carriers[] opaque lane     │
└──────────────┬──────────────┘                  └──────────────┬──────────────────────┘
┌──────────────▼──────────────┐                  ┌──────────────▼──────────────────────┐
│ Deterministic layer         │  ─── G7 ────►    │ + Normalized evidence envelope      │
│ gates, receipts, waterfall  │                  │   (reducer: test/lint/diff →        │
│                             │                  │   summary; raw kept in evidence)   │
└──────────────┬──────────────┘                  └──────────────┬──────────────────────┘
┌──────────────▼──────────────┐                  ┌──────────────▼──────────────────────┐
│ Verification: kernel decide,│                  │ unchanged (KEEP_AS_IS) +            │
│ honesty gate, promotion,    │                  │ config-drift detection (G8)         │
│ critic, clean-room (opt-in) │                  │ ── reviewer made a budgeted stage   │
└──────────────┬──────────────┘                  └──────────────┬──────────────────────┘
┌──────────────▼──────────────┐                  ┌──────────────▼──────────────────────┐
│ Adapters: DeepSeek live,    │                  │ Adapters implement capability       │
│ OpenAI/Claude/Gemini dormant│                  │ announce() when revived; GPT-5.6    │
│ OpenAI-shaped shared types  │                  │ lane = new adapter, not core change │
└─────────────────────────────┘                  └─────────────────────────────────────┘
```

**What moves where** (per audit rule §14): effort dial → task-class config + adapter mapping; cache-region markers → prompt builder + adapter; carriers → message model + adapter; evidence reduction → deterministic layer; config-drift → verification layer; reviewer scheduling → policy layer; routing evidence → experiment framework (never core routing).

---

## 16. What NOT to Build

1. **Hosted programmatic-execution runtime** (OpenAI V8 analogue). Babel's deterministic orchestration already covers the guide's rule ("code for predictable flow; direct tools for side-effects"). A hosted sandbox adds a security surface for no measured gain.
2. **Automatic model/provider router** — INSUFFICIENT_EVIDENCE (0 live cross-model discrimination; see §11). The guide itself is eval-first, and Babel has no eval to route on yet.
3. **Provider-native subagents in core** — correlated errors, lock-in, fake consensus; harness-managed subagents already exist with the neutral topology.
4. **`previous_response_id`-style provider state as the default state mode** — ADR-004's stateless+durable-harness-state is correct and keeps evidence replayable. Provider continuation is a future optional adapter capability (E6), never the spine.
5. **A giant generic capability abstraction with no consumers** — add fields only when a concrete consumer exists (effort dial, carriers, cache markers have consumers; "flag for every guide bullet" does not).
6. **OpenAI Evals API integration** — the platform is being deprecated (read-only 2026-10-31, shutdown 2026-11-30). Babel's own factorial harness (`harnessEval.ts`) is the neutral form.
7. **Vector memory before exact recovery** — already in the roadmap's scope guardrails (§7); keep it there.
8. **"Fix the OpenAI-shaped contract" as a standalone refactor now** — with one live vendor, this is speculative churn; the incremental path (carriers + effort + announce) fixes the leak where it matters without a rewrite.
9. **More agents** — consensus/voting/swarm aggregation (advisory doc exists; no evidence more agents help) — nothing until E7-B produces a signal.

---

## 17. P0 / P1 / P2 / P3 Roadmap

**P0 (enforcement truth — small, gated, testable)**:
1. Wire `classifyAutonomyAction` into tool dispatch (D→deterministic deny, C→ask via approval session) with the adversarial fixture suite as a conformance test.
2. Apply autonomy-class presets at `chatEngine.ts:4129-4136` (C→`ask_before_mutation`, D→`read_only`) and correct the profile's enforcement claim.
3. Gate `BABEL_BENCHMARK_AUTO_APPROVE` behind benchmark mode (fail closed otherwise); add credential-path deny (`cat .env` etc.) to Babel's own `decideAction`, not just the harness hook.

**P1 (provider-neutral hardening)**:
4. Stable-prefix prompt layout + cache-aware cost accounting fix (`costTracker` vs `modelPricingRegistry`).
5. Provider-neutral effort dial (task class → `low|medium|high` → adapter mapping; DeepSeek thinking gate behind E4).
6. Complete Capability Broker negotiation (`announce()`); extend provenance to effort/caching/continuation.
7. Unify token estimation (calibrate heuristic against `o200k_base`; keep heuristic only where justified).
8. General config-drift detection (baseline fingerprint at task start; flag mid-run drift).
9. Fix harness doc staleness (V1 §6.12 vs §2) and name the `worker_claim` vs `verified` distinction once (`isVerifiedOutcome`), for benchmarks and post-hoc analysis.

**P2 (measured experiments — E1, E2, E3, E4, E5, E7)**: cache-layout A/B; evidence envelope; compaction calibration; effort dial; routing ledger; autonomy-gate adversarial suite; heterogeneous reviewer. Each gates its own rollout (success thresholds in §14).

**P3 (defer / capability-carried)**: carrier lane for provider-native reasoning (E6, needs live OpenAI adapter); revive OpenAI/Claude/Gemini adapters with `announce()`; durable per-request approval ledger (G12); provider-native subagent mapping; TUI replay consumers (per V1 §6.3.9).

---

## 18. Adversarial Review (attacks on this report's own recommendations)

1. **"Wire the classifier"** → *Counter*: regex-based command classification is evadable (`g it push --force` via `$HOME/bin/g`), misfires on legitimate scripts, and adds a new denial surface; the honesty gate already catches the *consequences* (forced push is visible in git state). *Rebuttal*: correct — the classifier should be a fail-closed deny layer for Class D and an ask-layer for Class C, never the sole control; the E7 adversarial suite measures false-positive rate before enabling; and enforcement truth (P0-1) is about making the documented policy real, not about perfection. If E7 shows >2% false positives, ship it gated behind `BABEL_AUTONOMY_CLASS` C/D only.
2. **"Stable prefix matters"** → *Counter*: DeepSeek has a 1M window; with a 128k compaction trigger, prompt sizes may rarely exceed cache minimums, and DeepSeek's KV cache economics may differ from OpenAI's 0.1×. *Rebuttal*: E1 measures before any code ships; the layout discipline costs almost nothing and the accounting fix is correct regardless (G2's cost-tracker bug is real today).
3. **"Effort dial"** → *Counter*: `thinkingWithTools: 'unsupported'` for deepseek means the dial may be unusable on the only live vendor; abstraction without a working mapping is astronautics. *Rebuttal*: the dial is one field + one adapter mapping; E4 decides whether it ships on DeepSeek or waits for the OpenAI adapter. Priority stays P1 because the abstraction itself is the neutral lesson.
4. **"Carrier lane"** → *Counter*: opaque carriers create vendor lock-in, hidden state, irreproducibility, and stale assumptions — the audit prompt's own critique. *Rebuttal*: the lane is strictly optional, never interpreted, never required for evidence (all receipts/capsules remain harness-owned), and its experiment (E6) requires provider approval. The pass-through contract + drop-always fallback keeps Babel's determinism intact.
5. **"Normalized evidence envelope"** → *Counter*: parsers are brittle; a parser bug that silently drops a failing test would be worse than raw text. *Rebuttal*: the envelope never replaces the receipt/evidence path (raw output stays in evidence; the envelope is model-facing only), and the exit-code + failed[] fields come from the verifier itself, not prose parsing. E2's failure threshold (verified-success regression >1 cell) guards it.
6. **"Complete the Capability Broker"** → *Counter*: with one live vendor this is a speculative abstraction; "dozens of flags nobody uses" risk is real. *Rebuttal*: only three fields are added now (effort, caching, continuation), each with a consumer or an experiment; `CapabilityProvenance` already exists, so the machinery is not new.
7. **"Compaction trigger 128k→higher"** → *Counter*: conservative triggers are a deliberate safety choice; raising them risks budget overflow on long sessions. *Rebuttal*: E3 is purely experimental and its failure threshold (retention/cost) protects the default; the real bug is the estimator split (P1-7), not the trigger value.
8. **"Routing ledger"** → *Counter*: joining telemetry to campaign cells may still yield garbage if cells are environment-limited (Windows runners, 0 live passes). *Rebuttal*: the ledger is measurement-only; if live passes stay ~0, the finding is "still INSUFFICIENT_EVIDENCE" — which is itself the correct, published outcome (no behavior change).
9. **"Heterogeneous reviewer"** → *Counter*: a second provider may be *worse* than the same-model critic (different failure modes, availability issues, extra cost). *Rebuttal*: E7-B is an experiment with a hard cost bound; the diff critic stays the default until evidence beats it. Independence ≠ quality — that's why it's measured, not assumed.
10. **Self-critique of the verdict**: `TARGETED_IMPROVEMENTS` could understate the fact that the enforcement gaps (G1) are the same class of "policy claims vs reality" problem the audit exists to catch; conversely, the guide-derived levers (caching, effort, carriers) are all *cost* levers, and Babel's biggest risk is not cost but the unwired autonomy spine. The P0 cluster is therefore ranked first not because the guide says so, but because it is the only cluster where documented policy and live behavior disagree today.

---

## 19. Final Recommendation

**Answer to the central question**: Babel should **not** become a model router. It already is — and should complete becoming — a provider-neutral, capability-aware execution/state/orchestration/verification environment. Everything in the GPT-5.6 guide that is worth taking is expressible as a *provider-neutral capability* that Babel negotiates, stores, verifies, and pays for; everything that is OpenAI-specific stays in an adapter behind a capability record.

**GO — change now (P0)**: wire the autonomy classifier and C/D presets into dispatch; gate `BABEL_BENCHMARK_AUTO_APPROVE`; add credential-path deny inside Babel's own runtime. These make documented policy true.

**GO — change now (P1)**: stable-prefix prompt layout + cost-accounting fix; effort dial abstraction; Capability Broker `announce()`; token-estimator unification; config-drift detection; doc staleness fix; single `verified` outcome name.

**EXPERIMENT — measure before deciding**: E1–E7 as specified (cache layout, evidence envelope, compaction calibration, thinking dial, routing ledger, carrier passthrough — blocked on live OpenAI —, autonomy-gate and heterogeneous-reviewer suites). Each has thresholds; no single run decides anything.

**DEFER**: automatic model/provider routing (until ≥100 live joined samples and ≥1 verified live pass), provider-native continuation as default, provider-native subagents in core.

**REJECT**: hosted programmatic-execution runtime, OpenAI Evals API binding (deprecated platform), previous_response_id as the state spine, vector memory before exact recovery, consensus swarms without evidence, a generic capability ontology with no consumers.

**Unchanged**: the verification kernel, compaction capsule architecture, event-sourced session spine, worktree isolation, budget enforcement, stateless-provider + durable-harness-state posture, harness-managed subagents, honest docs discipline.

---

## 20. Sources & Evidence Index

**OpenAI (fetched live, 2026-08-15)** — all official unless flagged:
- `developers.openai.com/docs/guides/reasoning` — reasoning context, effort levels, encrypted items
- `developers.openai.com/api/docs/guides/conversation-state` — stateless default, `previous_response_id`, conversations API, 30-day TTL
- `developers.openai.com/api/docs/guides/compaction` + `/api/reference/cli/resources/responses/methods/compact` — `context_management`, compaction items, `/responses/compact`
- `developers.openai.com/docs/guides/prompt-caching` — exact-prefix, 1024-token floor, 0.1×/1.25× pricing, `prompt_cache_breakpoint/options/key`
- `developers.openai.com/api/docs/guides/tools-programmatic-tool-calling` + `/guides/function-calling` — hosted V8, direct-vs-programmatic rules, parallel calls, idempotency, app-level approval
- `developers.openai.com/api/docs/guides/agents/guardrails-approvals` — `needs_approval`, interruptions, resumable state, fail-closed
- `openai.github.io/openai-agents-python/multi_agent/` + `/tracing/` + `/context/` — agents-as-tools vs handoffs; traces/spans
- `developers.openai.com/docs/guides/model-selection` + `/api/docs/guides/latest-model` — accuracy-first, sol/terra/luna, pro mode
- `developers.openai.com/api/docs/guides/agent-evals` + `/docs/guides/evals` — two-stage eval ladder; **Evals platform deprecation** (read-only 2026-10-31, shutdown 2026-11-30)
- Primary page `openai.com/index/builders-guide-to-gpt-5-6/` — **HTTP 403, UNVERIFIED directly**; guide content via secondary summaries (aib.vote, jxxy.net), every mechanism cross-verified on the official pages above. `budget_tokens` flagged UNVERIFIED (Anthropic parameter).

**Babel evidence (key files, all inspected)**:
- Contracts: `babel-cli/src/schemas/agentContracts.ts`, `src/schemas/taskEnvelope.ts`, `src/agent/taskContract.ts`
- Loop: `src/pipeline.ts`, `src/execute.ts`, `src/agent/chatEngine.ts`, `src/interactive/execution/chatCore.ts`, `src/executor/{kernel,contracts,modeController}.ts`
- Providers: `src/runners/{base,deepSeekApi,deepInfraApi,ollamaApi,openAiApi,providerRegistry,providerEngine,providerMessages}.ts`, `src/modelPolicy.ts`, `src/config/model-policy.json` (repo root)
- Capabilities: `src/agent/providerCapabilities.ts`, `src/agent/capabilityBroker.ts`
- Context: `src/agent/{chatCompaction,compactionCommit,chatEngineSupport,threadEventLog,sessionEvents,turnSummaryScheduler,observationTails}.ts`, `src/services/{compaction,pruning,costLedger,costTracker,tokenCounter}.ts`, `src/config/chatEngineLimits.ts`
- Verification: `src/agent/{completionGatePolicy,verifierKernel,verifierIntegrity,chatEngineVerifierSession,diffCritic}.ts`, `src/services/{requiredVerifierContract,verifierIdentity}.ts`, `src/evidence/{revisionBoundReceipt,independentVerifier,episodeStream,completionEvidence,acceptanceContracts}.ts`
- Autonomy: `src/config/{autonomyPolicy,chatTaskClass,approvalProfiles}.ts`, `src/agent/{policy,approvalRequests,chatApproval}.ts` (+ tests; autonomy test executed 16/16), `.agents/rules/05,06,07,09,10`, `.claude/settings.json`, `.claude/hooks/block-credential-read.sh`, `.cursor/rules/autonomy.mdc`
- Isolation/parallel: `src/sandbox.ts`, `src/config/executionProfiles.ts`, `src/services/{worktreeIsolation,worktreeSafety,agentTeams}.ts`, `src/agent/{implementWorktreeAgent,agentRunCoordinator,toolExecutionIdentity,sessionRunValidator}.ts`
- Evals: `src/services/{agentBenchmark,agentBenchmarkHarness,swebenchProCampaign,liteVaguenessBenchmark,causalLiveEvidence,modelPricingRegistry}.ts`, `src/{routingEngine,harnessEval}.ts`, `runs/*/05_waterfall_telemetry.json` (652 entries), `runs/agent-benchmark/swe-pro/*/campaign-report.json` (121 cells)
- Normative docs: `docs/architecture/HARNESS_ARCHITECTURE_V1.md`, `HARNESS_HARDENING_ROADMAP_V1.md`, `docs/adr/ADR-0001..0013`, `PROJECT_CONTEXT.md` (root + babel-cli)

---

## 21. Decision Summary

| Change | Decision |
|---|---|
| Wire autonomy classifier + C/D presets + gate auto-approve | **GO (P0)** |
| Stable-prefix prompt layout + cost-accounting fix | **GO (P1)** |
| Effort dial + capability `announce()` + estimator unification + config-drift + doc fixes | **GO (P1)** |
| E1–E7 experiments (cache, envelope, compaction, effort, routing ledger, carriers, gates) | **EXPERIMENT** |
| Automatic router / provider-native continuation / provider subagents | **DEFER** |
| Hosted program execution / OpenAI evals API / `previous_response_id` spine / vector memory / consensus swarms | **REJECT** |
| Verification kernel, capsule, session spine, worktree isolation, budgets, harness-managed subagents, stateless-provider posture | **UNCHANGED** |

---

```text
VERDICT: TARGETED_IMPROVEMENTS
TOP_5_FINDINGS:
  1. Autonomy policy's deterministic spine is unwired — classifyAutonomyAction has zero live
     consumers; C/D presets not applied (chatEngine.ts:4129-4136); git push --force and
     cat .env execute ungated in Babel's own runtime (P0 cluster).
  2. Verification/false-completion is genuinely engineered: kernel.completion.decide + 14-reason
     promotion gate + adversarial signals (tests_deleted, shortcut_noop, hardcoded_fixture,
     flaky_green, verifier_def_tampered) + revision-bound receipts; model "done" can never
     alone produce VERIFIED_COMPLETE (kernel.test.ts asserts it).
  3. Prompt construction is cache-blind: no stable-prefix layout, no cache-region markers,
     full history re-sent every turn; cost tracker ignores cache pricing; provider-native
     continuation absent by design (stateless + durable harness state = correct posture).
  4. Live lane is DeepSeek-only and the shared contract is OpenAI-shaped — "provider-neutral"
     is aspirational; capability records exist (providerCapabilities.ts) but adapters don't
     announce; effort dial missing.
  5. Routing evidence supports tier reorder only: 652 telemetry entries; SWE-Pro 121 cells,
     0 live passes — automatic model/provider routing is NOT evidence-justified.
TOP_3_EXPERIMENTS:
  E1 stable-prefix cache layout A/B (DeepSeek cache-hit ratio ≥25% gain, zero quality cost)
  E2 normalized evidence envelope vs raw trim (≥30% input-token cut, verified success held)
  E7 autonomy-gate adversarial suite + heterogeneous reviewer (≥90% Class C/D block, ≤2% FP;
     ≥1 extra false completion caught at ≤+30% cost)
P0_CHANGES: wire classifyAutonomyAction into dispatch (D deny / C ask); apply C/D presets at
  chatEngine.ts:4129-4136; gate BABEL_BENCHMARK_AUTO_APPROVE to benchmark mode; credential-path
  deny in Babel runtime decideAction.
DO_NOT_BUILD: hosted programmatic-execution runtime; automatic model router; provider-native
  subagents in core; OpenAI Evals API binding (platform deprecating); previous_response_id as
  state spine; vector memory now; consensus swarms without evidence.
OPEN_QUESTIONS: does DeepSeek KV caching bind below 128k compaction trigger (E1)? does the
  thinking dial survive thinkingWithTools:'unsupported' on the live lane (E4)? when does a
  second vendor go live to justify announce() (G3)? will live SWE-Pro passes ever exceed 0
  (E5)? is the GPT-5.6 guide's headline cost data replicable (UNVERIFIED, secondary sources)?
REPORT_PATH: docs/status/audits/gpt56-2026-08/BABEL_GPT56_BUILDER_ARCHITECTURE_AUDIT.md (was uncommitted at audit time, by design; relocated and tracked during the 2026-08-15 documentation reconciliation)
BASE_COMMIT: d92c02dbbc5bd5fb9940646fcb7a0aad2b70021c (fix/session-event-lifecycle-identity)
```
