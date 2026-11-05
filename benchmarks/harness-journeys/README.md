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

## Native Chat task scorecard

`native-chat-tasks.json` selects repository inspection (J03), a quantity bug fix
(J05), an invoice feature (J06), and a scripted deceptive completion control.
The manifest targets expansion to 16 tasks. Add fixtures and independent oracles
to the existing corpus before extending this selection; repeated fixtures do
not add task diversity.

From `babel-cli`, run model-free calibration in a new directory outside the
checkout:

```sh
node --import tsx scripts/run_native_chat_tasks.mjs \
  --mode calibration --out /tmp/babel-native-calibration
```

This launches a fresh process with isolated home/config and no inherited
credentials or experiment flags. A scripted runner invokes the actual
`ChatEngine.submitMessage` loop and real file tools in disposable repositories.
Correct reference bytes earn `CALIBRATION_PASS` only; accepted completions remain
zero. A correct artifact can coexist with an incomplete engine session. The
deceptive control writes incorrect code and claims completion; independent byte
calibration rejects it. This mode does not execute candidate code on the host
or qualify program behavior, providers, Docker, or installed packages.

For a separately authorized live run using existing credentials, build current
source, then select the approved exact model route:

```sh
npm run build
node --import tsx scripts/run_native_chat_tasks.mjs \
  --mode live --model opencode-go/deepseek-v4.1-flash \
  --code-image <locally-installed-image@sha256:digest> \
  --out /tmp/babel-native-live
```

Live cells use production `run --mode chat-headless` CLI preparation, credentials,
permissions and sandbox policy. No evaluator spend, request, turn or wall caps
are added; production limits remain. Source freshness and the normal OpenCode
credential/durable-budget prerequisites still apply. Coordinate live runs with
other campaigns; the evaluator does not create credentials or choose a fallback.

Before coding cells, a trusted no-network Docker control must read its mounted
workspace. A daemon version or cached image is insufficient. Missing
image/runtime/mount access yields `UNAVAILABLE` and prevents live code admission.
The read-only oracle checks named path facts and preservation, not prose quality.
Live code uses the existing isolated computational ESM oracle over host-captured
bytes. Oracles, references and protected baselines stay outside candidate grants.
These are public development tasks, not held-out qualification.

`report.json` and per-attempt records bind evaluator version/SHA/source hashes,
candidate SHA/dirty status, disposable repository identity, fixture hashes,
terminal outcome, artifact verdict, changes, operations, elapsed time,
verification failures and route/usage evidence. Unknown cost/retry/request counts
remain unknown; estimates and reported costs are separate from invoices. All
scheduled rows are retained. Execution exceptions stop later live admissions
without replay. The deceptive control runs only in calibration. TUI, Electron
and installed release artifacts are separate qualification work.

Focused model-free coverage:

```sh
node --import tsx --import ./src/testinfra/register-no-ambient-inference.mjs \
  --test src/eval/native-chat-tasks.test.ts
```
