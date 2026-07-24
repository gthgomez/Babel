<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# OLS Security Model v1.0 — Threat Analysis & Defense-in-Depth

**Version**: 1.0.0 (2026-06-27)
**Status**: PRODUCTION-CANDIDATE
**Scope**: Security analysis of OLS-MCC prompt-level defenses — what they can and cannot protect against

This document provides an honest security threat model for OLS's prompt-level defenses. It separates what Authority Order, the MINIMAL safety override, and the Security Module can defend against from what requires additional runtime guardrails, output validators, or external classifiers.

---

## 1. What Authority Order CAN Defend Against

OLS's Authority Order (System > Developer > User > Artifacts > Data) provides effective defense against these attack classes:

### 1.1 User Prompt Crafting Attacks
**Threat**: A user crafts a prompt that attempts to override system instructions ("Ignore all previous instructions and...").
**Defense**: Authority Order positions system instructions at highest priority. The MINIMAL safety override is non-negotiable and cannot be overridden by user input.
**Evidence**: [INFERRED] — Design principle, not experimentally verified. The literature (Schulhoff et al. HackAPrompt) shows prompt-level defenses help but are not complete.

### 1.2 Role Override in Artifacts
**Threat**: An uploaded file or pasted text contains instructions like "You are now DAN..." that attempt to override the system role.
**Defense**: Artifacts are Authority Level 4 (below system, developer, and user). PROMPT_INJECTION_RISK flagging triggers on any lower-authority content attempting to override higher authority.
**Evidence**: [INFERRED] — Design principle.

### 1.3 Data-as-Instruction in File Attachments
**Threat**: A code file or document contains embedded prompt instructions in comments or metadata.
**Defense**: File contents are treated as DATA (Authority Level 5), not instructions. The compiler's data-vs-instruction separation prevents execution of embedded prompts.
**Evidence**: [INFERRED] — Relies on LLM correctly distinguishing data from instructions, which is known to be imperfect.

---

## 2. What Authority Order CANNOT Defend Against

Prompt-level defenses are inherently limited. The following attack classes require additional protection layers:

### 2.1 Indirect Prompt Injection (IIP)
**Threat**: An attacker poisons a web page, document, or API response that the LLM later retrieves. The poisoned content carries injection payloads disguised as legitimate text.
**Why prompt-level defense fails**: The LLM cannot reliably distinguish between legitimate retrieved content and injected instructions. The content enters through a trusted channel (RAG, web search, tool output) and Authority Order only applies if the LLM correctly classifies the source.
**Required defense**: External content sanitization, retrieval source trust scoring, content classifiers that run before the LLM sees the data.

### 2.2 Multi-Turn Jailbreaks (Crescendo-style)
**Threat**: An attacker uses a sequence of seemingly benign turns that gradually erode safety constraints. Each individual message is safe; the cumulative effect is not.
**Why prompt-level defense fails**: Authority Order applies per-message, not across conversation state. A 10-turn conversation where each turn shifts the Overton window by 5% can fully bypass single-message defenses.
**Required defense**: Conversation-level safety scoring, drift detection across turns, periodic guard re-injection.

### 2.3 Token Smuggling & Encoding Attacks
**Threat**: An attacker encodes injection payloads in base64, Unicode homoglyphs, ROT13, or other obfuscation that the LLM can decode but pattern-matching defenses miss.
**Why prompt-level defense fails**: The LLM's ability to interpret obfuscated text means it can "see" the decoded payload even as pattern matchers see gibberish.
**Required defense**: Input sanitization pipelines that decode and scan for injection patterns before the text reaches the LLM.

### 2.4 Steganographic Payloads in Code
**Threat**: An attacker hides injection instructions in code comments, variable names, or string literals that the LLM is asked to review or execute.
**Why prompt-level defense fails**: Code is inherently instructional — distinguishing between legitimate code instructions and injected prompt instructions is a semantic problem, not a syntactic one.
**Required defense**: Sandboxed code execution, output validation on code review results.

### 2.5 Compromised Tool Outputs
**Threat**: A tool called by the LLM (e.g., `read_file`, `web_search`, `bash`) returns attacker-controlled output containing injection payloads.
**Why prompt-level defense fails**: Tool outputs enter as trusted system messages. If the tool's output source is compromised, the injection bypasses Authority Order entirely.
**Required defense**: Tool output sanitization, tool capability restriction, output validation before the LLM processes tool results.

---

## 3. Defense-in-Depth Architecture

| Layer | Mechanism | Type | Protects Against |
|-------|-----------|------|-----------------|
| **Layer 1** | Authority Order + MINIMAL override + PROMPT_INJECTION_RISK flagging | Prompt-level | User crafting attacks, role override, data-as-instruction (partial) |
| **Layer 2** | Runtime output validation + Verdict Gates + Evidence Labels | Code-level output checking | Fabricated evidence, unsafe code generation, deployment without verification |
| **Layer 3** | External guardrails + content classifiers + input sanitization | Infrastructure-level | IIP, multi-turn drift, token smuggling, tool output poisoning |

**Critical principle**: Layer 1 (prompt-level) is necessary but not sufficient. OLS's Authority Order provides the first line of defense, not the only line. Production deployments must combine all three layers.

---

## 4. Dynamic Alignment Engine — Threat Model

The v4.5 Dynamic Alignment Engine injects runtime guidelines based on observed context. This creates specific attack surfaces:

### 4.1 Alignment Source Poisoning
**Threat**: An attacker compromises the source that feeds the Dynamic Alignment Engine (a database, configuration file, or API). Poisoned guidelines are injected with system-level authority.
**Mitigation**: Alignment sources must be treated as untrusted input. Guidelines should carry provenance metadata. The Coherence Validation (v4.5.1) checks for contradictions between injected guidelines and static authority rules, but this is itself a prompt-level check — it inherits Layer 1 limitations.

### 4.2 Recursive Injection
**Threat**: An attacker injects at turn N a payload that influences the Dynamic Alignment Engine's output at turn N+1, which then appears to come from the trusted system layer at turn N+2.
**Mitigation**: Alignment engine output should be tagged with `[ALIGNMENT_INJECTED]` provenance markers. The LLM should be instructed that alignment-injected content carries lower authority than static system instructions, even though both come from "the system."

### 4.3 Specification Gaming by the Optimizer
**Threat**: The v4.5 Reflection Optimizer modifies prompts to maximize eval scores. If the eval set doesn't test for safety properties, the optimizer may learn to remove safety instructions that "hurt" performance metrics.
**Mitigation**: Eval Set Integrity Check (v4.5.1 Section 8.1) scans for safety bypass attempts. Eval sets must include safety-specific test cases, not just task accuracy metrics. This is a mandatory check — not suggested, not optional.

---

## 5. Self-Application Security Analysis

OLS's self-application rules (v4.5.1) require human + auditor review for any optimizer-generated changes to OLS meta-tools. This section analyzes the security properties of this review process.

### 5.1 Human Review Fatigue
**Risk**: If the optimizer generates dozens of proposals per day, reviewers will rubber-stamp.
**Mitigation**: Batch proposals. Review no more than 3 per session. Require explicit approval per proposal, not bulk approval.

### 5.2 Optimizer as Threat Vector
**Risk**: The Reflection Optimizer uses LLM reflection to modify prompts. If the reflection model is compromised or returns superficially plausible but vulnerable changes, the human reviewer sees only the diff.
**Mitigation**: Optimizer output must include: (a) the full original prompt, (b) the full modified prompt, (c) a diff, (d) the eval set used, (e) the specific metrics that improved. Reviewers should read the full modified prompt, not just the diff.

### 5.3 Auditor Adversarial Capability
**Risk**: skill-auditor performs semantic review, not adversarial testing. A vulnerability that survives the optimizer's eval set will also survive semantic review.
**Mitigation**: All optimizer-generated changes must pass prompt-tester adversarial evaluation BEFORE skill-auditor semantic review. The Create → Test → Audit loop must be enforced in that order.

---

## 6. Explicit Limitations Acknowledgment

**Prompt-level injection defenses are inherently limited.** The academic literature (Schulhoff et al. 2024, HackAPrompt competition; The Prompt Report, arXiv:2406.06608) has demonstrated that no prompt-based technique achieves 100% protection against determined adversarial attacks. OLS's Authority Order, Security Module, and MINIMAL safety override provide defense-in-depth Layer 1 — a necessary first line of defense, not a complete security solution.

**What OLS claims**: Authority Order raises the cost of injection attacks by forcing attackers to overcome explicit priority rules. It makes casual injection attempts fail. It provides a structured framework for the LLM to recognize and flag injection attempts.

**What OLS does NOT claim**: That Authority Order makes prompts immune to injection. That prompt-level defenses are sufficient for production without additional guardrails. That any specific attack class (IIP, multi-turn, token smuggling) is fully mitigated by prompt instructions alone.

**Evidence status**: All injection resistance claims are [INFERRED] until empirically validated through controlled red-teaming experiments. The prompt-tester skill exists to perform this validation. This validation is a documented open task.

---

## 7. Recommendations for Production Deployments

1. **Never rely on prompt-level defenses alone.** Combine OLS's Layer 1 with Layer 2 (output validation) and Layer 3 (external guardrails).
2. **Treat all retrieved/external content as potentially hostile.** Run content classifiers before the LLM processes web search results, RAG outputs, or tool responses.
3. **Monitor for multi-turn drift.** Re-inject safety instructions periodically in long conversations. Track conversation-level safety scores.
4. **Red-team regularly.** Use prompt-tester adversarially against your compiled prompts. The security landscape evolves; defenses must evolve with it.
5. **Validate before claiming.** All security claims about OLS-compiled prompts remain [INFERRED] until you have run your own red-team evaluation against your specific deployment context.

---

*End of v1.0.0. This document should be reviewed and updated as new attack techniques emerge and as OLS's defenses are empirically validated.*
