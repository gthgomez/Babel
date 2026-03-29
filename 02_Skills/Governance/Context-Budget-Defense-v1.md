<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Context Budget Defense (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `adapter_gemini` (primary), all pipeline stages when operating with large contexts

---

## Purpose

Babel's token budget accounting tracks how many tokens are in a compiled stack.
That accounting is observability — it measures cost. This skill is the behavioral response:
what the model should actually do when the context is large, when instructions may have been
partially loaded, or when the model senses it is approaching its effective window.

Silent context degradation is worse than declared truncation. A model that silently loses
its BCDP assessment or security audit instructions and then produces an unguarded plan is a
failure. A model that declares the loss and halts is recoverable.

---

## Layer Priority (when context must be reduced)

When you are given explicit instruction to reduce context, or when you recognize that your
effective window is constrained, apply this priority order. Drop the last-loaded layer first.

```
NEVER DROP:
  01 — Behavioral OS (OLS-v7-Core, OLS-v7-Guard)
  02 — Active BCDP assessment (if a contract is being modified)
  03 — Security audit findings (if a security review is in progress)
  04 — The current stage's output schema contract

DROP LAST (lowest priority):
  05 — Task Overlays (optional, bounded guidance)
  06 — Project Overlays (thin context — internalize the constraints, then drop the file)
  07 — Secondary skills beyond the minimum required set
  08 — Domain Architect (drop only after internalizing invariants — never drop if mid-plan)

SUMMARIZE BEFORE DROP (do not blindly truncate):
  09 — Research context, log excerpts, file contents provided for analysis
  10 — Prior conversation turns beyond the immediate task context
```

**Rule:** If you cannot confirm a layer from the NEVER DROP list is still in your effective window,
declare it and re-read it before proceeding. Never produce a BCDP or security verdict for content
you cannot actively reference in this response turn.

---

## Truncation Declaration Protocol

If you recognize that your context window is constraining your ability to reference something
that was loaded earlier, output exactly this block before continuing:

```
CONTEXT WARNING
───────────────
Potentially dropped: [layer name or file name]
Impact:              [what this layer governs — e.g., "BCDP contract rules", "RLS invariants"]
Action:              [Re-reading now | Requesting re-injection | Proceeding without — reason]
```

Do not silently continue as if the layer is present when you cannot confirm it is.

---

## Summarize Before Truncate

When long-form content (log excerpts, file contents, prior analysis) must be reduced to fit:

1. **Summarize** the key facts in 3–5 sentences before the content is removed from active context.
2. **Store the summary** in the plan's `KNOWN FACTS` section so it persists through the pipeline.
3. **Declare the summarization**: note which content was summarized and what was omitted.

Never blindly truncate a file mid-read and continue planning as if the full content was seen.
A partial file read is treated the same as an unseen file — it triggers the Evidence Gate.

---

## Token Pressure Response

If token pressure is causing you to shorten output:

| Acceptable | Not Acceptable |
|-----------|---------------|
| Shorter prose in APPROACH section | Omitting fields from the JSON output contract |
| Fewer examples in KNOWN FACTS | Truncating a JSON object mid-emission |
| Condensed ASSUMPTIONS list | Skipping VERIFICATION METHOD entirely |
| One-line step descriptions in MINIMAL ACTION SET | Omitting BCDP_ASSESSMENT when a contract is modified |
| Summarizing prior evidence | Claiming a file was read when it was only partially read |

Token pressure is never a reason to produce structurally incomplete output.
A 50-token MINIMAL ACTION SET that is complete beats a 200-token one that loses
the VERIFICATION METHOD.

---

## Gemini-Specific Application

Gemini operates with a very large context window. This is an asset for long-context analysis,
but it creates a specific failure mode: the model may reference something from 50,000 tokens ago
as if it is still active, when its effective attention has moved on.

For Gemini, apply these additional rules:

1. If you are referencing a contract, interface, or schema that was loaded early in the context,
   explicitly re-state the relevant portion in your current response before relying on it.
   Do not assume it is still reliably in your active attention.

2. If a task requires analysis of a very large file set and you cannot confirm all files are
   within your reliable attention window, declare which files are confirmed and which are inferred.

3. Never state "I reviewed all files" if you cannot enumerate them. Enumerate what you reviewed.

---

## Hard Rules

1. A layer that was loaded but is no longer reliably in your attention window is treated the same
   as a layer that was never loaded. Declare it. Do not act on it silently.
2. Never drop behavioral rules (PLAN/ACT state machine, Evidence Gate, NAMIT) due to context
   pressure. These are the last things to remove from a stack.
3. If you have summarized content and omitted the original, the summary must appear in KNOWN FACTS.
   It is not acceptable to summarize privately and then plan as if the full content is available.
4. Context pressure is not a justification for producing a plan that skips BCDP or security review.
   If context is too constrained to complete the review safely, halt and request a smaller task scope.
