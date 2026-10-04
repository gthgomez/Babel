# ADR-015: Repo Hunt — evidence-bound OSS research domain

Date: 2026-10-03
Status: Accepted (Slice A)
Slices: A (this ADR + contracts + safety boundary) → B (GitHub discovery + deterministic triage) → C (evidence acquisition + quarantined deep reader) → D (local applicability + review + report)

## Context

Babel needs a generic capability that converts a project problem into a
research mission, hunts OSS for analogous implementations, and turns what it
finds into revision-bound, inspectable, locally testable engineering claims —
not into raw model opinion. GitHub repository content (READMEs, comments,
issues, filenames) is attacker-controllable text and must be treated as
untrusted data end to end.

Babel already owns the primitives this must not duplicate: SemanticIndexer /
FTS5 / sqlite-vec for *local* indexing, read-only agent lanes, execution
profiles (incl. the high-assurance `babel_research` profile), IndependentVerifier,
evidence machinery, and merge-readiness governance. PR #295 requires every
source test to belong to an explicit test lane.

## Decision

1. **New domain `babel-cli/src/research/`** with versioned Zod contracts
   (`contracts.ts`) as the single source of truth: `ResearchMissionV1`,
   `QueryPlanV1`, `CandidateRecordV1`, `TriageScoreBreakdown`,
   `EvidenceRefV1`, `PatternCardV1`. All durable schemas are `.strict()`
   and `schema_version`-pinned. No competing evidence taxonomy is
   introduced; the evidence-state ladder
   (`DISCOVERED → SOURCE_CONFIRMED → LOCALLY_APPLICABLE_HYPOTHESIS →
   EXPERIMENTALLY_SUPPORTED → INDEPENDENTLY_REVIEWED`) is owned here and
   advances only through host-enforced deterministic validation or
   dedicated later stages — never through model assertion.

2. **Search is separated from solving.** The trusted mission planner never
   consumes remote repository prose. Remote content enters only through
   the provider boundary (`RepositoryResearchProvider`) as structured
   records pinned to exact commit SHAs, and reaches the synthesizer only
   as validated evidence, never as the explorer's raw transcript.

3. **Provider isolation.** Network acquisition lives behind the provider
   interface; V1 ships a deterministic in-memory `FakeResearchProvider`
   and (Slice B) a GitHub provider. Credentials are host-owned and never
   enter prompts, logs, or artifacts. V1 executes zero third-party
   repository code (`source_policy.execute_foreign_code` is a literal
   `false`) and permits zero repository mutation.

4. **Injection containment.** The quarantined deep reader (Slice C) exposes
   only `repo_tree / repo_search / repo_read / repo_symbols / repo_metadata /
   finish`, automatically scoped to repository + pinned commit + mission,
   and emits only schema-validated structured output. Repository text can
   never invoke tools, mutate the target project, or change the mission.
   See `docs/architecture/research-injection-threat-model.md`.

5. **Artifacts under the standard runs root** (`BABEL_RUNS_DIR`), layout
   `runs/<mission>/research/{mission.json, query-plan.json, discovery/,
   snapshots/, evidence/, patterns/, report/}`, atomic tmp+rename writes,
   JSONL for record streams. Raw remote files are not copied into permanent
   evidence; bounded excerpts plus content hashes are.

6. **Staleness is explicit.** Evidence is bound to the external commit SHA;
   local applicability is bound to the target project's HEAD SHA. Either
   moving invalidates the corresponding conclusion.

7. **Research review ≠ code review.** A research reviewer verdict
   (accept / needs-more-evidence / reject) never substitutes for tests,
   security gates, or merge-readiness policy. Once a Pattern Card causes a
   code change, normal Babel governance applies.

## Consequences

- `src/research/*.test.ts` is registered in the `test:unit` glob and the
  lane counts in `tools/tests/package-scripts-and-tests.test.mjs` are
  updated (727→728 unit, 747→748 total).
- The GitHub provider, deterministic triage/diversity, quarantined reader,
  applicability analysis, and review stages are added in later slices on
  top of these contracts; nothing in this slice performs network I/O.
- Deliberately out of scope for V1: foreign-code execution, Sourcegraph/
  Zoekt adapters, pattern knowledge store, peer watch, second index,
  second verifier, subagent concurrency changes.
