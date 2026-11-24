# Babel TUI Visual Testing

This guide defines the external Luna/computer-use workflow for testing Babel in
a real Windows Terminal. Babel supplies the scenario manifest and semantic
evidence; the computer-use controller owns screenshots and input.

## Boundary

The controller must run outside Babel and use a dedicated Windows Terminal
window. It must not type arbitrary commands, access credentials, publish data,
or modify the Babel source tree. Fixture mutations are allowed only inside a
disposable test fixture.

The current repository does not ship a Luna adapter. It ships the contract that
an authorized adapter consumes:

```powershell
cd .\babel-cli
npm run tui:visual:manifest
npm run tui:visual:manifest -- --scenario T10-visual-resize-draft
```

The command only prints JSON. It does not open a terminal or send input.

## Controller contract

An external controller should implement these operations:

- `observe()` — return a unique observation ID, `Date.toISOString()` UTC timestamp, checkpoint
  label, terminal identity and dimensions, launch identity, and a relative PNG
  path and SHA-256. Use `/` separators and the actual case of each file-name
  component on disk. Mark a real terminal window capture as `native_terminal`;
  a reference-renderer screenshot or virtual grid is not native evidence.
- `press_key(key)` — accept only keys from the scenario step.
- `type_text(text)` — type only scenario-provided text.
- `resize(cols, rows)` — resize the dedicated terminal window.
- `wait(milliseconds)` — wait, then observe again.

Use an observe → one action → observe loop. Coordinates, screenshot ids, and
visual conclusions must never be reused after the screen changes.

## Evidence

Set `BABEL_EVENTS_JSONL` to an evidence path before launching the interactive
session. Store each scenario under its own evidence directory with:

- screenshots before and after meaningful actions;
- the captured event stream;
- terminal identity and dimensions;
- the scenario manifest;
- a semantic oracle result;
- Luna findings and a final receipt.

The launcher assigns a fresh session ID, records the full Git revision and the
SHA-256 of the tested build, and retains the start/end window independently of
the receipt. Put screenshots in a private, session-owned artifact directory
that the app cannot write. Use disposable data and redact before persistence
or transmission; have the reviewer inspect the exact redacted bytes.

The version 2 manifest identifies each mandatory visual criterion by `id` and
the zero-based checkpoint index `afterStep`. The independent reviewer must
explicitly mark every criterion `met` and name the checkpoint observation ID and
PNG hash. A missing check, a missing image, a stale or foreign capture, or a
virtual/reference capture leaves the result inconclusive even with zero findings.

Await `buildTuiVisualReceipt` when generating receipts, supplying the
launcher and independent reviewer expectation as the second argument.
With no expectation, a submission cannot pass on its own. When consuming a
receipt, `validateTuiVisualReceiptStructure` only checks its structure; pass the
launcher-owned scenario/run settings and independent review results to
`verifyTuiVisualPass` to check checkpoint coverage, terminal dimensions and
screenshot bytes before accepting a `PASS` claim. That verifier checks PNG
structure and hashes. It does not decode pixels or establish the authenticity
of the capture system.
Both the launcher/controller and reviewer have to be trusted; never infer an
independent visual review from a hash or a controller's assertion.

Version 1 manifests and receipts are historical evidence, not version 2 PASS
proof. Repeat the journey with a compatible controller rather than upgrading
old artifacts in place. The current semantic oracle can report missing events
and malformed JSONL, but event-name presence alone does not establish session
identity or outcomes. Version 2 withholds `PASS` for scenarios requiring
that semantic proof. Visual-only scenarios can run without an event stream.

Receipts use the versioned contracts in:

- `babel-cli/src/services/tuiVisualTestContract.ts`
- `babel-cli/src/services/tuiVisualDriver.ts`
- `babel-cli/src/services/tuiVisualEvidence.ts`
- `babel-cli/src/services/tui-visual-verification.ts`
- `babel-cli/src/services/tuiVisualScenarioCatalog.ts`

Statuses are `PASS`, `BUG`, `BLOCKED`, and `INCONCLUSIVE`. `INCONCLUSIVE` is
the correct result for stale observations, controller errors, or ambiguous
semantic evidence.

## Preflight and scenario coverage

Run the deterministic certification before a live visual session:

```powershell
cd .\babel-cli
npx --yes tsx --no-warnings=ExperimentalWarning --test `
  src/ui/tuiDailyDriverCert.test.ts `
  src/ui/interruptHost.test.ts `
  src/ui/reviewCard.test.ts
```

The initial manifest covers clean unconfigured launch, returning configured launch,
composer cancellation, paste
cancellation, resize, resume-picker cancellation, diff round-trip, Unicode in
narrow terminals, and terminal restoration on exit. It complements rather
than replaces the T01–T23 fixture matrix; real Windows Terminal behavior is
the T24 lane.

Run `T01-visual-clean-start` with an empty disposable profile and no inherited
provider credentials. It checks visible setup guidance and the narrow-screen
checkpoint, not provider authentication or zero network effects. Run
`T01-visual-returning-start` with a separate configured synthetic profile and
the network guard. A ready-composer receipt is not a clean-start receipt.

## Failure classification

- `BUG`: a visual defect persists and contradicts the expected screen state.
- `BLOCKED`: the terminal, runtime, model, or required permission is absent.
- `INCONCLUSIVE`: the controller or evidence is ambiguous.
- `PASS`: every mandatory criterion was positively reviewed at its expected
  checkpoint, with verified artifacts and no unmet evidence requirement.

Keep live visual runs staged or nightly until a dedicated Windows runner can
reliably provide a clean terminal, stable dimensions, and artifact retention.
