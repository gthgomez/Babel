# Contract review checklist (Agent B)

**State:** awaiting Agent A inspectable contract checkpoint (coordinator relay).  
**Agent A run:** https://cursor.com/agents/bc-2b3b69ab-b874-4b9e-958e-61fcca75fc31

Do not begin profile/adapter implementation against shared types until this review is recorded.

## Annex concepts — verify in A's package

- [ ] `ResearchMissionV2` — `as_of`, jurisdiction, constraints, source classes, budget from host (no model-raised caps)
- [ ] `SourceRecord` / `SourceRevision` — identity beyond raw URL; completeness ladder; syndication uncertainty
- [ ] `PassageRecord` — immutable id, revision binding, locators, text hash, truncation flags
- [ ] `FindingRecord` — assertion kinds; integrity vs semantic support; no fake confidence %
- [ ] `QuestionRecord` + plan/report terminal semantics
- [ ] Ports: `ResearchModelPort`, `SourceAccessPort`, `SourceAdapter`, `ResearchStore`, `ResearchProfileDefinition`

## Fake ports and fixtures (Agent A)

- [ ] In-memory fakes implement the same interfaces production will use
- [ ] Both profiles can run identical fake-port harness (no general-only shortcuts)
- [ ] Deterministic stalled-model / repeated-tool-call fixtures present for lifecycle

## B-specific consumption

- [ ] `SourceAdapter` discover/read signatures sufficient for web + document without raw network
- [ ] General profile can declare temporal/jurisdiction/comparison rubric without owning scheduler
- [ ] Document passages support **page** locators for PDF (T-L2)
- [ ] Event/accounting adapter does not require weakening `taskEventJournal` secret key guards

## Review outcome (fill on relay)

| Field | Value |
|-------|--------|
| Contract version | _pending_ |
| A checkpoint commit/branch | _pending_ |
| B reviewer | Agent B |
| Approved / blocked | _pending_ |
| Blocking notes | _pending_ |
