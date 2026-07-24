# Agent Handoff Protocol (v1.0)

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
