# Contract tests (Agent B) — characterization vs acceptance

This directory is **not** a second schema. It imports and exercises **Agent A’s** published `research/v2` tree at `RESEARCH_V2_A_ROOT`.

## Pre-fix characterization (checkpoint.1 / `59cd561b`)

**Purpose:** Record fail-before evidence for the nine-point FIX review.  
**Not:** passing acceptance, CI default, or B contract ownership.

**Frozen evidence:** `CHARACTERIZATION_EVIDENCE_59cd561b.md` (8 fail / 1 pass on 2026-10-20).

**Opt-in run only:**

```bash
export RESEARCH_V2_A_ROOT=/path/to/a/research/v2   # must be checkpoint.1
export RESEARCH_V2_CHARACTERIZE_PRE_FIX=1
cd babel-cli && npm ci
node --import tsx --import ./src/testinfra/register-no-ambient-inference.mjs \
  --test src/research/v2/profiles/general/contract-regression/aCheckpoint59cd561b.characterization.test.ts
```

Default `node --test` on this repo **skips** characterization (no intentional failures in combined tree).

## Acceptance (checkpoint.2+, after coordinator agreement)

```bash
export RESEARCH_V2_A_ROOT=/path/to/repaired/a/v2
export RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION=2026.10.20-checkpoint.2
export RESEARCH_V2_RUN_ACCEPTANCE=1
# same node --test invocation for acceptance.checkpoint.test.ts
```

Wire acceptance to shared expectations when A’s repaired head is relayed. Until then, acceptance remains skipped.

## B-owned fixture tests (always)

`../fixtures/dev-corpus/manifest.test.ts` — validates B corpus paths/PDF only; no A imports.
