# Audit Criteria for skill-auditor

This reference expands the semantic, robustness, and meta-meta checks that go beyond basic structural rules and the activation logic in ols-compiler / prompt-tester. Use these criteria to produce consistent, high-signal audit reports.

## 1. Trigger & Description Quality (Highest Leverage Check)

The `description` in frontmatter is the **only** thing shown before the skill loads. It must be an effective activation trigger.

**Good criteria:**
- Specific about **what** the skill does and **when** to activate it (scenarios, request phrasing, project phase).
- Mentions complements to existing skills (e.g. "Complements ols-compiler and prompt-tester in the create → test → audit loop").
- Signals production / high-stakes value or meta-acceleration potential.
- Uses clear, scannable language with trigger keywords (audit, validate, review, harden, critique for skills/prompts).
- Stays under ~300-400 chars for quick scanning; avoids fluff.

**Weak patterns to flag:**
- Vague or generic ("Helps with prompts and skills" without scenarios).
- Missing "when" / activation context (user won't know to call it at the right moment).
- Contains TODO, "TODO", or placeholder language.
- Duplicates what prompt-tester or ols-compiler already advertise.
- Uses banned syntax that would have failed validate (but double-check): ': ', '<', '>', quotes around scalar.
- No mention of integration points or handoff behavior.

**Severity:** Critical if description would cause mis-activation or low discoverability. Major if merely imprecise.

**Recommendation style:** Provide a full rewritten description line + rationale tied to your workflow (e.g. "Your current phase of active skill creation around Babel/OLS and example_saas_backend tooling makes precise triggers essential for speed").

## 2. Progressive Disclosure Effectiveness

**Core rules (from skill-creator):**
- SKILL.md body target: keep under 500 lines hard limit. Ideal <350 for skills with references.
- Long or detailed content (checklists, patterns, long examples, model-specific nuances) **must** live in references/ with clear relative links from SKILL.md.
- No nested references (references/ cannot contain sub-references that the model must chase).
- Body must be imperative, concise, and justify its token cost. Every paragraph should answer "Does this justify its token cost?"

**Audit checks:**
- Line count + proportion of content that could/should be offloaded.
- Are references/ actually used and linked meaningfully in SKILL.md?
- Is the body bloated with content better suited to a reference file (e.g. full test batteries, long lists of examples)?
- Does the skill properly separate "activation/orchestration layer" (lean SKILL.md) from "detailed knowledge" (references/)?

**Flag as issue:**
- SKILL.md >450 lines with no/little use of references/.
- References exist but are not referenced from SKILL.md (dead weight or poor organization).
- Important procedural knowledge buried in long paragraphs instead of structured sections + reference links.

**Recommendation:** Specific suggestion like "Move the detailed X patterns to a new references/x-patterns.md and add a 2-line link + summary in the Core Instructions section."

## 3. Robustness Sections & Failure Behavior

High-quality production skills (see prompt-tester, ols-compiler) explicitly define their own failure modes and boundaries. This dramatically improves reliability for solo developers with limited debugging time.

**Expected sections / content:**
- Clear **Boundaries — Do Not Overstep** or equivalent (what this skill will NOT do, to prevent scope creep and mis-use).
- Dedicated **Failure Behavior of This Skill** section that covers:
  - Edge cases (malformed input, extremely long targets, ambiguous intent, integration failures with other skills/scripts).
  - How it degrades gracefully (e.g. fall back to pure LLM analysis if script fails).
  - Self-test / self-audit notes.
  - When to hand off to ols-compiler or prompt-tester.
- Output is structured and scannable (headings, bullets, short paragraphs, evidence labels where applicable).
- Ends every substantial response with **exactly one** strategic next-move question focused on highest-leverage follow-up.

**Audit flags:**
- Missing Failure Behavior section → Major (reduces robustness).
- No Boundaries section or very weak one → Major.
- Does not end with strategic next-move question (or has multiple / none) → Minor but important for consistency with ols-compiler contract.
- Vague failure handling ("just ask for clarification") without specific behaviors → Minor/Major depending on risk.

**Recommendation example:** "Add a ## Failure Behavior of This Skill section modeled on prompt-tester's. Include at minimum: path-not-found, target-too-large, user-requests-full-rewrite, and self-test capability. This will make the skill more trustworthy in your automated loops."

## 4. Resource Organization & Maintainability (Solo Dev Focus)

For a solo developer (Walmart + SNHU + multiple projects), skills must be easy to maintain and extend without high cognitive load.

**Good patterns:**
- scripts/ contains only code that would otherwise be repeatedly rewritten or needs deterministic reliability. Scripts are executable without loading full context.
- references/ for anything > ~50-80 lines that benefits from being loaded on-demand (patterns, criteria, model nuances, long examples). Organized flat (no subdirs).
- assets/ for non-context files (templates, boilerplate code snippets, images, fonts).
- Clear mapping in SKILL.md: "Use references/audit-criteria.md for the full checklists..."

**Poor patterns to flag:**
- Everything crammed into SKILL.md (bloated, slow to load, hard to edit).
- scripts/ or references/ present but empty or unused.
- Inconsistent naming or deep nesting.
- Deterministic logic (e.g. line counting, section grepping, calling validate) left in prompt instructions instead of extracted to a script.

**Recommendation:** "Document the static pre-analysis checks clearly in Core Instructions with specific, repeatable steps (line counts, section checks, TODO scans, resource inventory). This gives you a consistent, repeatable baseline that speeds up every future audit."

## 5. Non-Duplication & Synergy with Existing Ecosystem

**Key principle (skill-creator):** Only encode knowledge that is non-obvious, procedural, or organization-specific. Do not duplicate model knowledge or other skills.

**Audit questions:**
- Does this skill duplicate capabilities already in prompt-tester (adversarial testing, robustness eval), ols-compiler (creation, hardening, meta-meta), or skill-creator (init/validate guidance)?
- Does it clearly complement them and define handoff points? (e.g. "After prompt-tester critique, activate skill-auditor for semantic depth and improvement synthesis.")
- Is the division of labor crisp? (This skill = deep semantic + improvement synthesis + static orchestration. Not creation, not pure adversarial testing.)
- For meta-meta skills: Does it apply the same rigor it audits in others (self-audit friendly)?

**Flag duplication risk as Critical/Major** if overlap is high without strong differentiation and integration story.

## 6. Authority Order, Injection Resistance & Meta-Meta Alignment (ols-compiler standards)

When a skill references or builds on ols-mcc patterns (or is itself meta), apply ols-compiler rules:
- Proper Authority Order: user request > skill instructions > lower sources. Flag any prompt injection vectors immediately.
- Use Verdict Gates (GREEN/YELLOW/RED/GRAY) and evidence labels consistently where claims/ratings are made.
- For skill creation/auditing: treat as PRODUCTION-level by default. Enforce frontmatter trigger quality, progressive disclosure, validation rules, resource org.
- Clear escalation path to DEEP/PRODUCTION depth when risk or complexity warrants.

**Audit note:** If the target skill does ols-mcc work or references the v4.2.md, verify it correctly defers testing/critique to prompt-tester and reserves creation/hardening for ols-compiler.

## 7. Additional Polish & Production Signals

- No leftover TODOs, placeholders, or "fill this in later" language in production-intent skills.
- Consistent use of evidence labels ([PROVEN], [OBSERVED], [INFERRED], [THESIS], gap codes) when making strong claims — especially useful for skills that do analysis.
- Self-test capability noted (the skill can be run on itself).
- Clear version or iteration notes if the skill is evolving rapidly (optional but helpful during your active creation phase).
- For skills with scripts/: the scripts themselves should be tested (e.g. the static pre-analysis checks were run successfully during the skill's own creation audit).

## 8. Verdict Rubric (Use in Reports)

- **GREEN**: Passes structural + all major semantic criteria. Minor polish only. Ready for production use / inclusion in your core loop. Can safely recommend deployment.
- **YELLOW**: Solid foundation. One or two Major issues or several Minor that are easy to fix. Recommend targeted hardening via ols-compiler then re-audit.
- **RED**: Critical or multiple Major gaps (weak trigger, missing robustness sections, bloat without disclosure, high duplication). Block deployment until addressed. Provide clear path to GREEN.
- **GRAY**: Ambiguous intent, insufficient context, or target not clearly a skill/prompt. Request clarification before full audit.

Always tie verdict to concrete evidence from the static script + semantic review. Never over-claim safety or readiness.

## 9. How This Auditor Integrates (Closed Loop)

Ideal workflow this skill enables:
1. ols-compiler → creates or refines skill/prompt (build phase)
2. prompt-tester → adversarial robustness testing + initial critique (test phase)
3. skill-auditor → deep semantic audit, static analysis via helper script, synthesis of improvement recs, verdict (audit phase)
4. Feedback → targeted patches or re-run ols-compiler with audit findings as context
5. Repeat until GREEN → deploy / use in production (example_saas_backend, Babel components, etc.)

This dramatically accelerates your current high-frequency skill creation workflow while enforcing the deterministic, auditable, production-grade standards you value.

---

**Usage note for LLM:** When auditing, load this file early, apply every relevant section, cite specific criteria numbers or headings in findings, and always produce prioritized recommendations that map back to these standards. Update this reference when new patterns or anti-patterns are discovered in your skill ecosystem.