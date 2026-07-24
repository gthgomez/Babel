<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Standards Currency Audit (v1.1)

**Status:** ACTIVE
**Layer:** 02_Skills / Governance
**Skill ID:** `skill_standards_currency_audit`
**Tags:** `audit`, `versioning`, `standards`, `currency`, `llm-prompting`, `language`, `framework`, `governance`, `skill`
**Contract Anchor:** `00_System_Router/Babel_Runtime_Contracts-v1.0.md`
**Last Verified:** 2026-05-04

---

## PURPOSE

This skill governs how Babel audits its own prompt layer — domain architects, model adapters,
skills, and the behavioral OS — for version currency and standards alignment.

Prompt files that reference stale language versions, deprecated APIs, or incorrect model
capabilities silently degrade every run that loads them. This skill defines the research
procedure, verdict criteria, and update contract for keeping the Babel prompt layer current.

**When to load:** Whenever the task is to audit, update, or validate Babel prompt files against
current 2026 standards. Also load when a domain architect, adapter, or skill file is being
created or significantly revised.

---

## 1. AUDIT SCOPE

A standards currency audit covers four axes for each file under review:

| Axis | What to check |
|------|---------------|
| **Language / runtime versions** | Is the pinned version the current stable release? Is any version stale by more than one minor release? |
| **Deprecated APIs or syntax** | Does the file recommend APIs, flags, or syntax that are deprecated or removed in the current version? |
| **Model behavior accuracy** | Does the adapter accurately describe the model's actual checkpoint behavior (thinking mode, context window, JSON mode, temperature guidance)? |
| **LLM instruction quality** | Are the instructions written so an LLM receiving only this file can act correctly without guessing? Are failure modes named? Are rules actionable? |

---

## 2. RESEARCH PROCEDURE

Before issuing any verdict, gather live evidence. Do not rely on training-data assumptions —
model APIs, language versions, and framework defaults change faster than training cutoffs.

### Step 1 — Identify claims requiring verification

For each file under audit, extract:
- Every version number or version range (e.g., "Kotlin 2.1", "Zod v3", "Godot 4.4")
- Every model checkpoint name or capability claim (e.g., "supports thinking mode", "17B/109B")
- Every API or syntax pattern recommended (e.g., `context(Dependency)`, `z.string().uuid()`)
- Every "best practice" statement that implies a current-year standard

### Step 2 — Web search for each claim

For each extracted claim, issue a targeted web search:

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

Do not skip this step. A claim that appears correct from training data may be stale.
Web search results are evidence; training data is assumption.

### Step 3 — Compare claim to evidence

For each claim:
- **Confirmed current**: evidence matches claim → no change needed
- **Stale version**: evidence shows newer stable version exists → flag for update
- **Deprecated API**: evidence shows the recommended syntax/API is deprecated → flag as critical
- **Wrong model behavior**: evidence contradicts the adapter's description of model capabilities → flag as critical
- **Unverifiable**: no reliable evidence found → flag as `unknown`, lower confidence, do not silently pass

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

Verdict: [PASS | NEEDS_UPDATE | CRITICAL_UPDATE_REQUIRED]
Overall confidence: [0.0–1.0]
```

---

## 3. LLM INSTRUCTION QUALITY CRITERIA

Beyond version currency, assess each file for instruction quality. An LLM receiving only this
file must be able to act correctly. Evaluate:

### 3.1 Self-Containment

A file passes self-containment if an LLM can follow its instructions without reading another
file. Failure patterns:
- "Unchanged — see v6.2" (referenced content not present)
- "Refer to the domain architect" without specifying which one
- Rules that say "as before" or "same as above" with no inline definition

### 3.2 Actionability

Every rule must specify what to DO, not just what to AVOID. Failure patterns:
- "Be careful with RLS" — not actionable
- "Handle errors properly" — not actionable
- "Use the correct Kotlin version" — not actionable (no version specified)

Good rule format:
```
[Condition]: [Specific action] — [Why this matters]
Example: "On ACT turns: emit the approved file-write block immediately without preamble."
```

### 3.3 Failure Modes Named

For adapters: the top 3–5 observed failure modes for that specific model must be named with
symptoms and mitigations. Generic rules ("don't hallucinate") do not qualify.

### 3.4 No Dead References

Every referenced skill ID, file path, or adapter ID must exist in the catalog. A reference to
an unregistered skill ID or a skill ID marked with a future-placeholder annotation is a dead reference — remove it
or replace it with the actual existing skill.

### 3.5 Metadata Completeness

Every domain architect and adapter must have:
- `Status` (ACTIVE / DEPRECATED)
- `Layer`
- `Pipeline Position`
- `Contract Anchor`
- `Last Verified` date
- Copyright header

---

## 4. UPDATE CONTRACT

When a file requires update, apply these rules:

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

### `Last Verified` field
- Update the `Last Verified` date on every file that is touched.
- If a file is audited and found PASS (no changes needed), still update `Last Verified`.

---

## 5. AUDIT SCHEDULE GUIDANCE

| File type | Recommended audit frequency |
|-----------|----------------------------|
| Model adapters | Every 60 days (models update frequently) |
| Domain architects — language/framework sections | Every 90 days |
| Behavioral OS | Every 180 days (changes slowly) |
| Skill files — technology-specific | Every 90 days |
| Skill files — governance/process | Every 180 days |
| Orchestrator routing table | Every 60 days (waterfall changes with model updates) |

Trigger an out-of-cycle audit whenever:
- A new model checkpoint is deployed to the waterfall
- A language releases a major or minor stable version
- A framework publishes a breaking-change release
- The Babel CLI waterfall is updated in `config/model-policy.json`

---

## 6. HIGH-DRIFT CLAIM WATCHLIST

These patterns become stale quickly. Treat this table as a query checklist, not as
standing evidence that the replacement is current. Every finding must cite a live
official or provider source with an access date before it can be marked `CONFIRMED`.

| Pattern to check | Evidence required before changing a prompt |
|---------|-----------|
| Language/runtime version pins such as Kotlin, Python, Node.js, Deno, or Godot | Official release notes or version docs for the exact stable release and date. |
| Framework defaults such as Next.js App Router, React, Tailwind, Vite, Compose, or Zod APIs | Official framework docs or migration guide for the exact major/minor version. |
| Android platform claims such as target SDK, AGP, NDK, Compose BOM, Billing Library, Play policy, 16 KB page size, or store deadlines | Android Developers or store policy documentation for the exact requirement and enforcement date. |
| Model checkpoint behavior such as thinking controls, context window, JSON/schema mode, tool use, temperature, or provider-specific request fields | Official model card plus serving-provider API docs when Babel uses a hosted provider. |
| Babel-local runtime model policy such as active waterfall IDs or adapter mapping | `config/model-policy.json` plus any runtime tests that prove the mapping. |
| External mnemonics or named standards | Verify whether they are external standards or Babel-local labels; never present Babel-local mnemonics as external authority. |

---

## 7. OUTPUT FORMAT

When this skill is active, append a `standards_currency_audit` section to the `domain_appendix`
of any `PlanEnvelope` that modifies a Babel prompt file:

```json
"domain_appendix": {
  "standards_currency_audit": {
    "audit_date": "YYYY-MM-DD",
    "files_audited": ["path/to/file1.md", "path/to/file2.md"],
    "web_searches_performed": ["query 1", "query 2"],
    "findings": [
      {
        "file": "path/to/file.md",
        "axis": "language_version | model_behavior | deprecated_api | instruction_quality",
        "severity": "CRITICAL | STALE | CONFIRMED | UNKNOWN",
        "claim": "what the file says",
        "evidence": "what the web search found",
        "fix": "specific change required or 'no change needed'"
      }
    ],
    "verdict": "PASS | NEEDS_UPDATE | CRITICAL_UPDATE_REQUIRED",
    "confidence": 0.0
  }
}
```
