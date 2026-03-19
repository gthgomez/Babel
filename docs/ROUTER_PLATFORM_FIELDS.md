# Router Platform Fields

## Purpose

This document defines the platform-aware router fields Babel should use when a task depends on a specific client or web product surface.

These fields exist to prevent ambiguous routing such as:
- treating repo snapshot import as live repo access
- treating read-only repo context as write-capable repo workflow
- treating all trust decisions as one coarse score

## Recommended Fields

### `container_model`

Allowed values:
- `chat`
- `project`
- `gem`
- `canvas`
- `artifact`

Use this to describe the primary context/output container the task will rely on.

### `ingestion_mode`

Allowed values:
- `none`
- `file_upload`
- `repo_snapshot`
- `repo_selective_sync`
- `repo_live_query`
- `full_repo_integration`

Use this to describe how codebase context is being loaded.

### `repo_write_mode`

Allowed values:
- `no_repo_writeback`
- `limited_write_surfaces`
- `repo_writeback`

Use this to distinguish repo analysis from repo mutation capability.

### `output_surface`

Allowed values:
- `none`
- `canvas`
- `artifact`
- `project_share`
- `chat_share`

Use this when the deliverable shape matters for routing or privacy.

### `platform_modes`

Allowed values include:
- `workspace-persistent`
- `project-knowledge`
- `repo-snapshot`
- `connector-enabled`
- `agentic-tool-use`
- `approval-checkpoint`
- `artifact-share-surface`
- `privacy-caution`

Use this as a flat list of descriptive platform constraints.

### `execution_trust`

Allowed values:
- `high`
- `medium`
- `low`

Question answered:
- how much should Babel trust the platform to perform multi-step coding work coherently?

### `data_trust`

Allowed values:
- `high`
- `medium`
- `low`

Question answered:
- how comfortable should Babel be with sensitive code or business context on this platform?

### `freshness_trust`

Allowed values:
- `high`
- `medium`
- `low`

Question answered:
- how likely is the platform’s repo/context view to match current upstream state?

### `action_trust`

Allowed values:
- `high`
- `medium`
- `low`

Question answered:
- how much should Babel trust this platform for connector actions or agentic side effects?

## Example Router Payload

```yaml
container_model: project
ingestion_mode: repo_selective_sync
repo_write_mode: limited_write_surfaces
output_surface:
  - artifact
  - project_share
platform_modes:
  - workspace-persistent
  - project-knowledge
  - connector-enabled
  - approval-checkpoint
execution_trust: high
data_trust: medium-to-high
freshness_trust: medium-to-high
action_trust: high
```

## Routing Rules

- If `ingestion_mode=repo_snapshot`, Babel should emit a freshness warning before giving merge-sensitive advice.
- If `repo_write_mode=no_repo_writeback`, Babel should not imply the platform can push changes upstream.
- If `data_trust=low`, Babel should default to sanitized uploads and narrower context sharing.
- If `action_trust=low`, Babel should bias toward planning, critique, and comparative review instead of autonomous execution.
- If `output_surface=artifact` or `canvas`, Babel can optimize for reusable, shareable outputs.

## Current Best Use

Use these fields in:
- future router schema updates
- platform-specific overlays
- web-product invocation guidance
- privacy and approval notes
