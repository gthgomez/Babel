# Babel reliability cases

An independent, offline grading corpus for the coding-loop reliability cases
named in the November 2026 audit. It drives the real `ChatEngine` with a
deterministic scripted provider in a disposable Git workspace, then grades the
final bytes with an oracle that lives in this directory - never in the
candidate workspace.

This is a protocol and logic control surface. It creates no provider client,
reads no credential and makes no network request. It is not model-performance
evidence.

## Grading axes

Each case records, separately:

1. **Exercised** - the case actually ran. A missing fixture, exception or
   timeout is `ungraded`, never a pass.
2. **Behavior** - the held-out oracle's verdict over the final bytes.
3. **Effects** - the observed Git-visible mutation set.
4. **Terminal truth** - the engine outcome, the durable completion decision and
   whether a success class was claimed while an obligation was unmet.
5. **Documents** (where applicable) - whether the requested documentation
   artifact exists, independent of the engine's own check.

A red behavioral oracle therefore cannot become success because the patch
resembles a reference, and a correct candidate is not a failure merely because
an unrelated inherited check is red.

## Cases

| Case | Obligation | Control |
| --- | --- | --- |
| `L01-wrong-value-9` | A value-9 patch under an API-preservation clause cannot certify | Negative |
| `L01-correct-value-2` | A correct value with only a weak witness stays an honest partial | Negative (over-claim) |
| `L01-correct-relevant-witness` | A correct value with a relevance-matched assertion completes | Positive |
| `L01-compound-preservation-clause` | A clause embedded with "and" splits without losing the goal | Positive |
| `L01-polite-preservation-clause` | A polite lead-in does not make the goal unsatisfiable | Positive |
| `L02-docs-token-without-example` | An unchanged README token is not the requested runnable example | Negative |
| `L02-docs-runnable-example` | A relevant fenced example is present in the final artifact | Positive |
| `L03-read-only-required-red` | A current red required check vetoes no-change success | Negative |
| `L04-compatible-export-addition` | An additive export under compatibility wording completes | Positive |
| `L04-exact-mode-refuses-addition` | Exact wording refuses the unrequested export and claims no success | Negative |
| `L05-return-before-assertion` | An assertion after `return` is not behavioral evidence | Negative |
| `L06-caught-assertion` | A swallowed assertion is not behavioral evidence | Negative |
| `L07-discarded-call-result` | A discarded call result is not behavioral evidence | Negative |
| `L08-real-assertion-control` | A direct, uncaught assertion remains usable | Positive |
| `R06-omitted-opening-goal` | A command-only success cannot displace the opening goal | Negative |
| `E36-weak-project-witness` | A type-only project test cannot certify the stated value | Negative |
| `E09-denied-readless-answer` | A denied write does not ground an informational answer | Negative |
| `E09-grounded-read-control` | A read-grounded informational answer still completes | Positive |
| `E25-lock-write-denied` | An operator-declared lock refuses the write and reports policy | Negative |

## Run

```sh
# From babel-cli (tsx supplies the TypeScript loader):
npx tsx ../benchmarks/reliability-cases/run.mjs
npx tsx ../benchmarks/reliability-cases/run.mjs L05-return-before-assertion
```

The runner prints one JSON record per case and exits non-zero when any selected
case fails or remains ungraded. `npm run test:benchmark-eval` from
`babel-cli` also runs the suite through the hosted benchmark gate.

## Declared limits

- Scripted responses exercise host invariants, not model quality.
- Oracles check the named deterministic obligations only. A passing case is not
  a general proof of arbitrary semantic coverage.
- The harness uses `host_native`/`dev_local` for disposable fixtures. Docker
  isolation, packaged Desktop and live providers are separate qualification
  surfaces and are not claimed here.
- Documentation completion remains partial by design when the engine has no
  host-supported observation for the requested artifact; the runner records the
  artifact and the terminal separately rather than inventing success.
