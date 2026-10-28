# Advisory CI evidence plan

## Design and implementation plan

Build a local, offline recommendation tool. Existing full CI and trusted merge
gates remain authoritative. The tool never executes candidate code, calls GitHub,
sets checks, or authorizes a merge.

Owned files: `tools/ci-evidence-plan.mjs`,
`tools/tests/ci-evidence-plan.test.mjs`,
`tools/tests/fixtures/ci-evidence-plan/`, and this guide. No workflow, risk policy,
identity helper, gate, or required-check changes are part of this implementation.

1. Write failing tests for the JSON interface, same-head infrastructure retries,
   carried-forward attempt records, and missing/stale/untrusted evidence.
2. Implement `planEvidence(evidence, context, contextPin)` and a CLI taking
   `--evidence`, `--context`, and `--context-sha256`; print a JSON report to stdout.
   A context pin binds operator-selected bytes, not authenticated GitHub truth.
3. Add the narrowly enumerated native-relative-path assertion repair. Other
   assertions, skips, loader changes, source changes, unknown dependency impact,
   changed build/package output, and shifted selections escalate.
4. Demonstrate the CLI with sanitized fixtures, export its report, run relevant
   checks, obtain one independent review, and publish a draft PR after the normal
   publication gates. No merge is part of this tool's behavior.

V1 permits REUSE only for a successful completed job on the same immutable
candidate and exact recorded job inputs. Across changed heads, even a recognized
portability repair does not establish reusable dependency closure. Its affected
unit jobs can be recommended for RERUN; other unsupported reuse requests escalate.

Reports include reasons, supplied provenance, missing evidence, attempt execution
accounting, and explicit advisory limitations. They contain no merge-ready field
or passing check result. Input exports must exclude credentials and private logs.

## Interface and trust boundary

```sh
node tools/ci-evidence-plan.mjs --evidence evidence.json --context context.json --context-sha256 <operator-selected-context-file-SHA256> > report.json
```

Exit 0 means a report was generated, including reports containing ESCALATE. Exit 2
means invalid arguments or unreadable/malformed input. Neither exit is a CI check
verdict. Raw logs, test bodies and environment values are excluded from reports.

Both documents use `schemaVersion: 1`. Evidence contains `candidate`, `baseline`,
`change`, and `jobs`. Candidate identity is repository, head SHA and tree SHA.
Change records contain the before/after text of changed test files and explicit
dynamic-dependency, compiled-output, package-output and skip dispositions. Unknown
or changed dispositions escalate; an unchanged claim needs an identical baseline.

Context contains independently selected candidate/baseline identity, expected
producer, expected jobs and their input identities, and `evidenceDigest` (SHA256 of
`JSON.stringify(evidence)`). The CLI hashes the **raw context file bytes** against
the supplied context pin. Context and its pin must come from the operator's
independent evidence collection, outside candidate control. A digest cannot
authenticate GitHub or establish that an export is complete or current. This v1
does not collect or sign exports; absent records remain explicit missing evidence.
Do not generate missing environment/input hashes from labels or assumptions.

Each job input identity records head/tree, workflow/policy revisions, and SHA256
digests for command, lock, environment, selection, compiled inputs and package
inputs. Expected and observed values must match. Producer repository, event,
workflow and app must also match, with run/job/attempt provenance. A successful
same-head recommendation only retains that **recorded** result; the live gate
must still resolve the latest authoritative observation. This tool never
transfers success to another head or creates a replacement check.

Only two observed infrastructure signatures are enumerated: artifact creation
timeout during artifact upload, and ETIMEDOUT at `installArtifact` during npm
installation. Those recommend RERUN, not success. Unknown failures escalate.

The portability recognizer accepts only the reviewed edit shape: replace a
literal relative-path array in `assert.deepEqual` with the equivalent
`node:path.join` expression, optionally adding `join` beside `resolve` in the
existing import. It is a text recognizer, not a semantic analyzer. It can only
recommend fresh affected unit qualification, with frozen negative-control
receipts bound to candidate/test/mutation/environment identities. A mutant must
fail its named assertion; loader crashes do not count. Non-unit obligations and
unsupported changes escalate. No cross-head reuse follows from this recognition.
The distinct `wrong-path-delivery` and `missing-glob-metadata` controls are both
required, in the affected unit job's environment. Use separate context/evidence
pairs for platforms with different environment identities.

## Demonstration and limits

Generate fixtures outside the checkout:

```sh
node tools/tests/fixtures/ci-evidence-plan/demo.mjs /tmp/babel-evidence-demo
```

Run the CLI on a generated `.evidence.json` / `.context.json` pair using the pin
in its `.context.sha256` file. `same-head` demonstrates retaining a carried-forward
success and retrying an infrastructure failure; `portability` demonstrates fresh
unit qualification and escalation of unproven package obligations. These are
synthetic demonstrations, not real qualification evidence.

`historical-retry` contains three public job records from run `40578100339`:
a carried-forward policy job, the retried Windows consumer and the fresh Linux
aggregate. It deliberately omits unavailable input hashes and therefore escalates
all three. Their observed work in attempt 2 is 579 seconds across two jobs; the
carried-forward 13 seconds are excluded. This is a sample, not the complete run,
wall-clock lead time, or measured savings. Attempt/job IDs and `created_at` can
change for carried-forward records; accounting uses attempt start versus actual
job start/completion timestamps. Skipped and unexecuted jobs contribute no work.

No dashboards, network requests, external dependencies, hosted schedulers,
workflow edits or merge actions are involved. Run the tests with:

```sh
node --test tools/tests/ci-evidence-plan.test.mjs
```
