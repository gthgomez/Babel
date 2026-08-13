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

- `observe()` — return a screenshot, timestamp, terminal dimensions, and a
  stable observation id.
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

The Babel semantic oracle treats missing required events or malformed JSONL as
evidence failure. UI-only scenarios with no required events may run without an
event stream. A visual finding alone must not be promoted to `PASS`.

Receipts use the versioned contracts in:

- `babel-cli/src/services/tuiVisualTestContract.ts`
- `babel-cli/src/services/tuiVisualDriver.ts`
- `babel-cli/src/services/tuiVisualEvidence.ts`
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

The initial manifest covers clean launch, composer cancellation, paste
cancellation, resize, resume-picker cancellation, diff round-trip, Unicode in
narrow terminals, and terminal restoration on exit. It complements rather
than replaces the T01–T23 fixture matrix; real Windows Terminal behavior is
the T24 lane.

## Failure classification

- `BUG`: a visual defect persists and contradicts the expected screen state.
- `BLOCKED`: the terminal, runtime, model, or required permission is absent.
- `INCONCLUSIVE`: the controller or evidence is ambiguous.
- `PASS`: visual and semantic expectations agree.

Keep live visual runs staged or nightly until a dedicated Windows runner can
reliably provide a clean terminal, stable dimensions, and artifact retention.
