# Platform Mode Guidelines

## Purpose

This document translates the platform research in [PLATFORM_CAPABILITY_MATRIX.md](./PLATFORM_CAPABILITY_MATRIX.md) into actionable Babel design guidance.

The point is not to rank models.

The point is to give Babel a stable vocabulary for:
- platform container type
- repo ingestion and freshness
- repo writeback limits
- output surface shape
- approval boundaries
- separate trust axes

## Core Rule

Platform modes are descriptive constraints.

They should affect:
- evidence expectations
- task routing
- upload/privacy posture
- writeback assumptions
- approval requirements

They should not replace:
- Behavioral OS
- domain architects
- project overlays

## Container Modes

### `chat`

Meaning:
- a normal conversation thread
- weak persistence and weak shared-state assumptions

Use when:
- generic Grok chats
- generic web chat without project/workspace support

### `project`

Meaning:
- a persistent project/workspace container with scoped instructions, files, or memory

Use when:
- ChatGPT Projects
- Claude Projects

### `gem`

Meaning:
- a reusable instruction wrapper rather than a full shared project workspace

Use when:
- Gemini Gems

### `canvas`

Meaning:
- a persistent editable output surface for code/docs/apps

Use when:
- ChatGPT Canvas
- Gemini Canvas

### `artifact`

Meaning:
- a first-class shareable output/app surface

Use when:
- Claude Artifacts

## Repo Ingestion Modes

### `none`

Meaning:
- no verified repo-aware ingestion path exists for the current flow

Implications:
- Babel must not assume codebase visibility

### `file_upload`

Meaning:
- repo context exists only through manually uploaded files or ad hoc attachments

Implications:
- treat context as partial and stale by default

### `repo_snapshot`

Meaning:
- the platform imports a point-in-time repo snapshot
- later upstream changes are not automatically reflected

Implications:
- restate critical invariants explicitly
- warn about staleness before review or merge-oriented advice

Use when:
- Gemini GitHub import

### `repo_selective_sync`

Meaning:
- the platform can maintain a selected repo/file subset that can be manually refreshed

Implications:
- better than snapshot
- still not equivalent to the live local filesystem
- Babel should encourage explicit re-sync before high-stakes work

Use when:
- Claude GitHub integration

### `repo_live_query`

Meaning:
- the platform can query current repo state through a live connector or app surface

Implications:
- freshness is higher than snapshot/sync models
- Babel can trust read/query tasks more
- this does not automatically imply writeback capability

Use when:
- ChatGPT GitHub-connected read/query flows

### `full_repo_integration`

Meaning:
- a platform can inspect and modify the actual working repo directly

Implications:
- this is the closest to local coding-tool behavior
- web products rarely meet this standard

Use when:
- usually not web products
- local coding tools are the more likely target

## Repo Write Modes

### `no_repo_writeback`

Meaning:
- the platform can reason over repo content but cannot directly write changes upstream through that repo integration

Use when:
- ChatGPT GitHub app
- Gemini GitHub import
- Grok from current official evidence

### `limited_write_surfaces`

Meaning:
- the platform can create or modify code-like outputs, but not through a general repo writeback path

Use when:
- Claude Artifacts
- ChatGPT Canvas

### `repo_writeback`

Meaning:
- the platform can directly apply changes to the repo through a verified supported workflow

Use sparingly:
- only when the product docs clearly support it

## Output Surfaces

### `none`

Meaning:
- ordinary chat output only

### `canvas`

Meaning:
- editable document/code/app surface

### `artifact`

Meaning:
- persistent shareable app/output surface

### `project_share`

Meaning:
- the project/workspace itself can be shared or collaborated on

### `chat_share`

Meaning:
- shareable conversation links exist, but not a richer project/app surface

## Connector And Action Modes

### `connector-enabled`

Meaning:
- the platform can access external systems through connectors, apps, or integrations

Implications:
- Babel should distinguish local evidence from connector-provided evidence

### `agentic-tool-use`

Meaning:
- the platform can perform multi-step actions using tools, a browser, code execution, or similar surfaces

Implications:
- Babel should include halting rules and explicit approval boundaries

### `approval-checkpoint`

Meaning:
- the platform explicitly pauses for confirmation or human takeover during sensitive actions

Implications:
- Babel can separate planning from sensitive action more sharply

## Trust Axes

Use separate trust axes instead of one coarse score.

### `execution_trust`

Question:
- how much should Babel trust this platform to perform multi-step coding work coherently?

### `data_trust`

Question:
- how comfortable should Babel be with sensitive code or business context on this platform?

### `freshness_trust`

Question:
- how likely is the platform’s repo/context view to match current upstream state?

### `action_trust`

Question:
- how much should Babel trust this platform for connector actions or agentic side effects?

Recommended values:
- `high`
- `medium`
- `low`

## Suggested Current Platform Profiles

### ChatGPT

- `container_model`: `project`
- `ingestion_mode`: `repo_live_query`
- `repo_write_mode`: `no_repo_writeback`
- `output_surface`: `canvas`, `project_share`
- `platform_modes`:
  - `workspace-persistent`
  - `project-knowledge`
  - `connector-enabled`
  - `agentic-tool-use`
  - `approval-checkpoint`
- trust:
  - `execution_trust`: `high`
  - `data_trust`: `medium`
  - `freshness_trust`: `high`
  - `action_trust`: `high`

### Claude

- `container_model`: `project`
- `ingestion_mode`: `repo_selective_sync`
- `repo_write_mode`: `limited_write_surfaces`
- `output_surface`: `artifact`, `project_share`
- `platform_modes`:
  - `workspace-persistent`
  - `project-knowledge`
  - `connector-enabled`
  - `approval-checkpoint`
  - `artifact-share-surface`
- trust:
  - `execution_trust`: `high`
  - `data_trust`: `medium-to-high`
  - `freshness_trust`: `medium-to-high`
  - `action_trust`: `high`

### Gemini

- `container_model`: `gem`, `canvas`
- `ingestion_mode`: `repo_snapshot`
- `repo_write_mode`: `no_repo_writeback`
- `output_surface`: `canvas`
- `platform_modes`:
  - `repo-snapshot`
  - `connector-enabled`
  - `artifact-share-surface`
  - `privacy-caution`
- trust:
  - `execution_trust`: `medium`
  - `data_trust`: `medium`
  - `freshness_trust`: `low`
  - `action_trust`: `medium`

### Grok

- `container_model`: `chat`
- `ingestion_mode`: `file_upload`
- `repo_write_mode`: `no_repo_writeback`
- `output_surface`: `chat_share`
- `platform_modes`:
  - `privacy-caution`
- trust:
  - `execution_trust`: `low`
  - `data_trust`: `low`
  - `freshness_trust`: `low`
  - `action_trust`: `low`

## How Babel Should Use These Modes

### In Routing

The router should eventually record:
- `container_model`
- `ingestion_mode`
- `repo_write_mode`
- `output_surface`
- `platform_modes`
- `execution_trust`
- `data_trust`
- `freshness_trust`
- `action_trust`

### In Behavioral Guidance

- `repo_snapshot` should trigger stronger freshness warnings
- `repo_live_query` should improve confidence for read/analyze tasks only
- `no_repo_writeback` should prevent Babel from implying that upstream repo changes can be applied directly
- `low data_trust` should bias Babel away from sensitive uploads

### In Task Overlays

Task overlays should be able to say:
- if `ingestion_mode=repo_snapshot`, force explicit staleness reminders
- if `repo_write_mode=no_repo_writeback`, separate analysis from application
- if `output_surface=artifact` or `canvas`, structure outputs for reuse and sharing
- if `approval-checkpoint` is present, declare handoff boundaries before action

## Recommended Future Babel Changes

### Router Enhancements

Add optional fields such as:
- `container_model`
- `ingestion_mode`
- `repo_write_mode`
- `output_surface`
- `execution_trust`
- `data_trust`
- `freshness_trust`
- `action_trust`

### New Overlay Candidates

- `06_Task_Overlays/Repo-Ingestion-Mode-Guard-v1.0.md`
- `06_Task_Overlays/Connector-Safety-Overlay-v1.0.md`
- `06_Task_Overlays/Artifact-Ready-Output-v1.0.md`

### New Docs

- `docs/ROUTER_PLATFORM_FIELDS.md`
- `docs/WEB_PRODUCT_PRIVACY_NOTES.md`

## Anti-Patterns

Do not:
- treat all repo ingestion modes as equivalent
- confuse live repo querying with repo writeback
- assume web workspace memory equals local working-tree truth
- route sensitive coding flows to lower-trust consumer tools by default
- use one trust score when the risks are actually different
