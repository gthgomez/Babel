<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Workspace Locking (v1.0)
**Category:** Governance / Multi-Agent
**Status:** Active

---

## 1. What This Covers

This skill governs the coordination of multiple agents working within the same workspace. It prevents `file_write` race conditions, overlapping refactors, and inconsistent state by enforcing a decentralized locking protocol.

It applies whenever:
- Multiple agents are dispatched in `parallel_swarm` mode.
- A long-running background task needs to protect a directory from concurrent edits.
- The task involves shared resources (environment variables, database schemas, central type files).

---

## 2. The Locking Protocol

Babel uses a **File-Based Advisory Locking** mechanism. Agents do not use a central lock server; they coordinate via the file system using a hidden `.babel/locks/` directory.

### Invariants:
1. **No Write Without Lock**: An agent MUST NOT call `file_write` or `shell_exec` (mutating) without first acquiring a lock on the target file or its parent directory.
2. **Deterministic Lock ID**: Lock files are named using the SHA-256 hash of the absolute file path, e.g., `.babel/locks/<path_hash>.lock`.
3. **Lock Metadata**: Every lock file must be a JSON object containing:
   ```json
   {
     "agent_id": "swe_agent_alpha",
     "run_id": "20260422_refactor_sse",
     "acquired_at": "2026-04-22T22:59:00Z",
     "expires_at": "2026-04-22T23:04:00Z",
     "scope": "file | directory",
     "reason": "Refactoring SSE stream interface"
   }
   ```

---

## 3. Acquisition Workflow

Before any mutating action, the agent must follow this state machine:

1. **DISCOVER**: List `.babel/locks/` to check for existing overlaps.
2. **CONFLICT CHECK**:
   - If a lock exists for the exact file → **WAIT** (random backoff) or **ABANDON**.
   - If a lock exists for a parent directory → **WAIT**.
   - If a lock exists for a child (and agent wants a directory lock) → **WAIT**.
3. **ACQUIRE**:
   - Create the `.babel/locks/` directory if missing.
   - Write the lock file with a 5-minute TTL (`expires_at`).
4. **VERIFY**: Re-read the lock file to confirm ownership (handling race conditions during creation).
5. **EXECUTE**: Proceed with the approved Stage 4 steps.
6. **RELEASE**: Delete the lock file immediately upon completion or halt.

---

## 4. Conflict Resolution

| Condition | Strategy |
|-----------|----------|
| **Stale Lock** | If `expires_at` < current_time, the agent may **BREAK** the lock by deleting it and logging a `PROTOCOL_LOCK_BREAK` event. |
| **Recursive Lock** | An agent may acquire multiple locks (e.g. file + parent) if it owns both. It must release them in reverse order (LIFO). |
| **Deadlock Risk** | Agents must acquire locks in alphabetical order of the absolute paths to prevent circular waits. |

---

## 5. Parallel Swarm Discipline

In `parallel_swarm` mode, the Orchestrator assigns non-overlapping "Sectors" (directories) to different agents whenever possible.

**Rules:**
- **Sector Isolation**: Agents should prioritize work within their assigned Sector to minimize lock contention.
- **Shared Surface Escalation**: If two agents both need to modify a "Shared Surface" (e.g., `.\babel-cli\src\schemas\agentContracts.ts`), the second agent must wait for the first to exit Stage 4 entirely before acquiring the lock.
- **Lock Heartbeats**: For tasks expected to exceed 5 minutes, the agent must call a `heartbeat_lock` tool (if available) to extend `expires_at`.

---

## 6. Failure States

- **LOCK_DENIED**: Agent attempted to write without a lock. CLI Executor must halt with `SCOPE_VIOLATION`.
- **LOCK_TIMEOUT**: Agent failed to acquire a lock after 3 backoff attempts. Pipeline should return to Orchestrator for sector re-assignment.
- **ORPHANED_LOCK**: A lock left behind by a crashed process. Handled by the next agent via the Stale Lock rule.
