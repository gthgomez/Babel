# Contract review checklist (Agent B)

**State:** FIX on A `59cd561b` / `2026.10.20-checkpoint.1` — not waived. See `REVISED_CONTRACT_CHECKPOINT.md`.

## A shared contract (Agent A checkpoint)

- [ ] `ResearchMissionV2` — `as_of`, jurisdiction, constraints, source classes, budget from host
- [ ] `SourceRecord` / `SourceRevision` — identity beyond raw URL; completeness ladder
- [ ] `PassageRecord` — revision binding, locators (incl. PDF `page`), text_ref discriminated unions
- [ ] `FindingRecord` — assertion kinds; citation integrity vs semantic support (separate enums)
- [ ] `QuestionRecord` + plan/report terminal semantics
- [ ] Ports: `ResearchModelPort`, `SourceAccessPort` (admitted bytes), `SourceAdapter` **read/extract**, `ResearchStore` external ops, `ResearchProfileDefinition`

## B fixture / corpus peer review (strengthened — A missed on first pass)

- [ ] `fixtures/dev-corpus/manifest.json` auxiliary paths resolve from **manifest directory** (`../security/`, `../../../../adapters/documents/fixtures/`)
- [ ] `manifest.test.ts` resolves **every** declared asset (sources, security, documents), parses mission/expectation JSON, validates PDF header/pages/text
- [ ] G-DEV brief JSON is **not** cast to `ResearchMissionV2` without explicit normalization layer
- [ ] No broken relative paths in manifest for security or document fixtures

## Fake ports / characterization (opt-in only)

- [ ] Pre-fix evidence in `contract-regression/CHARACTERIZATION_EVIDENCE_59cd561b.md`
- [ ] Acceptance wired after coordinator agrees checkpoint.2

## Review outcome

| Field | Value |
|-------|--------|
| Contract version reviewed | `2026.10.20-checkpoint.1` |
| A head | `59cd561b2414fcc32253de568c70285517eae1cd` |
| B verdict | **FIX** (nine items — not waived) |
| B manifest path review | **FAIL on c7ff361e** — repaired locally at `97063a82`+ |
| Coordinator agreement | _pending_ |
