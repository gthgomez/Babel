# P2 full-loop WIP quarantine (2026-10-25)

**Not executed by CI** — preserved source uses extension `.ts` without `.test.` suffix.

| Artifact | Purpose |
|----------|---------|
| `p2-full-loop-wip-20261025.ts` | Complete WIP before scope reduction (includes **rejected** `BABEL_CHAT_MAX_COST=unlimited` in `applyDevLocalRunnable`; do not run for qualification) |
| `P2-PRODUCTION-FILE-FUNCTION-PROPOSAL.md` | Root review: small production hook plan (no implementation in this branch slice) |
| Frozen diagnostics | `/tmp/p2-freeze-20261025T235300Z/` (TAP, traces, `ROOT-SCOPE-REDUCTION-PROPOSAL.md`) |

Removed from active `chat-engine-p2-verifier-prerequisite-recovery.test.ts`: dev_local runnable, repair, rearm, reservation-only, shared-capability full loops. Positive/rearm coverage remains in unchanged regression layers listed in the active P2 file header.
