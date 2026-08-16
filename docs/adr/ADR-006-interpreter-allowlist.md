# ADR-006: Interpreter Allowlist Approach

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

> **Amendment (2026-08-15):** Membership in the command allowlist is **not** sufficient
> authority to execute. The ADR must be read as distinguishing:
>
> ```text
> command known/allowlisted  !=  command authorized
> ```
>
> Current authorization additionally depends on semantic effect classification
> (effect classes in `executor/contracts.ts`), credential rules, destructive/public/costly
> effect gates, approval policy (interactive, JIT approval, presets), execution profile
> (e.g. `safe_repo` vs `dev_local`), capability policy, and sandbox/isolation
> (H13 fail-closed behavior). The historical env-var approval language below
> (`BABEL_ASK=true`) describes an early interactive-approval mechanism; the current approval
> surface is the policy/preset machinery in `babel-cli/src/agent/policy.ts` and
> `babel-cli/src/agent/approvalRequests.ts`. The original defense-in-depth reasoning stands.

## Context

The CLI Executor needs to run shell commands to accomplish software engineering tasks: installing dependencies (`npm install`), running tests (`pytest`), building projects (`make`), executing scripts (`python script.py`). Blocking all interpreters would prevent these tasks. Allowing all interpreters would remove any security boundary.

We needed a middle ground: allow interpreters needed for common SWE tasks, but add defense-in-depth layers to reduce abuse risk.

## Decision

We use a **command allowlist with defense-in-depth layers**, implemented in `babel-cli/src/sandbox.ts`.

**Base allowlist:** `npm`, `npx`, `node`, `python`, `python3`, `py`, `pip`, `deno`, `git`, `make`, `cargo`, `go`, `java`, `javac`, `gradle`, `gradlew`, `mvn`, `cmake`, `docker`, `cat`, `type`, `echo`, `dir`, `findstr`, `grep`, `ls`, `mkdir`, `rm`, `cp`, `mv`, `touch`, `chmod`, `tar`, `unzip`, `curl`, `wget`.

**Defense-in-depth layers:**
1. **Eval-flag blocking (H1):** `node -e`/`--eval`/`-p`/`--print`, `python -c`, `deno eval` are blocked even though the interpreters are allowed
2. **Execution profiles:** `BABEL_ALLOWED_TOOLS`/`BABEL_DISALLOWED_TOOLS` can disable `shell_exec` entirely
3. **Path traversal prevention:** All file paths validated via `resolveSafe()` with symlink resolution
4. **Shell metacharacter detection:** `SHELL_OPERATOR_RE` blocks dangerous shell syntax
5. **Docker isolation (H3-H4):** Benchmark and non-interactive profiles run in Docker with `--cap-drop=ALL` and `--security-opt=no-new-privileges`
6. **Interactive approval:** `BABEL_ASK=true` requires human approval for each tool call

## Alternatives Considered

**Block all interpreters:** Safest, but prevents most useful SWE tasks. Would require the operator to manually execute every command.

**Allow everything:** Simplest, but no security boundary. Equivalent to running arbitrary code as the user.

**Sandbox-only execution:** Strongest isolation, but adds latency and complexity. H4 (Docker as default) moves toward this.

## Consequences

**Benefits:**
- Common SWE workflows work out of the box
- Multiple defense-in-depth layers reduce abuse risk
- Operators can restrict further via env vars and profiles

**Trade-offs:**
- Interpreters in the allowlist = code execution capability (documented in `SECURITY.md`)
- Eval-flag blocking only catches the most obvious bypass (`python -c`)
- Defense-in-depth layers must be maintained in sync (if one layer weakens, others must compensate)
- Windows `cmd.exe` adds metacharacter parsing complexity (see ADR-007)

## Compliance

Adding a new command to the allowlist requires: (1) documenting the use case, (2) checking for eval-like flags, (3) updating `sandbox.test.ts`, and (4) updating `SECURITY.md` if the command provides code execution capability.
