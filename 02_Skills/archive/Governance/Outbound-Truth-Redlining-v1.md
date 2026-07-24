<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Outbound Truth Redlining (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when the task is to redline or generate outreach emails, demo scripts, pilot offers, landing-page copy, pricing notes, or AI prompts that will produce customer-facing GTM copy after product truth has already been checked.

---

## Purpose

Claim audit tells you what is true.

This skill tells you how to ship that truth without reintroducing overclaiming in outbound copy.

Use it when the job is:
- convert verified truths into ship-ready sales or marketing copy
- redline risky outbound language
- align private pilot offers with public pricing surfaces
- keep scanner observations, product capabilities, and demo copy in the same scope

It pairs naturally with `skill_product_reality_audit`.

---

## Step 1 — BUILD THE TRUTH STACK

Before rewriting, separate the material into four buckets:

1. `observed_evidence`
   - what was directly observed
   - example: scan results, counts, matched domains, response statuses
2. `product_capability_today`
   - what the product actually does now
   - example: decision records, endpoint controls, exports, retention
3. `explicit_non_claims`
   - what must be ruled out to stay honest
   - example: no legal finding, no downstream-proof claim, no sitewide interception claim
4. `offer_surface`
   - what is publicly listed vs privately offered
   - example: public self-serve plan, private founder-led pilot

If those four buckets are not explicit, do not draft final outbound copy yet.

---

## Step 2 — MAP THE CUSTOMER-FACING SURFACES

List the surfaces that must stay aligned:

- cold email
- async demo script
- landing page
- pricing page
- offer card
- AI prompt that generates any of the above

For each surface, ask:

1. What exact claim is being made here?
2. Is this surface observational, operational, or commercial?
3. Does the wording outrun the verified scope?
4. Would this contradict another public surface?

---

## Step 3 — APPLY THE OUTBOUND REDLINE SHAPE

Default structure for safe outbound copy:

1. observed evidence first
2. explicit limit on what the evidence does **not** prove
3. what the product actually provides today
4. one scope clarifier if confusion risk is high
5. next step or offer

This keeps the copy anchored to reality instead of aspiration.

Preferred sentence pattern:

- "We observed..."
- "This does not by itself prove..."
- "Today, [product] provides..."
- "[Product] does not currently..."
- "If useful, the next step is..."

---

## Step 4 — RUN THE OFFER-ALIGNMENT CHECK

When private offers coexist with public pricing:

1. verify whether the public pricing page already states the relevant self-serve plans
2. verify whether the private pilot is real and intentionally off-menu
3. add a bridge note if both surfaces will be visible to the same prospect
4. do not silently present a private pilot as if it were the public default

If the public pricing page and private outreach package materially disagree, fix the contradiction or explicitly scope the private offer.

---

## Step 5 — GUARD AGAINST THE COMMON GTM DRIFT PATTERNS

Check for these before shipping:

- observational evidence turned into legal accusation
- endpoint-level control turned into sitewide enforcement
- policy payload or decision log turned into browser blocking/interception
- public/private/hosted/open-source claims made without verification
- internal or customer-only artifacts mentioned for prospects who do not have them
- promised recurring deliverables that are not operationalized

---

## Recommended Output Shape

1. risky lines
2. safe replacements
3. unresolved contradictions across surfaces
4. final shippable copy

---

## Hard Rules

1. Never turn observational scan evidence into a legal non-compliance claim.
2. Never turn endpoint controls into whole-site interception or browser-side blocking unless the control point is verified in that path.
3. Never mention a customer decision log, hosted report link, or open-source package unless it already exists and is verified.
4. Never let a private pilot offer contradict the public pricing page without an explicit bridge note.
5. Never promise deliverables like weekly reports, exports, or assisted onboarding unless the team can actually deliver them now.
