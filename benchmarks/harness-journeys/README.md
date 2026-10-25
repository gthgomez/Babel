# Harness journey development corpus

This public synthetic corpus defines 18 journeys across seven task families and
20 adversarial controls. It is development material, not held-out qualification.

From `babel-cli`, run `npm run eval:harness-journeys -- --out <new-directory>`.
The offline command creates disposable fixtures and records evaluator source,
rubric and fixture hashes in `frozen-evaluator.json`. It refuses an existing
output directory and makes no provider requests. Git commands are confined to
new fixture repositories, with every exit checked. Unicode paths and bytes,
tracked user edits and untracked drafts are preserved in protected baselines.

Each prepared cell has a candidate root and a separate protected baseline root.
The host adapter must grant only the intended candidate/resources/output paths;
the corpus, evaluator code, rubric, baseline and campaign record stay outside
candidate tool grants. Same-process callbacks and hash checks are not an OS
sandbox. Pin the complete evaluator code/data before candidate implementation
and run it from that revision during comparisons. Held-out answers must remain
private and use independent tasks.

`runJourney` in `src/eval/harness-journey-contract.ts` calls a real host candidate
adapter and then a separately sealed evaluator. Candidate/model return payloads
cannot select the oracle or supply a passing verdict. The trusted adapter's
observation callback reads host evidence, not model claims. Each attempted cell
is retained before another starts. Missing usage is unknown, never free.
Adapters enforce the supplied execution limits and own cancellation/settlement.

Preparation does not start source servers, connected test services, steering or
fault injectors. It does not claim executable graders, rendered HTML acceptance,
blind prose scores or product task completion. Those host integrations are
required before the relevant journey can qualify a backend. A rubric's presence
alone is never a passing oracle. `npm run test:harness-journeys` exercises the
evaluation boundary and fixture preparation without paid inference.
