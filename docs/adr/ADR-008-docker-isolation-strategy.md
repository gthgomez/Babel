# ADR-008: Docker Isolation Strategy

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted (Phased — H3 complete, H4 partially implemented, H6 future)  
**Date:** 2026-06-19  
**Deciders:** Babel team  

## Context

The CLI Executor runs shell commands that modify the user's filesystem. Without isolation, a compromised or errant LLM could: delete project files, install malicious dependencies, access network services, or consume excessive resources.

We needed a phased isolation strategy: start with immediate hardening (H1-H3), move toward Docker as default (H4), and research platform-native sandboxes for the long term (H6).

## Decision

We use a **phased isolation strategy** documented in `SECURITY_HARDENING_STATUS.md`:

**H1 — Interpreter Eval-Flag Blocking (COMPLETE):** Block `node -e`, `python -c`, `deno eval` even though interpreters are in the allowlist. Defense-in-depth within the allowlist.

**H2 — BABEL_* Explicit Allowlist (COMPLETE):** Replace prefix pass-through with 50-variable explicit allowlist. Unknown `BABEL_*` variables stripped from child process environments.

**H3 — Docker Security Defaults (COMPLETE):** `--cap-drop=ALL` and `--security-opt=no-new-privileges` on all benchmark containers. `BABEL_BENCHMARK_DOCKER_EXTRA_ARGS` for operator customization.

**H4 — Docker as Default Execution Environment (PARTIALLY IMPLEMENTED):** Extend Docker isolation from benchmark-only to all non-interactive profiles. `docker/sandbox.Dockerfile` exists with Node, Python, Git, build tools. `shouldUseDockerSandbox()` function exists in `benchmarkContainer.ts`. `dockerSandbox` field present in all execution profiles (most set to `true`, `dev_local` and `bench_local` opt out). Docker availability preflight and graceful fallback pending.

**H6 — Platform-Native Sandbox Backends (FUTURE):** Research bubblewrap (Linux), Seatbelt (macOS), and restricted tokens (Windows) as lighter alternatives to Docker. Design a `SandboxBackend` abstraction.

## Alternatives Considered

**All-in on Docker from day 1:** Would have delayed the initial release. Phased approach gets security wins early while keeping the system usable.

**No container isolation:** Simpler, but leaves the host fully exposed to the executor model.

**VM isolation:** Strongest, but highest overhead. Overkill for a CLI tool.

## Consequences

**Benefits:**
- Phased approach delivers security wins incrementally
- Docker provides kernel-level isolation for benchmark workloads
- Opt-out mechanism preserves local development performance
- `SandboxBackend` abstraction prepares for native sandboxes

**Trade-offs:**
- Docker dependency adds setup complexity for operators
- Docker unavailable path must be tested and maintained
- Platform-native sandboxes (H6) are research-phase only — no implementation timeline
- Performance regression for short-lived commands under Docker

## Compliance

All new execution profiles must explicitly declare `dockerSandbox: boolean`. The Docker availability preflight must be checked before every Docker-dependent run. Graceful fallback to direct execution must log a warning and elevate security posture (stricter path enforcement, additional denied tools).
