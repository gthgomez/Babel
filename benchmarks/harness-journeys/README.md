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

The preparation command records steering schedules without executing them.
`withJourneyResources` starts owned loopback source/record services, persists
their read/effect receipts outside candidate grants, and closes them on failure.
It includes one-shot source failure and commit-then-lost-reply controls. Atlas
and Boreal have distinct Git histories with supplied-baseline tags; their
discoverable workspace excludes the protected evaluator directory.

Executable development oracles inspect host-captured immutable snapshots.
They never open candidate-selected filesystem paths. Code runs through the
existing hardened Docker clean-room executor with a host-selected pinned image;
expected values remain in the host, and exit zero alone cannot pass. HTML uses
an optional local Playwright renderer with script disabled and requests blocked.
Missing isolated execution, renderer or independent blind assessment remains
unavailable. Blind jobs exclude route identity and bind answer, artifact and
rubric hashes. The host must obtain scores in a separate trusted context; helper
objects and calibration scores do not establish reviewer independence.

The development code oracle supports synchronous computational ESM exports and
their captured relative JavaScript dependency closure (up to 64 files/4 MiB).
Other runtime envelopes, including external packages, dynamic imports and async
return values, remain unavailable. Inside Docker, a closed VM realm receives
only source and literal arguments; primitive results cross to trusted worker
serialization without candidate process/stdout access or host callbacks.
Node's VM is not the OS security boundary. Atlas/Boreal inspection additionally
compares captured HEAD, working-tree status and Git metadata hashes, and resume
grading requires one later settlement for every admitted submission identity.
Git capture requires stopped writers and the protected preparation digest;
changed metadata is rejected before host Git interprets any repository config.

`npm run test:harness-journeys` exercises the grading boundary and fixtures
without paid inference. Docker/browser calibration requires explicit admission
via `BABEL_JOURNEY_ORACLE_TEST_IMAGE` (local pinned image) and
`BABEL_JOURNEY_HTML_TEST=1`; run sequentially with a resource budget. Scripted
reference observations calibrate the oracles, never qualify a backend. Actual
engine steering, provider execution, held-out outcomes and default selection
remain separate qualification work. A rubric or prepared schedule is not a pass.
