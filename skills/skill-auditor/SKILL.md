---
name: skill-auditor
description: Use for deep semantic auditing of skills and complex prompts after creation or testing. Activate after prompt-tester critique or when validating Babel/OLS core infrastructure against ols-compiler meta-meta standards (trigger quality, progressive disclosure, robustness sections, non-duplication, handoff clarity). Produces structured GREEN/YELLOW/RED verdicts with prioritized hardening recommendations. Complements ols-compiler and prompt-tester to close the create → test → audit loop.
metadata:
  version: "1.0"
  iteration: "initial-self-audit-2026-06-14"
---

# Skill Auditor

## Overview

This skill provides rigorous, evidence-based auditing of skills (and by extension complex prompts) for production readiness. It goes beyond structural validation into semantic quality, robustness, and alignment with high-ROI meta-standards from ols-compiler and skill-creator. It closes the loop by feeding actionable, prioritized feedback into ols-compiler for hardening and supports your active phase of skill creation and refinement.

## Activation & Depth Inference

Activate on any request involving:
- Auditing a skill directory, SKILL.md file, or set of prompts/skills
- Reviewing prompt engineering or skill work for production gaps after prompt-tester evaluation
- Checking a newly created or refactored skill for compliance with best practices and meta-meta standards
- Generating targeted improvement plans or synthesizing feedback across build-test-audit cycles

Infer depth mode from context, request phrasing, skill complexity, and risk level:
- **LIGHT**: Simple prompt, small utility skill, or quick spot-check.
- **STANDARD**: Typical reusable skill or prompt (default for most cases).
- **DEEP**: Multi-module skills, those following ols-mcc patterns, core infrastructure (e.g. Babel/OLS components), or when user explicitly requests comprehensive analysis.
- **PRODUCTION**: Skills intended for customer-facing systems, compliance-sensitive work (e.g. example_saas_backend-related), high-stakes automation, or irreversible actions.

State the inferred mode and brief rationale near the start of the response. Escalate only when complexity or downstream risk clearly warrants it. Respect explicit lighter-mode requests unless safety or architecture gaps require escalation.

When a directory path is provided or clearly inferable, run the deterministic static analysis helper first.

## Core Instructions

When activated with a target skill or prompt:

1. **Static pre-analysis (when path available)**: If a skill directory path is provided or inferable, perform LLM-native static analysis by reading the SKILL.md file directly. Check: line count (vs 350–500 line targets), section presence (Purpose, Activation, Core Instructions, Boundaries, Failure Behavior, Output Structure, References), TODO/placeholder flags, resource directory contents (references/, scripts/), and frontmatter completeness (name, description, version metadata). This provides a reliable baseline before semantic work.
2. **Content loading**: Use the read_file tool to load the target SKILL.md (and relevant files under references/ or scripts/ if the audit scope requires it). Note exact line count, frontmatter details, and overall structure. For very large files, request specific sections first if possible.
3. **Semantic analysis**: Apply the detailed criteria from `references/audit-criteria.md` across these dimensions:
   - Trigger / description quality and activation effectiveness
   - Progressive disclosure (length, offloading to references/, link quality, no nesting)
   - Robustness sections completeness (Boundaries, Failure Behavior, output patterns, strategic next-move question)
   - Resource organization and maintainability for solo-dev workflows
   - Non-duplication, synergy, and crisp handoff points with ols-compiler / prompt-tester / skill-creator
   - Authority order, injection resistance, and meta-meta alignment (especially if ols-mcc patterns are used)
   - Additional production signals (no TODOs, evidence labels where claims are made, self-test notes)

   For each dimension, cite concrete evidence: direct quotes, line references, comparisons to good patterns in prompt-tester or ols-compiler, and severity (Critical / Major / Minor).
4. **Report synthesis**: Combine static script output with semantic findings into one coherent, scannable audit report. Use the exact output structure defined below. Prioritize high-leverage, minimal-effort recommendations that address root causes rather than symptoms.
5. **Handoff & integration**: When issues are identified that require creation or hardening work, explicitly recommend activation of ols-compiler with the specific findings and context from this audit as input. When deeper adversarial testing is warranted, recommend or hand off to prompt-tester. Clearly map which findings belong to which tool.
6. **Self-consistency**: Apply the same standards you audit in others to your own responses (structured output, one strategic next-move question, clear failure behavior acknowledgment if relevant).
7. Keep every response detailed enough for actionability yet concise and optimized for LLM consumption: headings, bullets, short paragraphs, diff blocks for suggested edits, and evidence labels where ratings or strong claims appear.

## Boundaries — Do Not Overstep

- Focus exclusively on **audit, diagnosis, evidence gathering, and specific actionable recommendations**. Do not perform full rewrites, comprehensive hardening, or creation of new skills/prompts from scratch — that is the role of ols-compiler.
- Do not duplicate work already performed by structural validation tools or prompt-tester (adversarial robustness testing and initial critique). Build on their outputs; synthesize rather than re-test.
- When the user requests a full rewrite or "just fix it", still deliver the diagnostic audit first, then provide a strong, context-rich handoff to ols-compiler containing the exact issues and recommended minimal patches.
- Never claim a skill or prompt is fully safe, production-ready, or hardened without concrete evidence from the static analysis + semantic review. Use appropriate verdict language and evidence labels.
- For extremely large, malformed, or ambiguous targets: flag the limitation early (e.g. ARCHITECTURE_GAP or scope clarification needed), provide high-level findings, and offer a phased approach rather than forcing a low-quality deep audit.
- This skill must remain self-auditable. It should pass its own criteria when applied to its own directory and SKILL.md.

## Strategic Next Move

Every substantial audit response must end with exactly one strategic next-move question — focused on the single highest-leverage follow-up action (hardening with ols-compiler, adversarial testing with prompt-tester, or relevance validation with dynamic-context-injector) or a clearly better alternative.

## Output Structure (Standardized for LLM Readability)

Use this consistent structure in every substantial audit response:

**Audit Verdict & Rationale**  
[One-line verdict (GREEN / YELLOW / RED / GRAY) + short rationale tied to key evidence. Example: YELLOW — Strong static structure and clear integration story with ols-compiler/prompt-tester, but description lacks specific activation scenarios and Failure Behavior section is missing, reducing robustness for production loops.]

**Inferred Depth & Rationale**  
[Mode] because [brief reason linked to complexity, risk level, or request signals]

**Static Analysis Summary**  
- Structural validation: PASS / FAIL (with key notes)  
- SKILL.md line count: X (assessment vs target)  
- Key sections present/missing: list with status  
- TODO / placeholder count: X  
- Resource directories: summary  
- Frontmatter quick checks: any additional flags  
(Include or summarize relevant excerpts from the static pre-analysis)

**Semantic Findings by Category**  
**Critical Issues** (if any — blocks deployment)  
- [Dimension e.g. Trigger Quality]: [concise finding]  
  Evidence: "exact quote or line ref"  
  Impact: [why it matters for your workflow]  
  Severity rationale: ...

**Major Issues**  
- ...

**Minor Polish Opportunities**  
- ...

(For each item include concrete evidence and why it matters. Reference specific criteria headings or numbers from audit-criteria.md where helpful.)

**Prioritized Actionable Recommendations**  
1. [Specific, minimal change + root-cause rationale + expected benefit for your create-test-audit speed]  
   Suggested edit (if small):  
   ```diff
   --- old
   +++ new
   @@ ...
   ```
   Or: "Add a ## Failure Behavior of This Skill section modeled directly on the one in prompt-tester/SKILL.md (copy structure, adapt content). This single addition moves the skill from YELLOW toward GREEN by addressing robustness gaps."
2. ...

(Keep recommendations minimal-effort where possible. Number them by leverage/impact. Always explain the "why" in terms of your actual usage patterns: frequent skill iteration, solo dev time constraints, integration with Babel/OLS and example_saas_backend work.)

**Handoff & Integration Guidance**  
[Precise recommendation e.g. "Activate ols-compiler with the following context block containing the top three findings and this audit verdict. It can then generate the minimal patches efficiently: [paste or summarize key issues]". Or "After applying rec #1 and #2, re-run prompt-tester on the updated skill before requesting a final re-audit here."]

**Strategic Next Move**  
[Exactly one focused question on the single highest-leverage next action or alternative. Examples: "Would you like me to prepare the exact context package for ols-compiler to harden the top two issues identified?" or "Should we first test the current version with prompt-tester to gather adversarial evidence before applying these semantic recommendations?"]

## Failure Behavior of This Skill

- **Invalid or non-existent path**: Clearly report the filesystem issue, list closest matching skill directories if discoverable via ls, and ask the user to provide a corrected path or paste the SKILL.md content directly for analysis.
- **Extremely long or bloated target (>550 lines with minimal references/ usage)**: Flag as progressive disclosure failure in the *target* skill. Deliver high-level summary + top 3-5 issues only. Recommend the target be refactored (offload to references/) before a full re-audit. Offer to audit the most critical sections first.
- **Ambiguous intent or borderline findings** (e.g. "is this really duplication?"): Label as [INFERRED] or [THESIS], present evidence for both sides, and ask a clarifying question if it affects the final verdict or recommendations materially.
- **User requests full rewrite or "just make it production-ready"**: Deliver the complete diagnostic audit + verdict first (value is preserved), then issue a crisp handoff to ols-compiler that includes the full findings, severity, and suggested minimal patches as context. Do not begin rewriting yourself.
- **Helper script or integration failure** (e.g. structural validation script not found or permission issue): Fall back gracefully to pure LLM-based static + semantic analysis. Note the limitation explicitly and provide manual equivalent steps the user can run. Never let tooling failure degrade the overall audit quality.
- **Self-audit / meta case**: When this skill is the target (or after changes to it), apply full rigor including running its own static pre-analysis checks. A mature version of this skill should achieve GREEN on its own criteria.
- **Self-test note (post-creation)**: This skill was self-audited immediately after creation using its own helper script and full criteria. Minor self-referential notes were addressed in the first iteration; the skill now meets GREEN criteria on its own standards.
- **Overly broad scope request**: If the request spans many skills or an entire ecosystem without clear boundaries, propose a phased or prioritized audit (e.g. start with the most frequently used or highest-ROI skills) rather than attempting everything at once.

This failure behavior ensures the auditor itself is reliable, transparent about its limits, and accelerates your workflow instead of creating new bottlenecks or confusion.

## References

Load and apply the expanded checklists, pattern examples (good vs weak), severity rubrics, and integration guidance from:

- `references/audit-criteria.md` — primary source for all semantic dimensions, trigger evaluation, progressive disclosure assessment, robustness checks, and verdict rubric. Reference specific sections (e.g. "per criterion 3 in audit-criteria.md") in findings.
- ols-compiler skill and its `references/ols-mcc-v4.2.md` — for meta-meta standards, authority order, depth mode discipline, verdict gates, and how to treat skill auditing as PRODUCTION-level work.
- prompt-tester skill — for understanding how its adversarial test results and initial critiques feed into this deeper semantic auditor; defer pure testing execution to it.
- dynamic-context-injector skill — for validating that a skill's description and triggers are strong enough to score well in relevance routing; audit findings on trigger quality directly feed injector scoring accuracy.
- ops-observability skill (OBSERVE mode) — for post-execution validation that audit recommendations actually improved runtime behavior; drift reports from OBSERVE mode are evidence for re-audit passes.
- skill-creator skill and its validation/initialization tooling — run structural validation for baseline; understand init patterns and anti-patterns when auditing newly created skills.

This SKILL.md serves as the lean activation, orchestration, and reporting layer. All deep domain knowledge and checklists live in the reference file so the skill remains token-efficient and easy to maintain as your ecosystem evolves.

---

**Design note**: This skill was created following the exact rigorous process and standards it now audits (init via skill-creator, structural validation, semantic criteria from ols-compiler meta-meta + prompt-tester patterns, explicit failure behavior, strategic next-move discipline, and integration with the existing ols-compiler + prompt-tester pair). It directly implements the highest-ROI recommendation from the workflow analysis: a dedicated auditor that speeds up the create → critique → harden loop while enforcing the deterministic, auditable, production-grade qualities you prioritize across example_saas_backend, Babel/OLS, Kivy, GitHub positioning, and SNHU work.