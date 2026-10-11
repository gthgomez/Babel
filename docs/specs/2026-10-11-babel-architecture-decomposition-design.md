<!--
status: DRAFT
last_verified: 2026-10-11
pin: origin/main@1a5b53c621ea71d1bbf1162e98e35d6835a9b80d
role: design spec (evidence + decisions), not an implementation plan
-->

# Babel — Architecture Decomposition: Design Spec

> **Scope.** A decision record plus extraction design for decomposing Babel's
> repository boundaries, grounded in source-level evidence from
> `origin/main@1a5b53c`. This document decides *what* to extract, *where* it
> goes, and *what contracts must survive*. It is not the step-by-step
> implementation plan; that follows via the writing-plans process.
>
> **Authority note.** This spec does **not** replace
> `docs/architecture/HARNESS_ARCHITECTURE_V1.md` (normative for the runtime
> harness), `docs/architecture/ARCHITECTURE.md` (Prompt OS layers), or
> `prompt_catalog.yaml` (catalog). Those remain the architectural authorities.

## 1. Context

An external architecture map of `gthgomez/Babel` proposed a decomposition into
separate repositories. Its own conclusion was conservative: "the highest-value
next step is a dependency-boundary audit, not a repository split."

The owner has directed a more aggressive posture: **new Git repositories are
authorized unconditionally**, and the review's evidence gates are treated as
*required workstreams* rather than go/no-go checkpoints. This spec reconciles
that direction with the verified coupling evidence.

## 2. Evidence base

All claims below were verified against the local checkout at the pinned commit.
Receipts are in the Appendix. Key findings that shape the design:

1. **Repo Hunt is the cleanest candidate but not independent.** `research/`
   has exactly one inbound integration point (`commands/researchCommands.ts`),
   but it reaches into Babel runtime through two chains:
   - `research/artifacts.ts:26` -> `cli/constants.ts:1,3` -> `config/runtimePaths.js`, `modelPolicy.js`
   - `research/missionPlanner.ts:16` -> `utils/gitExec.ts:4` -> `authority/unprivilegedChildEnv.js`
2. **The eval lab is coupled to harness internals.** `claude-babel-astra-lab/babelHarness.ts:5,7`
   imports `ChatEngine` and `ProviderEngine`. A naive move would replace an
   internal import with a cross-repo source dependency.
3. **There are two `OpenCodeGoApiRunner` implementations** — `runners/openCodeGoApi.ts`
   (294 lines) and `claude-babel-astra-lab/openCodeGoApi.ts` (82 lines) — with
   overlapping but not interchangeable behaviour.
4. **`eval/` (product scoring) must stay.** `agent/codingCorpus/scorer.ts:15-17`
   imports `eval/diagnostics/*`, and `commands/coreBenchmarkCommands.ts:5-8`
   plus `acceptance/fixtureAdapter.ts:5` depend on `eval/`. Extraction would
   drag the agent scoring path with it.
5. **Prompt OS is operationally embedded.** `babel-cli/scripts/stage_runtime_assets.mjs:9`
   reads `prompt_catalog.yaml` and stages referenced assets into the installed
   CLI package. The runtime/compiler therefore cannot leave Babel.
6. **Documentation drift is user-visible, not just stale comments.**
   `researchCommands.ts:48` describes "discovery through shortlist", and the
   `hunt` human summary prints only shortlist candidates, while
   `runHuntDiscovery()` (`research/hunt.ts:169`) runs deep analysis by default
   and produces Pattern Cards that the summary never surfaces.

## 3. Decisions

| Workstream | Decision | Basis |
|---|---|---|
| Documentation drift | **Adopt now** (no gate) | Evidence item 6; fix help, comments, README, and the human summary |
| P0 dependency/import graph | **Adopt; required work** | No boundary report exists; `knip` present but provides dead-code, not boundaries |
| Repo Hunt extraction | **Extract to `babel-repo-hunt`** | Owner-authorized unconditional; host interfaces required (Section 5) |
| Prompt OS boundary | **Keep runtime/compiler + assets; audit authoring** | Evidence item 5; only `04_Meta_Tools/` is a future candidate |
| Experimental eval separation | **Extract to `babel-harness-eval`** | Owner-authorized; requires CLI/protocol contract refactor first |
| `eval/` extraction | **Reject** | Evidence item 4 |
| Hotspot reduction | **Adopt, sequence last** | Governed by existing `tools/check-architectural-budget.ps1` |
| Repo portfolio | **Two new repos; others unchanged** | See Section 4 |
| Review gates | **Advisory -> required workstreams** | Owner override; see Accepted Risks |

## 4. Target repository architecture

| System | Destination | Notes |
|---|---|---|
| `babel-cli`, `babel-desktop` | **Stay** | Product monorepo; runtime authority unchanged |
| Prompt OS runtime/compiler + packaged assets | **Stay** | Installed-product dependency (Evidence item 5) |
| Prompt OS authoring software (`04_Meta_Tools/`) | **Candidate repo, deferred** | Pending Phase 4 audit |
| `eval/` (regression, canary, diagnostics) | **Stay** | Evidence item 4 |
| `babel-cli/src/research/` | **New repo `babel-repo-hunt`** | Thin delegating `babel research hunt`/`inspect` wrappers stay in Babel |
| `claude-babel-astra-lab` + competitive experiments | **New repo `babel-harness-eval`** | Pinned Babel CLI/protocol contract; not placed in `Babel-Harness-Research` |
| `Babel-Harness-Research` | **Stay as-is** | Competitor maps / immutable evidence only; no mutable implementation |
| `Babel-rnd`, `Scout` | **Stay independent** | Archival / contribution-discovery purposes unchanged |

Two new repos is the minimum that satisfies "extract subsystems" without
splitting `eval/` or Prompt OS core, which the evidence shows would break
product paths.

## 5. Extraction mechanics and preserved contracts

### 5.1 Repo Hunt -> `babel-repo-hunt`

Introduce four narrow host interfaces:

- runs-directory resolution (replaces `BABEL_RUNS_DIR` via `cli/constants.ts`)
- git-revision resolution (replaces the `runGitCommand` path)
- path sanitation (replaces `sanitizePathComponent`)
- hardened git child-environment (preserves `hardenGitHostEnvironment` semantics)

Provide a default Babel host implementation and a standalone host for the
package. **Preserved contracts:** `babel research hunt` / `research inspect`
CLI behaviour; on-disk artifact formats (`mission.json`, `candidates.jsonl`,
`score-breakdown.jsonl`, Pattern Cards); security model — GitHub token
handling, untrusted-source handling, mutation prohibitions, evidence
validation. Consumed back into Babel as a pinned package.

### 5.2 Eval lab -> `babel-harness-eval`

1. Resolve the duplicate `openCodeGoApi` (294 vs 82 lines): decide whether the
   lab transport wraps the general runner while preserving fail-closed model
   restrictions, error classification, and credential isolation.
2. Replace `babelHarness.ts:5,7` `ChatEngine`/`ProviderEngine` imports with a
   pinned Babel CLI/protocol contract, so the evaluator imports no Babel
   internals.
3. Update hardcoded lab paths in `authority/commandSpec.test.ts:691-696` and the
   lab imports in `fixtures/claude-babel-astra-lab/fixtures.ts:5` and
   `runners/openCodeApi.test.ts:8,12`.

### 5.3 Dependency-graph tooling (P0)

A small static-import graph over NodeNext output plus a forbidden-dependency
check. Must cover six dependency classes:

| Class | Why |
|---|---|
| Runtime imports | Direct execution coupling |
| Type-only imports | Compile-time contract coupling |
| Test imports | Migration/regression coverage |
| CLI registration | User-facing compatibility |
| Build/package assets | Installed-product dependencies |
| Filesystem/config conventions | Invisible to import graphs (Evidence item 1) |

`knip` stays for dead-code detection; it is complementary, not a substitute.

## 6. Phasing

- **Phase 0 — Immediate, no gate.** Documentation drift (help, comments,
  README, human summary, tests) + `openCodeGoApi` placement/consolidation audit.
- **Phase 1 — Dependency graph + boundary reports.** Build tooling; emit
  inbound/outbound reports for `research/`, `eval/`, `astra-lab`, Prompt OS.
- **Phase 2 — Repo Hunt standalone -> `babel-repo-hunt`.** Host interfaces,
  standalone build/tests, repo creation, delegating wrappers with parity.
- **Phase 3 — Eval lab refactor -> `babel-harness-eval`.** Transport
  consolidation, CLI/protocol contract, allowlist update, repo creation.
- **Phase 4 — Prompt OS authoring audit.** Assess `04_Meta_Tools/` for a future
  authoring repo; keep runtime/compiler and assets.
- **Phase 5 — Hotspot reduction.** Behavior-preserving extraction from
  `chatEngine.ts`, `pipeline.ts`, `sandbox.ts`, governed by the existing ratchet.
  Sequenced last because Phases 2-3 perturb the same surfaces.

## 7. Verification

Per extraction:

- standalone build without Babel source
- standalone unit + integration tests pass
- consumer parity: CLI behaviour and existing artifacts remain readable
- security parity: tokens, untrusted-source handling, mutation prohibitions,
  evidence validation
- install compatibility: source checkout **and** packaged Babel still function

New repos get their own CI; Babel CI gains path filters so a `research/` change
does not run the whole harness suite. Hotspot refactors require characterization
tests before/after and must stay within `config/architectural-budget/file-sizes.json`.

## 8. Accepted risks

- **Cross-repo contract drift** between Babel and the two extracted packages.
- **Duplicated release/trust surface** across three repos.
- **The gates are workstreams, not blockers.** Under the owner's unconditional
  directive, Phases 0-1 are required *work* rather than preconditions; the
  coupling in Section 2 remains real regardless. Mitigation: keep the boundary
  report current and add the forbidden-dependency check to CI.
- Prompt OS is excluded from extraction by operational dependency, not by a
  clean boundary.

## 9. Open questions / deferred

- Does Repo Hunt remain a first-class Babel feature (invocable by the ordinary
  coding loop) after extraction, or only a CLI subcommand? Product interface
  should survive either way.
- Exact package names/scopes for `babel-repo-hunt` and `babel-harness-eval`.
- Whether `04_Meta_Tools/` yields a third repo (Phase 4).

## Appendix — Evidence receipts (pin `origin/main@1a5b53c`)

- `babel-cli/src/research/artifacts.ts:26` -> `babel-cli/src/cli/constants.ts:1,3`
- `babel-cli/src/research/missionPlanner.ts:16` -> `babel-cli/src/utils/gitExec.ts:4`
- `babel-cli/src/runners/openCodeGoApi.ts` (294 lines) vs `babel-cli/src/claude-babel-astra-lab/openCodeGoApi.ts` (82 lines)
- `babel-cli/src/claude-babel-astra-lab/babelHarness.ts:5,7`
- `babel-cli/src/authority/commandSpec.test.ts:691-696`
- `babel-cli/src/fixtures/claude-babel-astra-lab/fixtures.ts:5`
- `babel-cli/src/runners/openCodeApi.test.ts:8,12`
- `babel-cli/src/agent/codingCorpus/scorer.ts:15-17`; `babel-cli/src/commands/coreBenchmarkCommands.ts:5-8`; `babel-cli/src/acceptance/fixtureAdapter.ts:5`
- `babel-cli/scripts/stage_runtime_assets.mjs:9`
- `babel-cli/src/commands/researchCommands.ts:48`; `babel-cli/src/research/hunt.ts:169`
- `docs/architecture/HARNESS_ARCHITECTURE_V1.md:10,17,19,26,50`
- `babel-cli/package.json:148,196` (`knip`); `babel-cli/tsconfig.json:4-5` (NodeNext)
- Coordination hotspots at pin: `chatEngine.ts` 4628, `pipeline.ts` 3243, `sandbox.ts` 2080, `agentTeams.ts` 1326 lines
- Structural: `babel-cli/src/eval/` and `babel-cli/src/evals/` both exist; no root `package.json`/`workspaces`
