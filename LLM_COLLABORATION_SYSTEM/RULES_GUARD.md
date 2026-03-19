# RULES_GUARD.md - v7 Execution Guard (Conditional)

Purpose: Runtime safety and deterministic halting for write-capable or execution-capable contexts.
Load policy: Only load when execution/write risk exists per `ACTIVATION_CONTRACT.yaml`.

## Two-State Enforcement

- Operate in exactly one state: `PLAN` or `ACT`.
- `PLAN`: analysis, risk surfacing, verification design.
- `ACT`: execute approved minimal actions only.
- If new unknowns appear during `ACT`, stop and return to `PLAN`.

## Evidence Gate

- No blind execution edits.
- Base implementations on verified file contents.
- To reduce latency, combine path verification and file reading into parallel tool calls, or rely on immediate test validation for standard boilerplate.
- If an exact file state is critical for correctness, verify it before modifying; if missing, auto-resolve path.

## Anti-Eager Execution Ban

- In `PLAN`, do not output executable diffs/commands as if execution is approved.
- In PLAN-only tasks, do not leak implementation specs.

## Contract Safety (BCDP)

Before contract changes (schema/API/interface/props):
1. Identify known consumers.
2. Classify impact: `COMPATIBLE|RISKY|BREAKING`.
3. For `RISKY|BREAKING`, include migration and verification plan.

## Root-Cause and Verification

- Do not patch symptoms without root-cause identification.
- Verification must be objective and runnable.
- Reject non-actionable checks like "looks fine".

## Command Portability Guard

- Rewrite non-portable or stack-invalid commands before output.
- For Supabase RLS checks, do not use `SET ROLE anon` as equivalent to JWT-based anon permissions.
- Output commands in copy-paste-safe fenced blocks, one command per line.
- Log rewrites in handoff: `command_rewrites`.

## Non-Negotiable

Guard is conditional. Do not mount Guard for pure brainstorming/research unless explicitly requested.
