# S07 — Ordinary-Loop Qualification (deterministic)

Status: **candidate evidence**, on branch `test/s07-ordinary-loop-qualification`
(based on the Phase A combined candidate `integration/combined-218-219`).

This document records the deterministic ordinary single-agent loop qualification
that the prior S07 regression did not cover. The earlier S07 work proved
*prepared-request* semantics (one effective operation, no injected edit mandate).
This lane exercises the **actual loop**: real `ChatEngine`, real tools, real
fixtures, deterministic scripted providers.

## What is exercised

Test entry point: `babel-cli/src/agent/s07OrdinaryLoop.test.ts`
(streamed production path `submitMessageStream`, scripted provider injected at
the ChatEngine runner seam, real fixture repository).

| # | Scenario | Task | Required result | Status |
|---|---|---|---|---|
| 1 | Ordinary investigation | "Investigate why parser_test is failing. Do not edit files." | READ_ONLY, 0 writes, ≥3 useful reads, useful synthesis, bounded, no false terminal | PASS |
| 2 | Failed search | "Find where nonexistent_symbol is defined." | READ_ONLY, 0 writes, bounded, honest not-found + searched scope | PASS |
| 3 | Mixed inspect + mutate | "Investigate why parser_test fails and fix it." | HYBRID, reads then an authorized scoped `str_replace`, verifier, completes | PASS (after S07-H1 fix) |
| 4 | Explicit no-edit | "Review this implementation and explain the defect. Do not modify files." | READ_ONLY, 0 writes, no patch pressure, useful synthesis | PASS |
| 9 | Provider failure after partial progress | "Investigate why parser_test is failing." (2nd provider call fails) | prior read evidence retained, no fabricated VERIFIED_COMPLETE, no capability fiction, honest infra/model failure | PASS |

Every scenario emits a compact machine-readable trace (`S07_TRACE <json>` when
`S07_TRACE` is set) with: scenario id, source sha, entrypoint, task, resolved
operation, task class, provider calls, tool calls/targets, writes, mutation
batches, progress signals, terminal outcome/status, final-answer presence. The
trace is diagnostic evidence only — never a second runtime authority.

### Not yet covered (explicit)

| Scenario | Why deferred |
|---|---|
| 5 repeated-read loop | needs the D03 terminal-reason branch to assert "recovery exhausted, not permission denied" honestly |
| 6 post-compaction reread | needs the P11 context-epoch lane |
| 7 child inspection / conclusion handoff | the live sub_agent path constructs its own child engine; a scripted child provider seam is required |
| 8 cancellation then new task | requires a multi-submission harness with settlement barriers (S06 covers the state-reset half) |
| state variants | fresh/reused/continued are covered by the S06 lane (`chatOperationPolicy.test.ts`, `chatEngine.freshTaskRecovery.test.ts`); this suite intentionally uses a fresh engine per scenario |

## S07-H1 — write + authoritative verifier corrupted the loop (FIXED)

**Severity:** critical ordinary-loop. A capable model that read, applied a scoped
fix, ran an authoritative verifier (`npm test` / `run_command` / `test_run`), and
reported done did **not** complete: the next provider request aborted.

**Reproduction (controlled, identical on `main` and on the combined candidate):**
- fixture project with `parser.ts`, a passing `verify.mjs`, and `package.json`
  `test` = `node verify.mjs`
- native transport (stubbed `fetch`) scripted: `read_file → read_file →
  str_replace → run_command npm test → text`
- observed event stream: `tool_complete` (exit 0) **immediately followed by** a
  spurious `tool_failed` for the same tool call
- observed abort: `[runtime-invariant:provider_protocol_valid] … duplicate_tool_call_id
  (Assistant tool_call id=… appears more than once); duplicate_tool_result …`

**Root cause (two compounding defects):**
1. `captureChatVerifierReceipt` passed `mutationPathsFromSessionEvents(...)` —
   the governed mutation path reports **absolute** paths (e.g.
   `/tmp/…/parser.ts`) — into `RevisionManager.computeRevision`, whose
   `assertProjectRelativePath` rejects any absolute path and throws
   `Revision scope path must be repository-relative`.
2. That throw escaped into `executeOneAction`'s generic `catch`, which pushes a
   **second** `toolCallLog` entry (`error: 'error'`) and emits a second
   `toolFailed` terminal for a tool call that had already settled successfully.
   The duplicate terminal then lands twice in the outbound assistant/tool
   conversation and trips the `provider_protocol_valid` runtime invariant.

The durable session log stayed clean (one terminal), which is why this was
invisible to log-only checks and only surfaced on the next provider request.

**Fix (contained):**
- `chatEngineVerifierAdapter.ts`: canonicalize scope paths to POSIX
  repository-relative before revision binding (absolute-inside-root → relative;
  already-relative passes through; any path escaping the root fails closed to
  "no receipt" rather than minting a misleading scope).
- `chatEngine.ts`: wrap the verifier-receipt capture so a binding failure
  degrades to an explicit `verifier_receipt_unavailable` observation and ledger
  invalidation — it never falls through to the generic catch that records a
  duplicate terminal.

**Regression pin:** `babel-cli/src/agent/verifierReceiptLoop.test.ts` drives the
native transport and asserts a single durable terminal for the verifier call, a
recorded authoritative `verifier_attempt`, and a clean `done`.

## Attribution (harness vs model)

| Scenario | Outcome | Attribution |
|---|---|---|
| 1–4 | completes / honest not-found | TASK_SUCCESS (model behaviour scripted deterministically) |
| 3 pre-fix | abort / budget exhaustion after correct model behaviour | **HARNESS_CAUSED_FAILURE** (S07-H1) — holding model + tools constant, the integrated harness removes the failure |
| 9 | honest failure | MODEL/PROVIDER (scripted provider failure); prior evidence retained |

The S07-H1 control holds task, fixture, scripted provider behaviour, tool
outputs, policy and budget constant: only the harness changed, and the failure
removed. This satisfies the "harness-caused failure" evidentiary bar.

## How to run

```bash
cd babel-cli
npx tsx --no-warnings=ExperimentalWarning --test-concurrency=1 --test \
  src/agent/s07OrdinaryLoop.test.ts src/agent/verifierReceiptLoop.test.ts
```

## Remaining work

- Extend to scenarios 5–8 once D03 (terminal reasons), P11 (context epochs) and
  the child-provider seam land.
- Scenario 1/2/4 currently report `UNVERIFIED_PATCH` for zero-write read-only
  turns; the correct outcome for an informational answer is `NO_CHANGE_REQUIRED`.
  This is a terminal-outcome projection gap tracked with D03/D01 — not a write
  or mutation-authority defect.
- Wire S07-H1's path normalization into `main` (the defect is pre-existing on
  `main`; the fix currently lives on the candidate branch).
