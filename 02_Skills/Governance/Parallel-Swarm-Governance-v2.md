<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Parallel Swarm Governance (v2.0)

## Purpose
Governs the concurrent execution of multiple agents working on a shared codebase or task set ("Parallel Swarm").

## Rules
1. **Advisory Locking**: All agents MUST use `skill_workspace_locking` before modifying any file to prevent race conditions.
2. **Result Aggregation**: A "Manager" or "Aggregator" agent MUST synthesize the outputs of parallel workers.
   - Use **Aggregation Weights** (e.g., Security Agent = 0.4, SWE Agent = 0.3) to resolve conflicting advice.
3. **Decentralized Voting**: For ambiguous decisions, use a simple majority or consensus-based voting protocol among active swarm agents.
4. **Conflict Resolution**: If two agents propose overlapping changes, the Aggregator MUST halt the swarm and request human intervention or a "Conflict Resolution Plan."
5. **Lock-Free Concurrency**: Where possible, partition tasks into disjoint sets (e.g., Agent A works on `/backend`, Agent B on `/frontend`) to minimize locking overhead.
6. **Swarm Heartbeat**: Agents in a swarm MUST report their status every X minutes or after every logical step to the control plane.
7. **Telemetry & Logs**: All parallel outputs MUST include a `run_id` and `agent_id` for correlation in the unified log.

## Swarm States
- **IDLE**: Swarm is ready for dispatch.
- **DISPATCHING**: Tasks are being assigned to workers.
- **EXECUTING**: Workers are performing parallel ACT steps.
- **AGGREGATING**: Results are being merged and reviewed.
- **FINALIZING**: Final plan or code is being committed.

## Verification
- Confirm that `.babel/locks/` correctly tracks active worker agents.
- Verify that the final aggregated result includes contributions from all required specialists.
- Test "Collision Recovery" by simulating two agents attempting to lock the same file.

---

## Boundaries — Do Not Overstep
- This skill governs swarm-level dispatch and aggregation. Per-file locking is handled by `skill_workspace_locking`. Per-agent state transitions are handled by `skill_autonomous_agent_state_machine`. Result delivery format is handled by `skill_async_task_delivery`.
- Swarm aggregation does not override individual agent safety halts. If any agent HALT-s, the swarm must pause and escalate — do not aggregate around a halted agent.

## Failure Behavior of This Skill
- **Swarm heartbeat lost (agent unresponsive):** Mark agent as STALE. Redistribute its tasks to remaining agents if the task is partitionable. Otherwise, HALT the swarm.
- **Aggregation produces conflicting recommendations:** Escalate to human. Do not silently pick one recommendation — the aggregation weights are advisory, not authoritative.
- **Lock contention prevents progress:** Escalate to `skill_workspace_locking` failure behavior. If contention exceeds threshold, re-decompose into more granular sectors.

## Strategic Next Move
After every swarm plan, end with one next-move question: confirm sector assignments are disjoint and lock ordering prevents deadlocks.

## References
- `skill_workspace_locking` (`02_Skills/Governance/Workspace-Locking-v2.md`) — mandatory for all swarm agents.
- `skill_autonomous_agent_state_machine` (`02_Skills/Governance/Autonomous-Agent-State-Machine-v2.md`) — per-agent state during swarm execution.
- `skill_multi_agent_pipeline` (`02_Skills/Governance/Multi-Agent-Pipeline-v2.md`) — agent base class contract and aggregation patterns.
- `Workflow-Patterns/Hierarchical-Delegation-v1.md` — composable delegation pattern for swarm dispatch.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening swarm governance.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions with sister skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior (3 scenarios), Strategic Next Move, cross-references to sister multi-agent skills, and meta-tool references. Migrated 2026-06-19.
