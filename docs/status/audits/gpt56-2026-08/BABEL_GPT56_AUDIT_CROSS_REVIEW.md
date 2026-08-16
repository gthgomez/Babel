# Babel GPT-5.6 Audit — Cross-Review of Five Independent Audit Documents

**Status**: READ-ONLY REVIEW — uncommitted, by design.
**Date**: 2026-08-15
**Base commit of this review**: `d92c02d` on `fix/session-event-lifecycle-identity` (dirty). External audits pinned at `bcd975f` (main) where they pinned at all.
**Method**: all five documents read in full; every load-bearing claim about the Babel repository cross-checked against repo source at `d92c02d` (and, where the claim concerns main-only state, against the two-commit delta `bcd975f → d92c02d`, which contains only the session-event lifecycle work per git history). OpenAI-side claims were checked against the audit's own live-doc research (17 official pages fetched).

**Verdict legend**: `VERIFIED` (repo/evidence confirms) · `PARTIALLY VERIFIED` (true in part / true for an older revision) · `CONTRADICTED` (repo evidence opposes) · `UNSUPPORTED` (no evidence found; plausible-sounding assertion) · `UNVERIFIABLE` (outside repo evidence, e.g. provider-internal).

---

## 1. Document provenance & revision awareness

| Doc | Source | Pinned revision | Audit mode | Execution |
|---|---|---|---|---|
| 01 `ChatGPT-GPT-5.6 and Agent Infrastructure…json` | ChatGPT (meta/process: guide review → audit-prompt authoring → reconciliation of all five reports incl. mine) | n/a (meta) | web research + report comparison | none |
| 02 `ChatGPT-Babel Architecture Audit-20260815-1420.json` | ChatGPT web, connected GitHub | **`bcd975f9b43aaf6acac7b5894309e95aa051cd05`** (main), explicitly frozen | static source audit + official docs | none (declared) |
| 03 `Gemini-Babel Architecture Audit! GPT-5.6.json` | Gemini | **none** ("Commit state: August 2026 / ADR & CLI release baseline") | presumed static | none |
| 04 `Gemini-Babel Architecture Audit! GPT-5.6 Guide.json` | Gemini | **none** (admits no exact SHA accessible) | presumed static | none |
| 05 `Independent Babel Architecture Audit …md` | ChatGPT web (same lineage as 02) | **`bcd975f9b43aaf6acac7b5894309e95aa051cd05`** (main) | static source audit | none (declared) |
| (mine) `BABEL_GPT56_BUILDER_ARCHITECTURE_AUDIT.md` | local DeepSeek-terminal agent | **`d92c02d`** + dirty worktree (autonomy policy untracked) | static + targeted test execution | autonomyPolicy tests 16/16 |

Key revision fact (verified via git history): `d92c02d` is **two commits ahead of `bcd975f`** and the delta is the session-event lifecycle hardening — so the "enormous architectural difference" claimed by the Gemini audits **cannot be explained by revision drift**. Their differing picture of Babel is an inspection-quality problem, not a version problem.

---

## 2. Claim verification ledger

### 2.1 Doc 05 (Independent Audit) — the highest-quality external audit

| Claim | Verdict | Evidence |
|---|---|---|
| Verdict `TARGETED_IMPROVEMENTS`; Babel is already the execution/state/verification environment, not a router | **VERIFIED** | Independent agreement with my audit; all listed subsystems exist |
| `taskCompletion.ts` classifies tasks and constructs structured task contracts | **VERIFIED** | `src/taskCompletion.ts:18-30` (`TaskContract` interface). Note: this is a *distinct, older* contract concept from `src/agent/taskContract.ts` (TaskContractV1) — two task-contract concepts coexist, supporting the audit's own "consolidate canonical run state" theme |
| `providerMessages.ts` documents a past Markdown-flattening failure; modern path preserves roles/tool-call IDs/tool cycles/compaction state; "Babel simply serializes everything to text" is false | **VERIFIED** | `runners/providerMessages.ts:95-101` (protocol validator flags flattening), `threadEventLog.ts:283-341` (structured rebuild), my audit §8 |
| `chatCompaction.ts` (LLM summarize + heuristic fallback) and `compactionCommit.ts` (durable capsule commit, explicit persistence failure) | **VERIFIED** | `chatCompaction.ts:307-635`, `compactionCommit.ts:233-439` |
| Effect classes `read_only / idempotent / reconcilable_mutation / non_idempotent_local_effect / external_side_effect`; `classifyToolEffect()` keys on **tool name, not shell arguments** | **VERIFIED** | `executor/contracts.ts:39-44,185`; conformance tests `kernel.test.ts:17-19`, `architectureConformance.test.ts:159-165` |
| "I did not find a repository-level git push policy" | **PARTIALLY VERIFIED** | At `bcd975f` plausible; at `d92c02d` the untracked `autonomyPolicy.ts:109-127` **does** contain force-push/history-rewrite patterns — but they have **zero live consumers**, so the substantive claim ("no *enforced* push boundary") still holds. This audit missed the policy file because it reviewed main without the in-flight worktree |
| `codingTaskSuccess.ts` allows `UNVERIFIED_PATCH` to count as a coding-task `pass` when `requireVerifier` is false | **VERIFIED** | `services/codingTaskSuccess.ts:97-103` — `isPassingOutcome(UNVERIFIED_PATCH)` → `pass` at :97-99; claimed+mutation+no-verifier → `pass` at :101-103. Its P0.1 recommendation is precise |
| Dynamic routing default minimum observation count is three | **VERIFIED** | `routingEngine.ts` `MIN_SAMPLES` = 3 |
| `compiler.ts` compresses skill catalog, lazy-stubs large skill files, stable layer order, project memories then raw task context | **VERIFIED** | `src/compiler.ts:37,259,267-271,345,357-361` |
| "async and synchronous compiler paths use different lazy-stub size thresholds" | **VERIFIED — genuine new find** | `compiler.ts:267` `LAZY_STUB_THRESHOLD_BYTES = 8_000` vs `:357` `= 6_000`. Same conceptual stack can render differently per path — a cache-busting/reproducibility wrinkle not in my original audit (see §5) |
| OpenAI direct runner uses `/v1/chat/completions`, defaults to `o3-mini`, no Responses continuation | **VERIFIED** | `runners/openAiApi.ts:32,34` |
| Worktree isolation, disjoint write scopes, serial mutation fan-out, parent-cleanliness gate | **VERIFIED** | `worktreeIsolation.ts`, `implementWorktreeAgent.ts:391`, `agentTeams.ts:357-361` |
| Verification machinery (authoritative-verifier recognition, agent-owned `_verify*` rejection, tamper detection, revision-bound receipts, suspicious-skip detection) | **VERIFIED** | `completionGatePolicy.ts:117-147,278,311`, `verifierIntegrity.ts`, `revisionBoundReceipt.ts` |
| "GPT-5.6 cache lifetime at least 30 minutes" | **VERIFIED** (OpenAI side) | official caching page: `prompt_cache_options.ttl` — `30m` is the only supported value |
| Routing: useful for fallback-order optimization, insufficient for worker intelligence; manual selection rational | **VERIFIED** | matches my audit §11 (652 telemetry entries, 0 live SWE-Pro passes) |
| `ProviderContinuation` 4-mode abstraction (native_handle / opaque_replay / babel_replay / none); core must never hold task contract/acceptance/base commit/approvals under provider state | **VERIFIED as recommendation** | recommendation is sound and matches my carrier-lane proposal (E6); the "never provider-authoritative" boundary is also ADR-004-consistent |
| "Do not build a second verification framework / giant registry / always-on swarm / learned router / Agents SDK runtime" | **VERIFIED as recommendation** | matches my §16 DO_NOT_BUILD list and doc 02's |

### 2.2 Doc 02 (ChatGPT web audit) — strong second source

| Claim | Verdict | Evidence |
|---|---|---|
| Verdict `TARGETED_IMPROVEMENTS`; "Babel does not need to transform… it has already made much of that transformation" | **VERIFIED** | independent agreement |
| `LiveSessionV1` reconstructs execution state from durable events (task, provider, workspace, mutation identity, tool state, budgets, verifier, terminal status, failures) and reconciles interrupted effects rather than assuming completion | **VERIFIED** | `agent/chatEngineLiveSession.ts:32-59,107-130`; `paritySettleInterruptedOnResume` |
| "Provider registry describes capabilities mostly in terms of supported operations and transports — structured/raw requests, streaming, native tool modes — rather than richer execution characteristics" | **VERIFIED** | `runners/providerRegistry.ts:15-34` (`ProviderProtocol` + `ProviderOperation` only; no continuation/effort/caching fields) |
| "Codex CLI path is explicitly ephemeral" | **VERIFIED** | `runners/codexCli.ts:54-58` — one-shot `codex exec --full-auto`, stdin ignored, temp-file prompt, READ-ONLY neuter preamble, no resume/continue |
| "Babel's state and authority architecture is ahead of its provider-capability architecture" | **VERIFIED** | matches my G3; capability records exist (`providerCapabilities.ts`) but negotiation incomplete |
| P0: "prove that every mutation path is subordinate to Babel authority… a provider cannot gain authority merely because its native CLI/API can perform an operation" | **VERIFIED as gap** | my G1 (unwired classifier; dormant CLI runners could bypass if revived); its adversarial-probe requirement = my E7-A |
| P0: verified-success semantics unambiguous; worker claim = evidence, not verdict; terminal success bound to revision + checks + contract | **VERIFIED as gap** | `codingTaskSuccess` finding above; outcome binding exists in `verifierKernel.ts` but the *evaluation* label `pass` is not bound the same way |
| "Current model selection is deterministic eligibility/policy selection, not a speculative ML router" | **VERIFIED** | `modelPolicy.ts` stage routes + `routingEngine.ts` tier reorder |
| Learned performance router DEFER (P3) | **VERIFIED** | matches mine and docs 03/04/05 |
| Prompt caching `EXPERIMENT_FIRST` (P2) — measure cached tokens before redesigning prompts | **VERIFIED as recommendation** | consistent with my E1; more conservative than my P1 layout fix — the reconciliation (§4) splits the difference correctly |
| Capability matrix: `REJECT` for provider state as task truth, shared-worktree swarms, learned router, full rewrite | **VERIFIED as recommendation** | matches my §16 |

### 2.3 Doc 03 (Gemini) — verdict and current-state claims rejected

| Claim | Verdict | Evidence |
|---|---|---|
| Verdict `MAJOR_ARCHITECTURAL_OPPORTUNITY`; Babel "treats models as text-in/text-out stateless reasoning engines… client-side text replay, fragile post-hoc status parsing, unbounded context accumulation" | **CONTRADICTED** | structured native-tools rebuild (`threadEventLog.ts:283-341`); event-sourced authoritative state; compaction is *bounded* by token budget (128k trigger) — not unbounded |
| "Compaction defaults to sliding-window truncation or naive text summarization, blurring the boundary between scratchpad and authoritative execution state" | **CONTRADICTED** | H1 LLM compaction + deterministic capsule + dual-write commit; the boundary is the audit's §8 finding (capsule carries authoritative facts; summaries are cognitive) |
| "Verification primarily checks exit codes… lacks formal isolation between visible tests, immutable contracts, multi-model consensus" | **CONTRADICTED** | kernel decide, 14-reason promotion gate, adversarial signals, revision-bound receipts, clean-room (opt-in), diff critic — all exist; "multi-model consensus" is correctly absent (no voting, by design) |
| "Safety governed by configuration-level prompt instructions and basic pre-execution CLI confirmation prompts" | **CONTRADICTED** (in part) | capability broker (`capabilityBroker.ts`), sandbox path jail/allowlist, `policy.ts` presets exist. *Partially* right: the Class C/D **classifier** and git/publish gates are unwired (my G1) — the Gemini conclusion is the right direction for the wrong stated reason |
| "Automatic dynamic routing currently UNJUSTIFIED" | **VERIFIED** | consensus across all audits |
| Good generic ideas: opaque session continuation handle, deterministic normalizer with raw-output escape hatch, tiered execution gates, no automatic router, no unconstrained swarms, no prompt-level security as the only layer | **VERIFIED as design ideas** | sound; several are already partially in place (capability broker, tool-result trim, approval sessions) |
| Cost/latency estimates ("30–50% output-token drop", "40% input-token savings", "50–70% cost reduction") | **UNSUPPORTED** | no repo or run data cited; none of my evidence supports these magnitudes for Babel |
| "Babel currently treats model-generated summaries as truth" | **CONTRADICTED** | summaries are messages; authoritative facts live in capsule/receipts/events; honesty gate rejects unverified claims |

### 2.4 Doc 04 (Gemini Guide) — moderated verdict, similar current-state errors

| Claim | Verdict | Evidence |
|---|---|---|
| Verdict `TARGETED_IMPROVEMENTS` | **VERIFIED** (verdict only) | agrees with mine, 02, 05 |
| "Ephemeral, turn-by-turn text reconstruction" / "sliding-window truncation, naive token clipping" | **CONTRADICTED** | same evidence as §2.3; the text-flattening path exists only as the legacy surface and is flagged as a protocol violation by Babel's own validator |
| "Verification relies on visible test suites and secondary prompt passes, with loose separation between self-reports and tamper-proof contract evaluations" | **CONTRADICTED** | promotion gate + receipts + tamper hashing + kernel decide |
| "Babel currently injects volatile state (current timestamp, git commit hash, dynamic workspace file trees) near the top of system prompts" | **UNSUPPORTED** | no timestamp/date injection found in `chatEngine.ts` system-prompt build or `compiler.ts`; conversation head is `[system, capsule?, history]` (stable). No evidence for this specific claim |
| "Runtime permission gates are prompt-based / largely prose" | **PARTIALLY VERIFIED** | true for git/publish/delete/credentials inside Babel's runtime (prose rules + unwired classifier); false for tool-effect dispatch (capability broker + sandbox + policy presets are code) |
| "Automatic Dynamic Routing: Absent / Hardcoded" | **CONTRADICTED** | `routingEngine.ts` exists (telemetry-driven tier reorder, min 3 samples, opt-out env); its *deferral* recommendation is right, its "absent" description is wrong |
| "No proper cognitive/authoritative state separation" | **CONTRADICTED** | capsule + task contract + receipts + revision binding |
| `ProviderCapabilities` minimal interface (continuation/effort/structured/caching/context) as a *new* abstraction | **PARTIALLY VERIFIED** | the abstraction already exists (`agent/providerCapabilities.ts`) — the real gap is adapter *announcement*/negotiation (my G3); recommending it as absent is stale |
| Reasoning effort absent | **VERIFIED** | my G4 |
| "Pipeline: sequential 4-stage" / manifest-driven prompt compilation | **VERIFIED** | orchestrator → planning → execution → QA review; `compiler.ts` manifest compilation |
| "DO NOT BUILD: auto-router, swarms, vector memory, model-driven safety rails" | **VERIFIED as recommendation** | matches consensus; "vector memory" rejection also matches roadmap guardrails |

### 2.5 Doc 01 (ChatGPT meta) — guide review + reconciliation of the five reports

| Claim | Verdict | Evidence |
|---|---|---|
| Guide relevance ~9/10 for agent infrastructure; six principles (persistent cognition, compact context, deterministic offload, selective parallelism, eval-driven specialization, authority boundaries) | **VERIFIED** | matches my §5/§6 OpenAI-side research |
| "OpenAI recommends a default maximum concurrency of 3 subagents" | **UNVERIFIABLE from my evidence base** | my research confirmed "scheduling rules to limit unnecessary subagent calls" but not a specific "3" default on the pages fetched; treat as unconfirmed detail |
| ARC-AGI-3 13.3% → 38.3%, ~6× fewer output tokens | **VERIFIED (secondary)** | consistent with my research agent's secondary-source finding; flagged UNVERIFIED at primary source |
| Reconciliation ranking: DeepSeek-terminal (mine) highest for implementation; ChatGPT-web highest for architecture; Gemini reports low/very low | **VERIFIED as fair assessment** | matches the ledger above: docs 02/05 are evidence-grounded; docs 03/04 have sound instincts but contradicted current-state claims |
| "d92c02d is two commits ahead of bcd975f; the delta is session-event lifecycle work" | **VERIFIED** | git history: `d92c02d → 7bf95c2 → bcd975f` |
| "My report executed the autonomy-policy tests, 16/16 passing" | **VERIFIED** | executed during this review: 16/16 pass |
| Its P0 synthesis: trust-boundary correctness = (1) wire autonomy policy, (2) harden generic shell/MCP semantic effects, (3) canonicalize completion/outcome semantics; P1 = consolidate capability resolution, normalize evidence with raw refs, deterministic cache-friendly prefixes + cost accounting, effort as run dimension, materialized run truth, config-drift detection; P2 = the six experiments | **VERIFIED as fair synthesis** | this is the union of my P0/P1 and docs 02/05's P0/P1 — the "two layers of the same problem" framing (before-execution authority vs after-execution outcome semantics) is correct and is the right way to combine the two P0 lists |
| "Provider-native continuation should be split: design capability resolution now, implement Responses when reviving OpenAI, don't build an elaborate carrier subsystem with no live provider" | **VERIFIED as fair split** | matches my P3/EXPERIMENT_FIRST stance on carriers; also matches the "abstraction astronautics" warning in my adversarial review |

---

## 3. Inter-document agreement matrix (substantive conclusions)

| Conclusion | 01 | 02 | 03 | 04 | 05 | Mine | Consensus |
|---|---|---|---|---|---|---|---|
| Verdict TARGETED_IMPROVEMENTS (not redesign) | ✓ | ✓ | ✗ (MAJO) | ✓ | ✓ | ✓ | 5/6 |
| Babel is already execution/state/verification environment, not router | ✓ | ✓ | ✗ | ✗ (partially) | ✓ | ✓ | 4/6 |
| Verification/false-completion is a strength to preserve, not rebuild | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | 4/6 |
| Compaction exists and needs hardening, not invention | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | 4/6 |
| Cognitive vs authoritative state distinction exists in code | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | 4/6 |
| Automatic learned router: NOT justified | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6/6** |
| Always-on swarms / shared-worktree mutation: reject | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6/6** |
| Provider-native subagents: read-only experiments only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6/6** |
| Deterministic evidence reduction: high value, retain raw refs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6/6** |
| Prompt caching: measure first (EXPERIMENT_FIRST vs P1-layout split) | ✓ (split) | ✓ (P2) | ✓ | ✓ (P1) | ✓ (P2) | ✓ (P1 layout + E1) | 6/6 (timing differs) |
| Capability layer: extend existing, no giant registry | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6/6** |
| Reasoning continuity: EXPERIMENT_FIRST, never provider-authoritative | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6/6** |
| Modernize OpenAI adapter to Responses (when revived) | ✓ | ✓ | — | ✓ | ✓ | ✓ (P3) | 5/6 |
| Autonomy enforcement gaps (unwired classifier/presets) | ✓ | (P0-adjacent) | ~ | ~ | (P0.2-adjacent) | ✓ (P0) | 4/6 — only mine verified the wiring state directly |

The 6/6 items are the strongest consensus: **no router, no swarms, read-only subagents, evidence reduction with raw refs, extend-don't-invent capabilities, reasoning continuity as experiment with Babel-owned truth.** Everything with a consensus of 4/6 is a place where the two Gemini audits are wrong about the *current state* but their *recommendations* still align.

---

## 4. Assessment of the meta-reconciliation (doc 01, third segment)

The reconciliation is itself accurate and is the correct synthesis:

1. **Its ranking is fair** — verified by my ledger: docs 02/05 (and mine) are evidence-grounded; docs 03/04 describe a Babel that does not exist at either audited revision.
2. **The "two layers of the same P0" framing is correct**: my P0 (wire autonomy classifier/presets/auto-approve/credential-deny — *before-execution* authority) and docs 02/05's P0 (canonical outcome semantics — *after-execution* truth) are complementary, not competing. Both should be P0.
3. **Its caution on my P1 prompt-cache change** ("safe hardening now, provider optimization after measurement") is well-argued: the cost-accounting fix and deterministic ordering are correct regardless; cache-region markers wait for E1.
4. **One error to note**: it endorses the "max concurrency 3" claim without verification (see §2.5). Minor.

---

## 5. New findings surfaced by this cross-review (not in my original audit)

1. **Compiler lazy-stub threshold split — 8,000 vs 6,000 bytes** (`compiler.ts:267` vs `:357`). The same conceptual instruction stack can render different stub sets depending on compile path (sync vs async). Real reproducibility/cache-stability wrinkle; belongs on the G2 fix list (deterministic prompt construction).
2. **Two task-contract concepts coexist**: `src/taskCompletion.ts` (TaskContract: deliverable/evidence/grounding classification) vs `src/agent/taskContract.ts` (TaskContractV1: hash-frozen, acceptance criteria, budgets, effects). Docs 02/05 both cite the older one. Consolidation (doc 05 P1.1, my P1) is more justified than either audit knew.
3. **`codingTaskSuccess` `pass` semantics** — confirmed at source level (doc 05 P0.1); this is the one concrete place where an *evaluation* label can silently mean "patch produced but not verified." Small fix (label orthogonality), real statistical consequence for routing data.
4. **`classifyAutonomyAction` missing the external audits**: docs 03/04/05 all concluded "no git-push policy in code" — true at `bcd975f`, but the policy *does* exist in the current worktree (`autonomyPolicy.ts`) and is merely **unwired**. This is exactly the kind of finding that only a local dirty-worktree audit can make — it validates the two-revision methodology (doc 01's point).
5. **UNVERIFIED external claim**: "default maximum concurrency of 3 subagents" (doc 01). Not confirmed on any fetched official page.

---

## 6. Combined action list (what survives all strong audits)

**P0 — both layers (docs 02/05 + mine, endorsed by doc 01):**
1. Wire `classifyAutonomyAction` into dispatch (D→deny, C→ask) + apply C/D presets at `chatEngine.ts:4129-4136` + gate `BABEL_BENCHMARK_AUTO_APPROVE` + runtime credential-path deny. (Authority before execution.)
2. Canonicalize outcome semantics: `worker_claim / mutation / visible / contract / review / verified_success / false_completion` as orthogonal labeled dimensions; fix `codingTaskSuccess` `pass` ambiguity; bind evaluation labels to revision+checks. (Truth after execution.)
3. Adversarial authority probes across every provider/transport path (docs 02/05 P0) — includes the dormant CLI runners (Codex/Claude/Gemini), which would bypass the broker if revived.

**P1 — consolidation (docs 02/05 + mine):** capability resolution convergence (modelPolicy/providerCapabilities/providerRegistry) with adapter `announce()`; deterministic evidence normalization with raw refs; deterministic cache-friendly prompt construction (incl. the stub-threshold fix) + cache-aware cost accounting; effort as a first-class run dimension; materialized authoritative run record (one canonical view over existing events); config-drift detection; fix the two-task-contract split.

**P2 — experiments (all six docs agree on the protocol):** E1 cache layout; E2 evidence envelope; E3 compaction calibration; E4 effort dial; E5 routing ledger; E6 carrier passthrough (BLOCKED_REQUIRES_APPROVAL — needs live OpenAI); E7 autonomy adversarial suite + heterogeneous reviewer.

**Do not build (6/6 consensus):** automatic router, swarms, shared-worktree parallel mutation, provider reasoning as authoritative state, giant capability registry, second verification framework, consensus-voting-as-verification, hosted PTC clone, Agents-SDK-as-architecture, vector memory now.

---

## 7. Bottom line per document

| Doc | Use it for | Do NOT use it for |
|---|---|---|
| 05 (Independent) | Architecture judgment, P0.1/P0.2 semantics, experiments | — (highest external quality) |
| 02 (ChatGPT web) | Authority-boundary P0, provider-registry extension, telemetry | — (strong second source) |
| 01 (ChatGPT meta) | Reconciliation, prioritization, sequencing, the "two P0 layers" framing | the "3 subagent concurrency" detail |
| 04 (Gemini Guide) | Design brainstorming (evidence reduction, prompt layout, effort) | its "Babel today" column (contradicted) |
| 03 (Gemini) | Same — generic architecture instincts | its verdict and all current-state claims (contradicted) |

**Final assessment**: the five-document set converges on the same verdict as my audit — `TARGETED_IMPROVEMENTS`, Babel stays a capability-aware execution/state/verification environment, not a router. The two Gemini audits should not drive implementation; their useful ideas are already present in (or planned from) the strong audits. The single most important correction across all five documents is doc 01's: the two P0 lists are not competing — enforcement truth (wire the autonomy policy) and outcome truth (canonical semantics) are the before/after halves of the same trust boundary.

```text
CROSS_REVIEW_VERDICT: 5 documents reviewed in full; claims ledger verified against repo at d92c02d.
STRONG_AUDITS (02, 05, 01-reconciliation): VERIFIED - agree with local audit on verdict, P0/P1, experiments, DO-NOT-BUILD.
WEAK_AUDITS (03, 04): sound recommendations, CONTRADICTED current-state claims (text-replay, naive
  compaction, exit-code-only verification, prompt-only gates, no authoritative separation) -
  disproven by kernel/verifier/promotion-gate/compaction-capsule/event-log evidence.
NEW_FINDINGS: compiler.ts lazy-stub 8k-vs-6k threshold split (repro/cache wrinkle); two coexisting
  task-contract concepts (taskCompletion.ts vs taskContract.ts); codingTaskSuccess 'pass' allows
  UNVERIFIED_PATCH without verifier (confirmed at source); "concurrency=3 subagents" UNVERIFIED.
CONSENSUS_6OF6: no auto-router, no swarms, read-only subagents only, evidence reduction w/ raw refs,
  extend-don't-invent capabilities, reasoning continuity = EXPERIMENT_FIRST + Babel-owned truth.
COMBINED_P0: (1) wire autonomy classifier + C/D presets + gate auto-approve + runtime credential deny;
  (2) canonical outcome semantics + fix codingTaskSuccess pass ambiguity; (3) adversarial authority
  probes across all provider transports.
BASE_COMMIT: d92c02d (this review) / bcd975f (external audits' pin)
REPORT_PATH: docs/status/audits/gpt56-2026-08/BABEL_GPT56_AUDIT_CROSS_REVIEW.md (was uncommitted at review time, by design; relocated and tracked during the 2026-08-15 documentation reconciliation)
```