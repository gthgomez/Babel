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
  --test src/research/v2/profiles/general/contract-regression/aCheckpoint59cd561b.characterization.nonacceptance.probe.ts
```

The probe uses **non-`*.test.ts` naming** so unit-shard / TAP inventory does not load it. Default `test:unit` does not include this file.

## Acceptance (checkpoint.2+, after coordinator agreement)

```bash
export RESEARCH_V2_A_ROOT=/path/to/repaired/a/v2
export RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION=2026.10.20-checkpoint.2
export RESEARCH_V2_RUN_ACCEPTANCE=1
cd babel-cli && npm ci
node --import tsx --import ./src/testinfra/register-no-ambient-inference.mjs \
  --test src/research/v2/profiles/general/contract-regression/acceptance.checkpoint.test.ts
```

`acceptance.checkpoint.test.ts` remains in unit-shard inventory: **default CI passes** without skip markers (acceptance not claimed). Extended placeholder wiring: `acceptance.checkpoint.placeholder.nonacceptance.probe.ts` (opt-in, not inventoried).

## B-owned fixture tests (always)

`../fixtures/dev-corpus/manifest.test.ts` — validates B corpus paths/PDF only; no A imports.
