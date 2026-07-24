# Babel Production Proof Artifacts

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Date: 2026-06-05 (evidence relocated 2026-06-17)

This directory formerly held evidence input for `babel benchmark production --json`.
JSON artifacts have moved to `artifacts/production-proof/`.
Implementation evidence moved to `docs/archive/production-proof-IMPLEMENTATION_EVIDENCE_2026-06-05.md`.

Production wording is scoped to the proven DeepSeek-backed governed Babel CLI
lane. Artifacts here must not be used to claim provider-agnostic production,
market parity, or safe live autonomous subagents unless the corresponding JSON
proof marks that surface as `pass` and names the evidence.

Current status:

- `live-governance-breadth-proof.json`: pass for the focused DeepSeek breadth
  harness covering governed completion, QA rejection, executor halt, verifier
  blocking, dirty-worktree preservation, schema-failure halt/recovery, and cost
  evidence.
- `verifier-rollback-proof.json`: pass for deterministic local verifier and
  rollback/worktree safety proof.
- `live-subagent-proof.json`: pass for deterministic read-only Babel Full lane
  evidence scaffolding (route decision, Spark read-only roles, hardened plan,
  QA review, and cost ledger).
- `subagent-plugin-public-proof.json`: pass for read-only Spark plan-hardening
  proof, plugin fixture proof, and strict public-export proof. Mutating live
  subagents remain excluded from scoped production wording.
- `schema-learning-status.json`: partial; schema validation-recovery replay
  support is instrumented and surfaced in inspect outputs for malformed planner
  output recovery.
- `IMPLEMENTATION_EVIDENCE_2026-06-05.md`: Codex integration evidence for this
  production-proof implementation pass.
