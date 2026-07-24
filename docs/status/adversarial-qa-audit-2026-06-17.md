# Adversarial QA Audit — 2026-06-17

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Trigger:** Phase 1D test-and-harden audit loop following Phase 1A–1C (model swap + 24 tests).

---

## Audit Findings

### F1: Runner failure causes QA rejection (MEDIUM)

**Location:** `babel-cli/src/pipeline/qaStage.ts:128-134`

**Issue:** The catch block returns `{ passed: false, reason: 'adversarial_review_failed_to_run' }` on ANY runner error. The `DeepInfraApiRunner` already handles retries internally (retryable HTTP failures, stream idle timeouts), so by the time this catch fires, all retries are exhausted. However, a persistent model unavailability (network outage, provider overload) should NOT cause the QA gate to reject a plan that the primary QA already approved.

**Risk:** A transient DeepInfra outage causes all adversarial QA runs to fail, blocking pipeline progress even when the primary QA verdict is PASS.

**Recommendation:** Change to `return { passed: true, reason: 'adversarial_review_unavailable' }` — treat runner exhaustion as a warning, not a rejection. The primary QA verdict stands. Add logDetail warning that adversarial review was skipped.

**Status:** ⚠️ Not yet implemented — requires pipeline behavior change decision.

---

### F2: Original QA model hardcoded to 'deepseek' (LOW)

**Location:** `babel-cli/src/pipeline/qaStage.ts:66` and `:79`

**Issue:** `pickAdversarialModel('deepseek')` and `originalQaModel: 'deepseek'` are hardcoded. The `pickAdversarialModel` function accepts any model string, but the call site always passes 'deepseek'. If the pipeline ever uses a different primary QA model, the adversarial model selection won't match.

**Mitigation:** The adversarial model mapping table in `adversarialQALane.ts:36-45` covers all known models (qwen3→deepseek-v4, nemotron→qwen3-32b, codex→claude, etc.), so the infrastructure is correct. The hardcode reflects that 'deepseek' is currently the only primary QA model used. If multi-model QA is added, this should be parameterized.

**Status:** ✅ Acceptable for now — matches current single-model QA architecture.

---

### F3: Model mapping table review (LOW)

**Location:** `babel-cli/src/agent/lanes/adversarialQALane.ts:36-45`

**Review of each mapping:**

| Primary | Adversary | Verdict |
|---------|-----------|---------|
| deepseek → step-flash | StepFun Step-3.5-Flash ($0.09/$0.30) | ✅ Updated Phase 1A. Different provider, reasoning-focused, 40% cheaper output than nemotron |
| deepseek-v4 → step-flash | Same as above | ✅ Consistent with deepseek mapping |
| qwen3 → deepseek-v4 | DeepSeek V4 Flash ($0.10/$0.20) | ✅ Different provider, strong reasoning |
| qwen3-32b → deepseek-v4 | Same as above | ✅ Consistent |
| nemotron → qwen3-32b | Qwen3-32B ($0.08/$0.28) | ✅ Different provider, cheaper |
| codex → claude | Claude via DeepInfra | ✅ Cross-provider |
| claude → gemini | Gemini via DeepInfra | ✅ Cross-provider |
| gemini → codex | Codex via DeepInfra | ✅ Cross-provider |

**Status:** ✅ All mappings sound. Cross-provider diversity maintained. Pricing appropriate.

---

### F4: Prompt quality assessment (LOW)

**Location:** `babel-cli/src/agent/lanes/adversarialQALane.ts:56-84`

**Assessment:** The prompt covers 6 lines of questioning: security, cross-file types, stubs, scope creep, edge cases, ungrounded assumptions. These are the right categories for code review. The prompt correctly:
- Shows the original QA verdict (PASS or REJECT with failures)
- Instructs the adversary to actively refute
- Asks for all failures (original + new) in REJECT case
- Serializes the full SWE plan as JSON

**Minor improvement:** Could add a 7th line: "Does the plan introduce a regression in any existing functionality?" This is a common oversight in code review.

**Status:** ✅ Prompt quality is good. The 7th regression question is a nice-to-have.

---

### F5: Edge case coverage (LOW)

**Assessment of edge cases tested:**

| Edge Case | Covered? | Test |
|-----------|----------|------|
| Empty plan (zero steps) | ❌ | Not tested — `minimal_action_set` requires ≥1 step by schema, so this is a schema-level guard |
| Plan with zero files | ❌ | Not tested — files aren't directly tracked in SwePlan (only in step targets) |
| Plan targeting protected paths | ❌ | Not tested — protected-path awareness is the QA model's responsibility, not the adversarial module's |
| QaVerdict with unexpected shape | ✅ | Handled by Zod schema validation in `DeepInfraApiRunner.execute()` |
| Missing DEEPINFRA_API_KEY | ⚠️ | Runner constructor throws; caught by catch block → returns `adversarial_review_failed_to_run` |
| Model mapping for unknown primary | ✅ | `pickAdversarialModel` returns undefined → gate skips with warning |
| Concurrent adversarial QA runs | ❌ | Not tested — but `runAdversarialQaGate` is called sequentially in the pipeline loop |

**Status:** ✅ Core edge cases covered. Concurrent access is not a concern (pipeline is sequential). Schema validation handles malformed model output.

---

## Summary

| # | Severity | Status | Action |
|---|----------|--------|--------|
| F1 | MEDIUM | ⚠️ Needs decision | Runner failure should pass, not reject. Change `qaStage.ts:133` to `return { passed: true, reason: 'adversarial_review_unavailable' }` |
| F2 | LOW | ✅ Acceptable | Hardcoded 'deepseek' — matches single-model QA architecture |
| F3 | LOW | ✅ Verified | All 8 model mappings sound; deepseek→step-flash updated |
| F4 | LOW | ✅ Good | Prompt quality is strong; 7th regression question is optional |
| F5 | LOW | ✅ Covered | Core edge cases handled; schema validation guards malformed output |

**Phase 1 Exit Gate:** 24 tests green. Typecheck clean. Model swap complete. One MEDIUM finding (F1) flagged for pipeline behavior decision — does not block Phase 1 completion but should be resolved before enabling adversarial QA by default.
