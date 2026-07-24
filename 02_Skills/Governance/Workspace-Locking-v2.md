<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Workspace Locking (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** v1.0 (compiled min only — this is the first full-source version)
**Pairs with:** `skill_parallel_swarm_governance`, `skill_autonomous_agent_state_machine`, `ols-compiler` (hardening), `ops-observability` (lock tracing)
**Activation:** Load when multiple agents are dispatched in `parallel_swarm` mode, when a long-running background task needs to protect a directory from concurrent edits, or when the task involves shared resources (environment variables, database schemas, central type files) that multiple agents could mutate simultaneously. Non-negotiable for `pipeline_mode = "parallel_swarm"`.

---

## Purpose

When multiple agents share a filesystem, concurrent writes to the same file produce corrupted state — not errors, but silent corruption that may not surface until much later. Without explicit locking, parallel agents are racing on every shared file.

This skill defines a decentralized, file-based advisory locking protocol using `.babel/locks/`. It enforces: no write without a lock, deterministic lock IDs via SHA-256 path hashing, TTL-based stale lock breaking, and alphabetical lock ordering to prevent deadlocks.

---

## 1. Locking Protocol

### Invariants

1. **No Write Without Lock**: An agent MUST NOT call `file_write` or mutating `shell_exec` without first acquiring a lock on the target file or its parent directory.
2. **Deterministic Lock ID**: Lock files are named using the SHA-256 hash of the absolute file path: `.babel/locks/<path_hash>.lock`.
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

## 2. Acquisition Workflow

Before any mutating action, the agent must follow this state machine:

1. **DISCOVER**: List `.babel/locks/` to check for existing overlaps.
2. **CONFLICT CHECK**:
   - If a lock exists for the exact file → **WAIT** (random backoff) or **ABANDON**.
   - If a lock exists for a parent directory → **WAIT**.
   - If a lock exists for a child (and agent wants a directory lock) → **WAIT**.
3. **ACQUIRE**:
   - Create the `.babel/locks/` directory if missing.
   - Write the lock file with a 5-minute TTL (`expires_at`).
4. **VERIFY**: Re-read the lock file to confirm ownership (handles race conditions during ACQUIRE — two agents creating the same lock simultaneously).
5. **EXECUTE**: Proceed with the approved mutating actions.
6. **RELEASE**: Delete the lock file immediately upon completion or halt.

---

## 3. Conflict Resolution

| Scenario | Action |
|----------|--------|
| **Stale Lock** | If `expires_at` < current_time, the agent may **BREAK** the lock by deleting it and logging a `PROTOCOL_LOCK_BREAK` event. |
| **Recursive Lock** | An agent may acquire multiple locks (e.g., file + parent) if it owns both. Release in reverse order (LIFO). |
| **Deadlock Prevention** | Agents must acquire locks in alphabetical order of absolute paths to prevent circular waits (A waits for B, B waits for A). |

---

## 4. Parallel Swarm Discipline

- **Sector Isolation**: Agents should prioritize work within their assigned Sector to minimize lock contention.
- **Shared Surface Escalation**: If two agents both need to modify a shared surface (e.g., `agentContracts.ts`), the second agent must wait for the first to exit Stage 4 entirely before acquiring the lock.
- **Lock Heartbeats**: For tasks expected to exceed 5 minutes, the agent must call a `heartbeat_lock` tool (if available) to extend `expires_at`. Without heartbeat support, re-acquire the lock before the TTL expires.

---

## 5. Failure States

| Failure | Trigger | Action |
|---------|---------|--------|
| `LOCK_DENIED` | Agent attempted to write without a lock | Halt with `SCOPE_VIOLATION`. Do not proceed. |
| `LOCK_TIMEOUT` | Agent failed to acquire a lock after 3 backoff attempts | Return to orchestrator for sector re-assignment. Do not infinite-wait. |
| `ORPHANED_LOCK` | Lock left behind by a crashed process | Next agent handles via Stale Lock rule. Log `PROTOCOL_LOCK_BREAK`. |
| `LOCK_CONTENTION` | 5+ agents waiting on the same lock | Escalate to human. The task decomposition is too fine-grained — sectors overlap excessively. |
| `VERIFY_RACE` | Lock created but re-read shows different agent_id | Another agent won the race. Release (delete) this lock. Backoff and retry from DISCOVER. |

---

## Hard Rules

1. No mutating file operation without a valid, unexpired lock on the target path.
2. Lock TTL defaults to 5 minutes. Extend via heartbeat for long-running tasks. Never set TTL > 30 minutes.
3. Always release locks in LIFO order. Never leave a child lock after releasing the parent.
4. Never break a non-stale lock. `expires_at < current_time` is the ONLY valid break condition.
5. Acquire locks in alphabetical path order. This prevents deadlocks without a central coordinator.
6. **New in v2.0:** Every lock acquisition, release, and break must be logged as an observable event. Ops-Observability OBSERVE mode should capture lock traces for contention analysis.
7. **New in v2.0:** VERIFY step is mandatory — do not skip it. The ACQUIRE→VERIFY gap is where race conditions live.

---

## Boundaries — Do Not Overstep

- **This skill provides advisory file locking — it does not enforce locks at the OS level.** Agents must voluntarily follow the protocol. A malicious or buggy agent can ignore locks. Enforcement is by convention and pipeline governance, not kernel-level guarantees.
- **This skill does not replace database transactions or application-level locking.** File locks protect filesystem state. Database state requires its own concurrency control (transactions, row-level locks, serializable isolation).
- **This skill does not handle distributed locking across machines.** `.babel/locks/` is a local filesystem convention for agents sharing the same workspace. Cross-machine coordination requires a different mechanism.
- **This skill is not a general-purpose mutex library.** It is scoped to Babel pipeline agent coordination. Do not use `.babel/locks/` for application-level locking in production services.

---

## Failure Behavior of This Skill

- **Lock directory is inaccessible (permissions, disk full):** Halt with `LOCK_DENIED`. Do not proceed with writes. A full disk or permission error means locks can't be created — and writes may also fail silently.
- **Lock heartbeat tool is unavailable for a long-running task:** Re-acquire the lock before the TTL expires (release + acquire in one atomic sequence). If re-acquisition fails, halt the task and release partial work.
- **Agent crashes mid-task without releasing locks:** Handled by the Stale Lock rule. The next agent on the same path will break the orphaned lock after TTL expiry + grace period (1 minute past expiry to account for clock skew).
- **Multiple agents detect the same stale lock simultaneously:** Both attempt to break it. The one whose ACQUIRE + VERIFY succeeds wins. The other detects the race at VERIFY and backs off. This is normal — not a failure.
- **Self-test:** Run two agents in parallel_swarm mode targeting overlapping file sets. Verify zero write conflicts, all locks released, and no deadlocks after 100 operations.

---

## Strategic Next Move

After any lock-related event (ACQUIRE, RELEASE, BREAK, TIMEOUT), end with exactly one strategic next-move question: for LOCK_TIMEOUT, ask whether to re-decompose the task into less-contended sectors; for ORPHANED_LOCK, ask whether to investigate the crashed agent; for repeated LOCK_CONTENTION on the same path, ask whether that file should be split.

---

## References

- `skill_parallel_swarm_governance` — governs multi-agent dispatch and sector assignment that triggers this locking protocol.
- `skill_autonomous_agent_state_machine` — HALT state integration when locks can't be acquired.
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening lock acquisition logic against discovered race conditions.
- `ops-observability` (`02_Skills/Governance/Ops-Observability-v2.md`) OBSERVE mode — for tracing lock events and detecting contention patterns across runs.

---

**Design note:** This v2.0 is the first full-source version of the workspace locking skill. It preserves the v1.0 protocol (6-step acquisition workflow, conflict resolution, failure states) and adds OLS-MCC v4.2 compliance: Boundaries, Failure Behavior (5 scenarios including verify race and lock contention), Strategic Next Move, mandatory VERIFY step, and handoff contracts to parallel swarm governance and the OLS-MCC meta layer.
