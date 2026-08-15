<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# 10 — Cross-Harness Autonomy Policy (repo anchor)

The canonical, vendor-neutral autonomy contract is `AGENT_AUTONOMY_POLICY.md`, carried outside the public repo and supplied per session by the operator. This file is the repo anchor so every harness can find the contract by name.

## Contract essence

1. **Autonomy classes** — A = autonomous by default (inspect/read/search/edit task files/format/lint/typecheck/build/test/local run/status/diff/worktrees/bounded subagents/parallel research/evidence/retry). B = autonomous with automatic verification (multi-file refactors, dependency upgrades, CI/build changes, tested-local schema changes, large formatting, public API changes: isolate, snapshot, implement, verify, diff-inspect, independent review when warranted). C = explicit gate or deterministic boundary (live credentials, force-push, history rewrite, deleting significant user data/evidence/unrelated work, publishing, releases, production deploy, IAM/billing, purchases, expensive fan-out, external messages, protected-branch merges, making private material public, destructive DB ops, disabling security controls). D = never without explicit exceptional instruction (exposing API keys, bypassing credential protections, silently force-pushing/deleting, publishing private credentials, hiding failures, fabricating evidence, claiming tests passed when they did not).
2. **Principle** — autonomy is limited by consequence, not capability.
3. **Verification is proportional** to risk class: fast targeted checks during iteration, broader checks before completion, full checks plus independent review for high-risk work. Review the final diff before declaring done (no residue, placeholders, temp artifacts, credential leakage, or unrelated changes).
4. **Credential policy is a hard boundary with layered technical enforcement** — tool-native deny, hooks, example env files, env injection, synthetic fixtures, metadata-only inspection, OS-level sandboxing where available. Behavioral instruction is the last layer, never the only one.
5. **Repository safety** — ship-set staging only; never blind `git add -A` on a mixed dirty tree; prefer worktree/branch isolation over restriction; evidence is never deleted as housekeeping.
6. **Escalation** — ask once, with the full plan, when a Class C gate triggers, intent is ambiguous with material consequence, or evidence is insufficient for the risk class; otherwise proceed to completion without plan-approval stalls (see `06-autonomous-goal-clearance.md`).

Rules 05–09 remain in force; this rule overlays them with the cross-harness contract. When in doubt, the full contract text governs.
