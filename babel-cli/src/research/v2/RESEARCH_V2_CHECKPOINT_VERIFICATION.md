# Research v2 checkpoint verification (local)

Frozen repair candidate: `7ed4ae3d9359fa11f5ef6e49c6fb212cff6fbb59` (tree `141ce02a4145c8fe37861fe10e974490a9eba25c`).  
Publication and live API remain **held** until explicit coordinator release.

## Typecheck and build

```bash
cd babel-cli
npm run typecheck
npm run build
```

## Recursive test manifest (v2 tree + original and repair CLI tests)

Generate the file list:

```bash
cd babel-cli
node scripts/research-v2-collect-test-files.mjs > /tmp/research-v2-test-manifest.txt
```

Run the manifest (not a glob shortcut — includes every nested `*.test.ts` under `src/research/v2/` plus both CLI test modules):

```bash
cd babel-cli
node scripts/research-v2-collect-test-files.mjs | tr '\n' '\0' | xargs -0 \
  npx tsx --no-warnings=ExperimentalWarning --test
```

Prior scoped runs (different counts — do not conflate):

| Scope | Command gist | Archived count |
|-------|----------------|----------------|
| fe7f122b export | `find src/research/v2 -name '*.test.ts'` + `researchV2Commands.test.ts` | 123 tests |
| 7ed4ae3d repair evidence | `src/research/v2/**/*.test.ts` + `researchV2Commands.repair.test.ts` | 112 tests |

This manifest supersedes both for **future checkpoint requests**.

## Original captured guard outputs

Do not re-run historical publication guards for routine slice work. Use archived copies:

- `review-artifacts/agent-a-aggregate-e0b-publication-evidence/`
- `review-artifacts/agent-a-candidate-7ed4ae3d-evidence/`

Fresh guard runs are required only at an explicit publication checkpoint.
