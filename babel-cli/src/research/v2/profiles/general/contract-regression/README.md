# Contract regression (Agent B)

Read-only regression against **Agent A** shared V2 contract at a pinned root.  
Does **not** modify A files.

## Run (fails on `59cd561b`)

```bash
export RESEARCH_V2_A_ROOT=/tmp/review-a-contract/babel-cli/src/research/v2
cd babel-cli
npm ci   # in worktree with A checkpoint if needed
node --import tsx --import ./src/testinfra/register-no-ambient-inference.mjs \
  --test src/research/v2/profiles/general/contract-regression/aCheckpoint59cd561b.regression.test.ts
```

Set `RESEARCH_V2_A_ROOT` to any checkout of A’s `research/v2` tree.

Expected on **59cd561b:** failures documenting FIX items 1–9.  
Expected on **checkpoint.2 (A repair):** all green.
