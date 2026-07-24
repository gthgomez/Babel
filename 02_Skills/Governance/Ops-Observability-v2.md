<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Ops Observability Protocol (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** `Ops-Observability-v1.md` (v1.1 preserved for reference)
**Pairs with:** `domain_swe_backend`, `domain_devops`, `domain_compliance_gpc`, `ols-compiler`
**Activation:** Load this skill for any task with side effects (DESIGN mode — plan-time contracts) or when capturing runtime observations, drift reports, and evidence bundles after execution (OBSERVE mode — closes the plan → execute → audit loop).

---

## Purpose

`[SFDIPOT-O]` is the second most common QA rejection tag after `[EVIDENCE-GATE]`. It fires when a
plan has no declared failure modes, no logging strategy, and no recovery path — and equally when the
actual execution diverges from the declared contract without detection.

Writing code that works in the happy path is not enough. Every operation that can fail will
eventually fail — in production, under load, with bad input, or during a deployment. And every
observed execution that drifts from its declared operational contract is a latent failure the plan
didn't catch.

This skill operates in two modes that feed each other:

- **DESIGN mode (v1.1 core, preserved):** Converts the SFDIPOT-O check from a reactive rejection into a proactive pre-plan requirement — producing the OPERATIONAL section before code is written.
- **OBSERVE mode (v2.0 new):** Captures what *actually* happened during a run — skill activations, tool calls, cost, state drift vs the DESIGN contract — and packages it into example_saas_backend-ready evidence bundles.

A plan with no OPERATIONAL section will fail silently in production. A run with no observation will
hide the drift until it becomes an incident. Silent failures are worse than loud ones.

---

## Mode Selection

Infer the mode from context. State it explicitly at the start of output.

| Signal | Mode |
|--------|------|
| User is writing a plan, designing a system, or authoring code with side effects | **DESIGN** |
| User asks for operational contract, failure analysis, recovery design, logging strategy | **DESIGN** |
| User asks to observe, trace, capture, or audit a completed run | **OBSERVE** |
| User references a prior OPERATIONAL section and wants to compare against execution | **OBSERVE** |
| User runs a multi-agent workflow and wants evidence / cost / drift afterward | **OBSERVE** |
| Ambiguous — no clear mode signal | Ask: "DESIGN (plan-time contract) or OBSERVE (capture what happened)?" |

Both modes can activate in the same session for different phases of the same task.

---

## Mode: DESIGN (Plan-Time Operational Contract)

### Activation Condition

Load DESIGN mode for any task that includes at least one of:
- A mutation (write, update, delete, insert to a database or external API)
- An external call (HTTP, webhook, queue, third-party SDK)
- A scheduled job, cron, or background worker
- A state transition (auth, payment, subscription, session)
- An operation that could fail silently (no response, partial success, missing record)

Do NOT load DESIGN mode for read-only evidence tasks or static analysis tasks.

### Step 1 — OPERATION SURFACE

For every operation in the plan's MINIMAL ACTION SET, declare:

| Operation | Type | Can Fail? | Failure Mode |
|-----------|------|-----------|-------------|
| `[operation name]` | [mutation / external_call / state_transition / scheduled] | YES / NO | [what happens when it fails] |

**Failure types to consider:**
- `SILENT` — operation fails with no error surfaced to caller
- `PARTIAL` — some but not all side effects were applied
- `TIMEOUT` — operation started but did not complete
- `IDEMPOTENT_VIOLATION` — retry causes a duplicate side effect
- `EXTERNAL_DEPENDENCY` — third-party service unavailable

If any operation has failure mode `SILENT` or `PARTIAL`, that operation requires a recovery path
in Step 3.

Also declare operational dependencies when relevant:
- scheduler or cron source
- queue or fallback store
- notification channel
- required environment variables
- operator-facing destination
- live authorization surface (RLS, grants, service-role bypass, policy path)
- partitioned-table behavior if reads or writes hit parent tables with attached partitions
- deployment/cache layer if runtime behavior depends on schema visibility or fresh function code

### Step 2 — LOGGING STRATEGY

For each operation classified in Step 1, declare what is logged and at what level.

| Event | Level | Fields |
|-------|-------|--------|
| Operation start | `info` | [request_id, user_id, operation_name, timestamp] |
| Operation success | `info` | [request_id, duration_ms, result_summary] |
| Recoverable error | `warn` | [request_id, error_code, retry_count, context] |
| Unrecoverable error | `error` | [request_id, error_code, stack_trace, context] |
| Silent failure detected | `error` | [request_id, expected_state, observed_state] |

**Minimum logging contract:**
- Every external call must log at start and completion (success or failure).
- Every state transition must log before and after state with a correlation ID.
- Every unrecoverable error must log enough context to reproduce the failure without guessing.
- Every scheduled job must log run start, run end, outcome, and affected counts.
- Every alerting path must log both detection and delivery outcome.
- Every operator workflow must name where failures become visible.
- Every alert raised by a scheduled job must be traceable back to a concrete run ledger row or correlation ID.
- Every deduplicated alert path must define how severity escalation is surfaced, not just how duplicates are suppressed.
- Every stateful permission or policy change must declare how live remote verification is performed after apply.

If the task cannot guarantee structured logging, declare it explicitly:

```
LOGGING: Unstructured — error propagation is caller-dependent. No centralized log surface.
```

### Step 3 — RECOVERY PATHS

For each operation with a non-trivial failure mode, declare the recovery path:

| Operation | Failure Mode | Recovery Strategy | Retry? | Fallback? |
|-----------|-------------|-------------------|--------|-----------|
| `[operation]` | `[mode]` | [description] | YES (n times, backoff) / NO | YES / NO |

**Recovery strategy options:**

| Strategy | Description |
|----------|-------------|
| `RETRY_WITH_BACKOFF` | Retries up to N times with exponential backoff. |
| `CIRCUIT_BREAKER` | Fails fast after N consecutive failures; recovers after timeout. |
| `IDEMPOTENT_REPLAY` | Safe to replay because operation is idempotent. Requires justification. |
| `COMPENSATING_TRANSACTION` | Undo prior steps if a subsequent step fails. |
| `DEAD_LETTER` | Route failed items to DLQ for manual recovery. |
| `FAIL_CLOSED` | Reject new operations until failure is resolved. Use for safety-critical paths. |
| `FAIL_OPEN` | Allow operations to continue despite failure. Use only for low-safety paths. |
| `OPERATOR_ESCALATION` | Route failure to a named human/operator workflow with a runbook path. |

**Rule:** `FAIL_OPEN` on a safety-critical path (auth, payment, permissions check) requires explicit
justification in KNOWN FACTS. The default for safety-critical paths is `FAIL_CLOSED`.

**When `skill_idempotency` is also loaded:** Do not justify `IDEMPOTENT_REPLAY` inline here.
Reference the IDEMPOTENCY CONTRACT section produced by `skill_idempotency` instead — it already
classifies the operation and provides the deduplication proof. Write:
`IDEMPOTENT_REPLAY — see IDEMPOTENCY CONTRACT` in the recovery table and leave the full
justification to that section.

If the task adds a job, alert, or support/compliance workflow, the recovery table must also name:
- where the failure is surfaced
- who is expected to act
- whether the system continues `FAIL_OPEN` or `FAIL_CLOSED`
- whether recurrence, escalation, acknowledgement, resolution, and stale-alert handling are explicit

If the task depends on database authorization or schema visibility, the recovery table must also name:
- how grant drift is detected
- whether future partitions inherit the required privileges
- whether schema cache or function redeploy is required before the system is truly recovered

### DESIGN Mode Output Structure

When Steps 1–3 complete, add an OPERATIONAL section to the plan using this structure:

```
OPERATIONAL
───────────
Operation Surface:
  [table from Step 1 — operation, type, failure mode per row]

Logging:
  [key events and log levels — include correlation ID scheme]

Recovery:
  [operation → strategy pairs]

Failure Modes Unmitigated:
  [any operation with no recovery path — state why it is acceptable]

Visibility:
  [where operators see job health, alert state, and stuck items]
  [where live grant/policy state is checked if auth or RLS is in the blast radius]
```

This section must appear in the plan before VERIFICATION METHOD.

### Hard Rules (DESIGN Mode)

1. Never mark an operation `Can Fail: NO` if it involves an external call or a DB write. All
   external calls and DB writes can fail.
2. Never declare `FAIL_OPEN` on auth, payment, or permissions operations without explicit
   justification in KNOWN FACTS.
3. A comment in code (`// log this`) is not a logging strategy. The logging strategy must name
   the fields, the level, and the correlation ID scheme.
4. A plan with PARTIAL failure modes and no compensating transaction or idempotency guarantee
   is not safe to execute.
5. If the task modifies an existing operation that already has a logging or recovery strategy,
   the plan must explicitly preserve or supersede that strategy — not silently replace it.
6. A job with no execution ledger, last-run signal, or visible failure surface is not operationally complete.
7. "We can inspect logs later" is not an operator surface.
8. A deduplicated alert with no escalation rule can silently hide the moment an incident becomes critical.
9. A multi-step job that records only all-or-nothing success/failure is missing partial-failure evidence.
10. A stateful fix that is applied manually to remote infrastructure but not represented in versioned code is not operationally complete.

---

## Mode: OBSERVE (Runtime Capture & Drift Detection)

### Activation Condition

Load OBSERVE mode when:
- A workflow run has completed and you need a structured observation report
- The user asks to trace, observe, capture, or audit what happened during execution
- A DESIGN-mode OPERATIONAL contract exists and the user wants to compare actual behavior to declared behavior
- Evidence bundles are needed for example_saas_backend compliance or run audits
- Multi-agent or multi-tool runs where cost, drift, and state tracking matter

### Core Instructions

When activated in OBSERVE mode:

1. **Load the DESIGN contract (if available):** If a prior plan produced an OPERATIONAL section, load it as the expected-state reference. If unavailable, mark comparison as `DEFERRED` and still capture all raw observations.

2. **Capture skill activations:** For each skill/agent activated during the run, record:
   - Skill name and activation time
   - Depth mode or tier (if applicable)
   - Input summary (1-line)
   - Outcome (completed / failed / redirected)

3. **Trace tool calls:** For each tool invocation, record:
   - Tool name
   - Success / failure
   - Approximate latency (fast / moderate / slow)
   - Response shape or size summary (if available)

4. **Track costs:**
   - Token usage per activation (where provider reports it)
   - Cumulative run total at end
   - Flag any activation that exceeded expected cost range

5. **Detect drift:** Compare each observed behavior against the DESIGN-mode OPERATIONAL contract:
   - Logging gaps: "Contract declared correlation_id on every state transition → observed 2 of 5 transitions logged without correlation_id"
   - Recovery drift: "Contract declared RETRY_WITH_BACKOFF → observed single-shot attempt with no retry"
   - Visibility gaps: "Contract declared operator-facing dashboard → no evidence of dashboard update in tool calls"
   - Severity: `CRITICAL` (safety path), `MAJOR` (compliance/reliability), `MINOR` (cosmetic/non-blocking)

6. **Generate evidence bundle:** Package into a single report:
   - Run metadata (correlation_id, start/end timestamps, duration, cost)
   - Activation log
   - Tool call trace
   - Drift report (if DESIGN contract was available)
   - Verdict and handoff recommendation

### OBSERVE Mode Output Structure

Use this consistent structure:

```
RUN OBSERVATION
───────────────
Run: [correlation_id]
Duration: [start → end, total ms]
Cost: [total tokens] / [estimated $ if provider pricing available]
Depth: [LIGHT / STANDARD / DEEP / PRODUCTION]
Verdict: CLEAN / DRIFT_DETECTED / INCOMPLETE / THIN

Activations (in order):
  [ts]  [skill_name]  [depth]  → [outcome]
  ...

Tool Calls (in order):
  [ts]  [tool_name]  [success/fail]  [latency]  [notes]
  ...

Drift Report (vs DESIGN contract):
  [declared behavior] → [observed behavior] → [severity]
  (If no DESIGN contract available: DEFERRED — no expected state to compare against)
  ...

Evidence Bundle:
  Summary: [1-line summary of key findings]
  example_saas_backend-ready: YES / NO (gaps listed below)
  Storage: [recommended path for this run's evidence bundle if saving]

Handoff Recommendation:
  [If drift detected: "Activate ols-compiler to harden the OPERATIONAL contract against these specific drifts: ..."
   If clean: "DESIGN contract held. No hardening needed."
   If incomplete: "Re-run with full tool access or longer observation window."]
```

### OBSERVE Mode Hard Rules

1. Never fabricate tool call outcomes or token counts — mark missing data as `[UNKNOWN]`.
2. Every drift flag must cite the specific DESIGN contract line or rule it violates.
3. Cost estimates must be labeled as `[ESTIMATED]` unless confirmed from provider response.
4. A run with zero drift flags but no DESIGN contract to compare against is INCOMPLETE, not CLEAN.
5. Evidence bundles are only example_saas_backend-ready if they include correlation IDs, timestamps, and a drift verdict with evidence labels.

---

## Integration: Closing the Loop

DESIGN mode and OBSERVE mode are not independent — they form a feedback loop:

```
DESIGN (plan-time)
  └─→ produces OPERATIONAL contract
       └─→ feeds OBSERVE mode's expected-state reference
            └─→ OBSERVE captures actual execution + drift
                 └─→ drift report feeds back into DESIGN mode
                      └─→ contract hardened → re-execute → re-observe
```

**Explicit handoff points:**
- After DESIGN mode produces an OPERATIONAL section, remind: "After execution, activate this skill in OBSERVE mode with this OPERATIONAL section as the contract to verify."
- After OBSERVE mode detects drift, recommend: "Activate ols-compiler with this drift report to harden the operational contract. Then re-run and re-observe."
- For systemic patterns (same drift across multiple runs): Escalate recommendation to include skill-auditor review of the broader skill/prompt that produced the contract.

---

## Boundaries — Do Not Overstep

- **DESIGN mode** focuses on plan-time operational contracts. It does not capture runtime execution — use OBSERVE mode for that.
- **OBSERVE mode** captures and diffs execution. It does not design recovery paths or rewrite operational contracts — hand off to DESIGN mode or ols-compiler for that.
- This skill does **not** replace structured logging infrastructure (Supabase logs, Pino, OpenTelemetry, etc.). It augments them with contract-to-actual comparison at the Babel/OLS layer.
- Cost tracking is best-effort. Token counts are available when the provider reports them; dollar costs depend on provider pricing at run time. Always label cost figures with their evidence label.
- Do not duplicate the adversarial testing or semantic audit roles of prompt-tester and skill-auditor. OBSERVE mode observes *execution*, not prompt robustness.

---

## Failure Behavior of This Skill

- **DESIGN contract unavailable for OBSERVE comparison:** Still capture all raw observations. Mark the comparison as `DEFERRED`. Flag the gap explicitly in the drift report. The observation still has value as a run record.
- **Run too short or shallow for meaningful observation:** Mark verdict as `THIN`. State the minimum threshold that would produce a meaningful observation, and suggest a longer or more complex task.
- **Ambiguous mode request:** Ask the single clarifying question — "DESIGN (plan-time contract) or OBSERVE (capture what happened)?" — and proceed.
- **Self-test / meta case:** This skill should be used in OBSERVE mode during its own creation and editing sessions. A mature version should observe itself producing a CLEAN run against its own DESIGN contract.
- **When this skill itself is the target of audit:** skill-auditor should be activated on it after any substantial edit, applying the full audit criteria including the new dual-mode structure, progressive disclosure across modes, and non-duplication with ols-compiler / prompt-tester.

---

## References

- `references/observe-schemas.md` — JSON schemas for run ledger entries, drift report structure, and evidence bundle format. Load for programmatic evidence generation or when building automated observation pipelines.
- ols-compiler skill (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — activate for hardening operational contracts when OBSERVE mode detects drift patterns.
- prompt-tester skill (`04_Meta_Tools/OLS-MCC/prompt-tester/SKILL.md`) — activate if adversarial testing of the operational contract itself is needed (e.g. testing whether the logging strategy survives injection or role-override attacks).
- skill-auditor skill (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — activate for deep semantic audit of this skill itself or of skills that repeatedly produce drifted OPERATIONAL contracts.

## Strategic Next Move

After any substantial DESIGN or OBSERVE output, end with exactly one strategic next-move question: for DESIGN mode, ask whether to proceed to execution and observation; for OBSERVE mode, ask whether to harden the contract (ols-compiler) or audit the producing skill (skill-auditor).

---

**Design note:** This v2.0 synthesizes the original v1.1 plan-time protocol (DESIGN mode, preserved with minimal polish) with the runtime-observer behavior the OLS-MCC roadmap identified as a production gap (OBSERVE mode). The dual-mode structure follows the same pattern as the OLS-MCC triad: lean activation layer, deep reference files, explicit Boundaries, Failure Behavior, and handoff contracts. It directly closes the plan → execute → audit loop that the roadmap's Phase 1 targets.
