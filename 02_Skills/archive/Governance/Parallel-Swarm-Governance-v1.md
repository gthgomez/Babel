# Parallel Swarm Governance (v1.0)

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
