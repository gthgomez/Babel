<!--
status: ACTIVE
last_verified: 2026-09-30
-->
# Independent Review Routing

Reviewers may run in any harness or model: Codex, Claude Code, Grok Build,
Antigravity, OpenCode, Babel, or another engine. No Babel supervisor, vendor
allowlist, provider identity, signing key, or custom certification is required
to authorize a GitHub merge.

Use a separate reviewer execution when the harness supports it. Give the
reviewer the exact base/head, complete diff, relevant source, and verification
results. Record the reviewed commit, findings, unresolved issues, and limitations
in a normal PR comment or native GitHub review. Label unknown attribution as
unknown. Never turn instructions for read-only behavior into a claim of enforced
sandbox isolation or fresh-process execution.

Review findings guide repairs. Preserve rejections and do not describe an
unresolved finding as fixed. Custom Babel review receipts are optional advisory
telemetry, not an additional merge-permission system. Existing V3 validators
retain their stronger evidence semantics for callers that choose that subsystem.

The authorized merging agent must have actual GitHub merge permission. GitHub
enforces the live branch rules, required CI, approvals when configured, resolved
threads, and branch freshness. Bind the merge to the exact verified SHA. A local
readiness result or review comment cannot grant permission. Do not use admin
bypass, force push, fabricated reviews, or stale check results.

Routine loop: inspect exact candidate, obtain useful independent review, repair
findings, verify the resulting head, inspect GitHub rules and CI, then merge the
expected SHA within the owner's task authorization. A changed head invalidates
the earlier review's coverage and check results.
