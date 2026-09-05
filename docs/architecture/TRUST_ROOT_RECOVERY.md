# Trust Root Recovery (break-glass rekey)

<!--
status: ACTIVE
last_verified: 2026-09-05
-->

Formal lost/compromised-key recovery mode for the Babel trust root. This
document designs the protocol; it does not execute it. Companion docs:
[TRUST_SIGNING_CUSTODY.md](./TRUST_SIGNING_CUSTODY.md) (custody design and
routine rotation), [TRUST_ROOT_UPGRADE.md](./TRUST_ROOT_UPGRADE.md)
(TrustRootUpgradeV1), [TRUST_CEREMONY_LIFECYCLE.md](./TRUST_CEREMONY_LIFECYCLE.md).

Core principle:

> **Recovery must never become a convenient bypass.** It exists so that a
> lost key is an inconvenience, not a permanent deadlock — and it must be
> strictly harder to run than the ceremony it replaces.

Sanctioning: break-glass is legitimate **only when TrustRootUpgradeV1 is
impossible** — the signing authority itself is lost, compromised, or
corrupted beyond use. Any trust-root change that *can* ride the ordinary
ceremony must ride the ordinary ceremony; recovery is the deadlock exit, not
a shortcut lane.

## Triggers

| Scenario | Entry state |
| --- | --- |
| Reviewer private key lost/unavailable | `AUTHORITY_UNAVAILABLE_DETECTED` |
| Supervisor private key lost/unavailable | `AUTHORITY_UNAVAILABLE_DETECTED` |
| Both keys lost | `AUTHORITY_UNAVAILABLE_DETECTED` |
| Suspected compromise (either key) | `AUTHORITY_UNAVAILABLE_DETECTED` (compromise variant: immediate retire, no overlap window) |
| Registry corruption (invalid registry on `main`) | `RECOVERY_DECLARED` |
| Signing service unavailable but keys intact | *not* a recovery trigger — fix or replace the service (custody doc); key custody is intact, not lost |

## Recovery authentication — what establishes owner authority?

Distinguishing current capability from recommended future capability, without
inventing capability Babel does not have:

**Current capability (what the protocol may rely on today):**

- GitHub repository-owner authority: the `protect-main` ruleset can only be
  edited by a repository administrator; that edit is itself authenticated by
  the GitHub account (platform MFA as configured on that account).
- Local machine administrator on the single-owner Windows environment.
- No cryptographic owner identity beyond GitHub/platform accounts; no
  hardware security credential; no offline recovery secret; no pre-registered
  emergency key exist today. **The protocol must not pretend otherwise.**

**Recommended future capability (adopt deliberately, not during an incident):**

- Hardware-backed FIDO2 MFA on the GitHub owner account;
- offline recovery codes in sealed physical storage;
- an annually *exercised* recovery drill so the owner path is known-good
  before it is ever needed.

Layered model: GitHub owner authority is the floor; hardware MFA and drilled
procedure are hardening. The break-glass path authenticates the *repository
owner*, never the builder.

## State machine

```text
NORMAL
  ↓ authority unavailable or compromised detected
AUTHORITY_UNAVAILABLE_DETECTED
  ↓ owner declares recovery (explicit owner act, recorded)
RECOVERY_DECLARED
  ↓ exact candidate SHA frozen; no unrelated changes permitted
RECOVERY_CANDIDATE_FROZEN
  ↓ owner identity confirmed through the layered model above
OWNER_IDENTITY_CONFIRMED
  ↓ byte-for-byte ruleset snapshot recorded (required checks + enforcement)
RULESET_SNAPSHOT
  ↓ temporary administrative exception, narrowly scoped:
  ↓   only `trusted-control-plane` may be relaxed, only for this PR
BOUNDED_EXCEPTION
  ↓ recovery PR merges (rekey-only candidate, all other checks green)
REKEY_MERGE
  ↓ ruleset restored immediately; verified byte-for-byte vs snapshot;
  ↓ zero bypass actors throughout
RULESET_RESTORED
  ↓ new authority exercised end-to-end (challenge → receipt / authorization)
NEW_AUTHORITY_VERIFIED
  ↓ next ordinary PR re-certifies the trust plane with no exception
MANDATORY_RECERTIFICATION
  ↓ durable incident/recovery report filed
RECOVERY_CLOSED
```

Any unexpected mutation (unrelated change in the recovery PR, an additional
check removed, a bypass actor appearing, snapshot mismatch at restore)
returns to a safe earlier state — most commonly
`RECOVERY_CANDIDATE_FROZEN` — and halts until reconciled. Unexpected
mutations are never "absorbed."

## Recovery candidate constraints

A break-glass rekey PR is restricted to an explicit allowlist:

```text
config/independent-review-keys.json
config/trusted-supervisor-keys.json
required recovery documentation (the incident/recovery report)
minimal verifier compatibility changes — only if absolutely necessary,
  justified in the report
```

No product features. No provider work. No unrelated refactors. The recovery
PR must reject mixed-purpose changes mechanically (path allowlist check in
review, and the exact changed-path set recorded in the report).

Replacement registries carry **replacement public keys only** — never private
material, never operator-identifying metadata.

**Machine check.** The path allowlist is enforced mechanically, not by
reviewer attention. Before staging a recovery PR — and re-run immediately
before the recovery merge — the operator must run:

```powershell
pwsh -NoProfile -File scripts/verify-recovery-scope.ps1 -BaseSha <base> -HeadSha <head>
```

Any changed path outside the allowlist exits non-zero with
`RECOVERY_SCOPE_VIOLATION` and the candidate is not a legal recovery
candidate.

## Recovery window (no unrelated merge can ride the exception)

A ruleset's required checks apply to all open PRs targeting `main`, so the
bounded exception window is repo-wide. The window is therefore mechanically
bounded, not merely recorded:

1. **Precondition** before any required check is relaxed:

   ```text
   OPEN_NON_RECOVERY_PRS == 0
   ```

   If any unrelated PR is open, it must merge through the full ordinary
   ceremony first, or be closed; the exception is not granted until the
   condition holds. Record the live PR list in the incident report at this
   moment.

2. **Re-check immediately before the recovery merge.** If another PR opened
   or changed after the exception was granted:

   ```text
   RECOVERY_WINDOW_BLOCKED
   ```

   The merge is aborted until the window is exclusive again. No unrelated
   merge can occur while the bounded exception is active.

3. The exception window (grant time, merge time, PR list at both moments) is
   part of the incident report.

## Procedure (bounded-exception mechanics)

Modeled on the bounded #138 migration, improved with the following tightenings:

1. **Declare:** owner declares recovery in the incident report (durable,
   dated, stating trigger and scope).
2. **Freeze:** exact candidate head SHA for the rekey PR is recorded before
   any exception is granted; the head may only change by returning to
   `RECOVERY_CANDIDATE_FROZEN` and re-freezing.
3. **Snapshot:** the active rulesets are captured byte-for-byte
   (`GET /repos/{owner}/{repo}/rulesets` for each active ruleset) and stored
   in the incident report **with a SHA-256 snapshot hash** over the captured
   JSON (ruleset id, required checks, strictness, enforcement, bypass actors,
   allowed merge methods, review-thread policy).
4. **Exception:** remove exactly one required check (`trusted-control-plane`)
   from exactly the `protect-main` ruleset, for exactly this PR. Note the
   platform reality: a ruleset's required checks apply to **all** open PRs
   targeting `main`, so the exception window is repo-wide — the incident
   report must record that no other PR merged during the window. No bypass
   actors are added; no other check is touched; the exception window is
   measured and recorded.
5. **Merge:** the recovery PR merges only when all remaining required checks
   are green at the frozen head and the path allowlist holds.
6. **Restore:** the ruleset is restored immediately after merge and verified
   byte-for-byte against the snapshot (recomputed snapshot hash must equal
   the recorded hash). Any drift is an incident:

   ```text
   RECOVERY_RULESET_RESTORE_FAILED
   ```

   The incident stays open until exact equality is restored and verified.
7. **Verify:** the new authority completes one full end-to-end signing cycle
   under the restored ruleset — the new reviewer key issues a receipt for a
   live candidate (the recovery-closure report PR is a natural vehicle), and
   the new supervisor key authorizes a protected change under
   TrustRootUpgradeV1. If no protected change is immediately legitimate, the
   supervisor exercise rides the next one; the incident report records which
   vehicle was used and the interim state until it completes.
8. **Re-certify:** the next ordinary PR based on the new `main` must obtain a
   green `trusted-control-plane` with **no** exception — that run is the
   proof the restored trust plane works end-to-end.
9. **Close:** the incident/recovery report is completed (timeline, snapshot
   IDs, exception window, artifacts signed by the new authority) and the
   state machine returns to `NORMAL`.

## Why this is harder than the ceremony it replaces

- It requires explicit repository-owner action at four separate points
  (declare, confirm identity, grant exception, confirm restore);
- it produces a durable public record with exact SHAs and snapshot
  comparisons;
- it grants no standing capability — every use starts from
  `AUTHORITY_UNAVAILABLE_DETECTED` and ends with mandatory re-certification;
- and routine [rotation](./TRUST_SIGNING_CUSTODY.md), which is strictly
  easier, removes most of the situations that would ever reach for break-glass.
