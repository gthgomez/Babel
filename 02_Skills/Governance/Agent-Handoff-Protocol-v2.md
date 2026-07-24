<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Agent Handoff Protocol (v2.0)

## Purpose
Formalizes the transition of a task between different specialized agents (e.g., ExampleAgent, example_autonomous_agent, Swarm workers) to maintain continuity and prevent context loss.

## Rules
1. **Handoff Artifact Generation**: Before handoff, the current agent MUST produce a `HANDOFF_ARTIFACT.md` summarizing:
   - Objective status (DONE / PARTIAL / BLOCKED).
   - Significant decisions and their rationale.
   - Known facts vs. assumptions.
   - Pending tasks (the "baton").
2. **Context Distillation**: Summarize long conversation history into a concise "Active Context" block. Do not pass raw logs unless explicitly requested.
3. **Memory Fragment Resolution**: Identify and resolve conflicting information from previous session segments before handing over.
4. **Tool State Persistence**: If the handoff involves ongoing background processes or locks, the state of those tools MUST be documented in the artifact.
5. **Acknowledge Receipt**: The receiving agent MUST read the handoff artifact first and explicitly acknowledge the current state and pending tasks.
6. **Failure Mode Handling**: If the receiving agent lacks a necessary capability (e.g., tool access), it must halt and report the "Capability Gap."

## Artifact Structure
- `[STATUS]`: Current project health.
- `[COMPLETED]`: Bullet list of verified changes.
- `[PENDING]`: Bullet list of next steps.
- `[RISKS]`: Identified technical or policy blockers.
- `[ENVIRONMENT]`: Active env vars, session IDs, or workspace locks.

## Verification
- Confirm `HANDOFF_ARTIFACT.md` exists and contains all required sections.
- Verify the receiving agent starts its first turn by referencing the artifact.
- Check that "Memory Fragments" are resolved (no contradictory goals).

---

## Boundaries — Do Not Overstep
- This skill governs the handoff artifact format and transition protocol between agents. It does not govern the content of the work being handed off (that's the producing agent's domain). It does not govern how results are delivered to humans (that's `skill_async_task_delivery`).
- This skill does not replace agent-specific state management. The HANDOFF_ARTIFACT is a communication artifact, not a state persistence mechanism.

## Failure Behavior of This Skill
- **Receiving agent lacks capability to continue:** Halt and report Capability Gap. Do not attempt to proceed with insufficient tools or context.
- **Handoff artifact is missing or malformed:** The receiving agent must request a complete artifact before proceeding. Do not infer missing sections.
- **Memory fragments are contradictory (can't be resolved):** Flag as UNRESOLVED. Escalate to human. Conflicting prior decisions cannot be resolved by the receiving agent.

## Strategic Next Move
After every handoff, end with one next-move question: confirm the receiving agent has acknowledged the artifact and verified all required sections are present.

## References
- `skill_async_task_delivery` (`02_Skills/Governance/Async-Task-Delivery-v2.md`) — structured delivery to humans (complementary to agent-to-agent handoff).
- `skill_autonomous_agent_state_machine` (`02_Skills/Governance/Autonomous-Agent-State-Machine-v2.md`) — state machine governing the agent producing/receiving the handoff.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening handoff artifact format.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting handoff gaps with sister skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior (3 scenarios), Strategic Next Move, cross-references to sister skills, and meta-tool references. Migrated 2026-06-19.
