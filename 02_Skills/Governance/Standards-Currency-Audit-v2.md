<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Standards Currency Audit (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** `skill_standards_currency_audit` v1.1 (compiled min only — this is the first full-source version)
**Pairs with:** `ols-compiler`, `skill-auditor`, `coherence-linter`, `ops-observability`
**Contract Anchor:** `00_System_Router/Babel_Runtime_Contracts-v1.0.md`
**Last Verified:** 2026-06-19
**Activation:** Load whenever the task is to audit, update, or validate Babel prompt files against current technical reality — version freshness, deprecated APIs, model behavior accuracy, and LLM instruction quality. Also load during periodic maintenance windows (see audit schedule).

---

## Purpose

Babel prompt files contain version pins, API recommendations, model capability claims, and coding patterns. These claims decay over time: languages release new versions, APIs deprecate, model checkpoints change behavior. A stale claim in a skill silently misleads every agent that loads it.

This skill provides a structured, web-search-evidence-backed audit procedure for detecting and fixing stale claims. v2.0 adds an OLS-MCC compliance dimension to the audit scope.

---

## 1. Audit Scope

| Axis | What to check |
|------|---------------|
| **Language / runtime versions** | Is the pinned version the current stable release? Is any version stale by more than one minor release? |
| **Deprecated APIs or syntax** | Does the file recommend APIs, flags, or syntax that are deprecated or removed in the current version? |
| **Model behavior accuracy** | Does the adapter accurately describe the model's actual checkpoint behavior (thinking mode, context window, JSON mode, temperature guidance)? |
| **LLM instruction quality** | Are the instructions written so an LLM receiving only this file can act correctly without guessing? Are failure modes named? Are rules actionable? |
| **OLS-MCC compliance** (new v2.0) | Does the skill include Boundaries, Failure Behavior, and a Strategic Next Move section? Does it declare handoff contracts to sister skills? Does it pass skill-auditor GREEN criteria? |

---

## 2. Research Procedure

### Step 1 — Identify claims requiring verification

For each target file, extract:
- Every version number or version range (e.g., "Kotlin 2.1", "Zod v3", "Godot 4.4")
- Every model checkpoint name or capability claim (e.g., "supports thinking mode", "17B/109B")
- Every API or syntax pattern recommended (e.g., `context(Dependency)`, `z.string().uuid()`)
- Every "best practice" statement that implies a current-year standard
- (v2.0) Whether the file has Boundaries, Failure Behavior, and Strategic Next Move sections

### Step 2 — Web search for each claim

```
Search pattern: "[technology] [claim] current version 2026"
Examples:
  "Kotlin stable release 2026"
  "Qwen3-235B-Instruct-2507 thinking mode DeepInfra"
  "Zod v4 uuid() API change"
  "Godot latest stable release 2026"
  "Next.js 15 server components default 2026"
  "NVIDIA Nemotron 3 Super 120B A12B Hugging Face"
```

### Step 3 — Compare claim to evidence

| Finding | Criteria | Action |
|---------|----------|--------|
| **Confirmed current** | Evidence matches claim | No change needed |
| **Stale version** | Evidence shows newer stable version exists | Flag for update |
| **Deprecated API** | Evidence shows the recommended syntax/API is deprecated | Flag as critical |
| **Wrong model behavior** | Evidence contradicts the adapter's description | Flag as critical |
| **Unverifiable** | No reliable evidence found | Flag as UNKNOWN — lower confidence, do not silently pass |
| **Missing OLS-MCC sections** (v2.0) | File lacks Boundaries, Failure Behavior, or Strategic Next Move | Flag as MAJOR — recommend ols-compiler hardening |

### Step 4 — Issue verdict per file

```
File: [filename]
Audit date: [YYYY-MM-DD]
Claims checked: [N]

Findings:
  [CRITICAL] [claim] — Evidence: [what was found] — Required fix: [specific change]
  [STALE]    [claim] — Evidence: [what was found] — Required fix: [specific change]
  [CONFIRMED][claim] — Evidence: [source] — No change needed
  [UNKNOWN]  [claim] — Evidence: insufficient — Action: flag in file, lower confidence
  [MAJOR]    [axis]  — Missing OLS-MCC section: [Boundaries | Failure Behavior | Strategic Next Move]

Verdict: [PASS | NEEDS_UPDATE | CRITICAL_UPDATE_REQUIRED]
Overall confidence: [0.0–1.0]
```

---

## 3. LLM Instruction Quality Criteria

Evaluate each file on whether an LLM receiving only this file can act correctly:

### 3.1 Self-Containment

Flag patterns that break self-containment:
- "Unchanged — see v6.2" (referenced content not present in the file)
- "Refer to the domain architect" without specifying which one
- Rules that say "as before" or "same as above" with no inline definition

### 3.2 Actionability

Every rule must specify what to DO, not just what to AVOID.

**Failure patterns to flag:**
- "Be careful with RLS" — not actionable
- "Handle errors properly" — not actionable
- "Use the correct Kotlin version" — not actionable (no version specified)

**Correct pattern:**
```
[Condition]: [Specific action] — [Why this matters]
Example: "On ACT turns: emit the approved file-write block immediately without preamble."
```

### 3.3 Failure Modes Named

For adapters: the top 3–5 observed failure modes for that specific model must be named with corrective actions. Flag adapters that lack a failure modes section.

### 3.4 No Dead References

Every referenced skill ID, file path, or adapter ID must exist in the catalog. A reference to a non-existent skill is actively misleading.

### 3.5 Metadata Completeness

Every domain architect and adapter must have:
- `Status` (ACTIVE / DEPRECATED)
- `Layer`
- `Pipeline Position`
- `Contract Anchor`
- `Last Verified` date
- Copyright header

### 3.6 OLS-MCC Completeness (new v2.0)

Every skill file should have:
- `## Boundaries — Do Not Overstep` section
- `## Failure Behavior of This Skill` section
- `## Strategic Next Move` section
- Handoff references to sister skills where appropriate
- Evidence labels ([KNOWN], [OBSERVED], [INFERRED], [THESIS]) on claims

---

## 4. Update Contract

### Version updates
- Update the pinned version to current stable.
- Note the previous version and date in a comment if the change is significant.
- Do not pin to RC or beta versions unless the file explicitly documents the experimental status.

### Deprecated API updates
- Remove the deprecated pattern.
- Replace with the current equivalent.
- If a migration path exists, document it inline (old → new).

### Model adapter updates
- Verify the DeepInfra model ID against the live DeepInfra model page before updating.
- Do not change adapter behavior based on training data alone — require web search evidence.
- Pin the exact checkpoint ID in the `Target Model` header field (not a floating alias).

### Instruction quality rewrites
- Rewrite non-actionable rules to the format: `[Condition]: [Specific action] — [Why]`
- Add a failure modes table if the adapter lacks one.
- Remove all dead skill references — replace with real IDs or delete the row.

### OLS-MCC hardening (new v2.0)
- If a skill lacks Boundaries, Failure Behavior, or Strategic Next Move: flag as MAJOR. Recommend activation of ols-compiler to add these sections.
- If a skill lacks handoff declarations: flag as MINOR. Recommend adding explicit "Pairs with" or catalog dependencies.

### `Last Verified` field
- Update the `Last Verified` date on every file that is touched.
- If a file is audited and found PASS (no changes needed), still update `Last Verified`.

---

## 5. Audit Schedule Guidance

| File type | Cycle | Rationale |
|-----------|-------|-----------|
| Model adapters | Every 60 days | Models update frequently |
| Domain architects — language/framework sections | Every 90 days | Language/framework release cadence |
| Behavioral OS | Every 180 days | Changes slowly |
| Skill files — technology-specific | Every 90 days | Technology-dependent |
| Skill files — governance/process | Every 180 days | Process patterns stable |
| Orchestrator routing table | Every 60 days | Waterfall changes with model updates |

**Trigger-based re-audit (run immediately when):**
- A new model checkpoint is deployed to the waterfall
- A language releases a major or minor stable version
- A framework publishes a breaking-change release
- The Babel CLI waterfall is updated in `config/model-policy.json`

---

## 6. Known Stale Patterns — Quick Reference

| Pattern | Status | Replacement |
|---------|--------|-------------|
| `Kotlin 2.1` version pin | Stale | Kotlin 2.2 stable: `kotlin.compiler.version = "2.2.0"` |
| `context(Dependency)` syntax | Stale | Kotlin 2.0.20+: Context Parameters: `context(val dep: Dependency)` |
| `z.string().uuid()` | Stale | Zod v4: `z.uuid()` (top-level constructor) |
| `.strict()` on Zod objects | Stale | Zod v4: `z.strictObject({})` |
| `"use client"` as default | Stale | Next.js 15: Server Components are default |
| `context receivers` with `-Xcontext-receivers` | Stale | Kotlin 2.2: Context Parameters (Beta) |
| `Llama 4 Scout 17B/109B` | Wrong | Llama-4-Scout-17B-16E-Instruct (17B, 16 experts — 109B is Maverick) |
| Qwen3 `<thinking>` blocks in `-Instruct-2507` | Wrong | Instruct-2507 is non-thinking — route reasoning to Thinking-2507 |
| Nemotron 49B-only guidance | Stale | Nemotron 3 Super 120B available in runtime policy |
| `asyncio.gather()` for agent coordination | Stale | Python 3.11+: `asyncio.TaskGroup` |
| Godot 4.4 or 4.5-only target | Stale | Godot 4.6 stable released |
| `@tool` for complex editor plugins | Stale | Godot 4.6: Use `EditorPlugin` subclass |

---

## 7. Output Format

Standard JSON output for programmatic consumption:

```json
{
  "domain_appendix": {
    "standards_currency_audit": {
      "audit_date": "YYYY-MM-DD",
      "files_audited": ["path/to/file1.md", "path/to/file2.md"],
      "web_searches_performed": ["query 1", "query 2"],
      "findings": [
        {
          "file": "path/to/file.md",
          "axis": "language_version | model_behavior | deprecated_api | instruction_quality | ols_mcc_compliance",
          "severity": "CRITICAL | STALE | CONFIRMED | UNKNOWN | MAJOR",
          "claim": "what the file says",
          "evidence": "what the web search found",
          "fix": "specific change required or 'no change needed'"
        }
      ],
      "verdict": "PASS | NEEDS_UPDATE | CRITICAL_UPDATE_REQUIRED",
      "confidence": 0.0
    }
  }
}
```

---

## Hard Rules

1. Every version claim must be verified by web search against current stable releases. Never trust training-data cutoff dates.
2. Every model capability claim must be verified against the provider's current documentation or model card.
3. Never mark a claim CONFIRMED without explicit web search evidence. "Probably still current" is UNKNOWN.
4. Always update `Last Verified` on every file touched — even if no changes were needed.
5. Never pin to RC, beta, or pre-release versions unless explicitly documented as experimental.
6. **New in v2.0:** Every audited skill file must be checked for OLS-MCC compliance (Boundaries, Failure Behavior, Strategic Next Move).
7. **New in v2.0:** CRITICAL findings that involve safety/auth/compliance claims require immediate update — do not defer to the next audit cycle.

---

## Boundaries — Do Not Overstep

- This skill audits for technical currency and OLS-MCC structural compliance. It does not perform deep semantic auditing (that's skill-auditor), adversarial testing (that's prompt-tester), or cross-skill contradiction detection (that's coherence-linter).
- This skill identifies what needs to change — it does not perform the changes. Hand off to ols-compiler for hardening, or apply the specific version/API fixes documented in the findings.
- This skill does not verify code correctness or runtime behavior. It checks claims, not implementations.

---

## Failure Behavior of This Skill

- **Web search returns no results for a claim:** Mark as UNKNOWN with search queries used. Do not guess or use training-data memory as evidence.
- **Conflicting evidence from multiple sources:** Present both sides. Prefer official docs over third-party summaries. If unresolvable, mark as UNKNOWN.
- **File is too large for full audit (>500 lines):** Audit the version/model claims and first 200 lines. Flag the rest as DEFERRED.
- **Audit target file doesn't exist (dead catalog reference):** Flag as CRITICAL. A catalog entry pointing to a missing file is a system integrity issue.
- **OLS-MCC compliance check on a non-skill file (domain architect, adapter):** Skip OLS-MCC check — those file types have different structural requirements.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening skills that fail OLS-MCC compliance checks.
- `skill-auditor` (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — for deep semantic audit beyond currency checks.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for cross-skill contradiction detection (complementary to this per-skill audit).
- `prompt_catalog.yaml` — canonical catalog for verifying skill IDs and paths.
- `00_System_Router/Babel_Runtime_Contracts-v1.0.md` — contract anchor.

## Strategic Next Move

After every audit report, end with exactly one strategic next-move question: if CRITICAL findings exist, ask whether to apply fixes immediately or schedule; if OLS-MCC gaps were found, ask whether to activate ols-compiler for hardening; if PASS, suggest the next scheduled audit target.

---

**Design note:** This v2.0 is the first full-source version of the standards currency audit. It supersedes the compiled-min-only v1.1 and retrofits the audit procedure with OLS-MCC compliance checking (Boundaries, Failure Behavior, Strategic Next Move), plus handoff contracts to the meta-tool ecosystem. This directly implements Phase 2.4 of the OLS-MCC audit roadmap.
