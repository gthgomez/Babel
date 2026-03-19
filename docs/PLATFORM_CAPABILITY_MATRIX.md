# Platform Capability Matrix

Last updated: 2026-03-07

## Purpose

This document compares the web-product capability surfaces of:
- ChatGPT
- Claude
- Gemini
- Grok

The goal is operational.

Babel needs to know:
- what kind of container the platform provides
- how repo context is ingested
- whether repo context is fresh or stale by default
- whether the platform can write changes upstream
- what output surface exists
- what approvals and privacy risks apply

## Scope Note

This matrix incorporates:
- the official-source pass already captured in Babel
- the stronger parts of the attached follow-up research

When sources conflict, this document prefers:
1. official vendor docs
2. operationally conservative interpretation
3. explicit uncertainty instead of optimistic assumptions

## Summary Table

| Platform | Container Model | Repo Ingestion Mode | Repo Write Mode | Output Surface | Trust Axes Summary | Best Babel Fit |
|---|---|---|---|---|---|---|
| ChatGPT | Strong project/workspace container | `repo_live_query` plus file uploads | `no_repo_writeback` via GitHub app | `canvas`, `project_share` | execution `high`, data `medium-to-high`, freshness `high`, action `high` | project-aware planning, live repo analysis, approval-gated agent work |
| Claude | Strong project/workspace container | `repo_selective_sync` plus uploads | `limited_write_surfaces`; not standard repo push through basic project sync | `artifact`, `project_share` | execution `high`, data `high`, freshness `medium-to-high`, action `high` | project knowledge, selective repo sync, artifact-oriented coding workflows |
| Gemini | Medium container model via Gems/Canvas/chat | `repo_snapshot` plus uploads/Drive | `no_repo_writeback` for web GitHub import | `canvas`, limited sharing depending on account | execution `medium`, data `medium-to-high`, freshness `low`, action `medium` | codebase Q&A, research, snapshot analysis, privacy-aware workspace use |
| Grok | Weak-to-medium documented workspace model | `file_upload` or external content access; no strong official repo flow verified | `no_repo_writeback` | `chat_share`; Studio-like surfaces remain weaker in official evidence | execution `low`, data `low-to-medium`, freshness `low`, action `low` | realtime search and drafting, not primary autonomous coding |

## Router-Relevant Capability Matrix

| Dimension | ChatGPT | Claude | Gemini | Grok |
|---|---|---|---|---|
| `container_model` | `project` via Projects; chats/files/instructions/memory scoped to a project | `project` via Projects with project chat history and knowledge base | `gem` plus `canvas` and chat; not a first-class multi-chat project equivalent in the same sense | `chat` by default; business workspace concepts exist but coding-specific workspace evidence is weaker |
| `instruction_persistence` | Global custom instructions plus per-project instructions that override global | Per-project instructions plus project knowledge | Gems act as reusable instruction wrappers; persistence is weaker as a coding workspace model | No strong official equivalent verified in this pass |
| `ingestion_mode` | `repo_live_query` for GitHub-connected reading/search plus `file_upload` | `repo_selective_sync` for selected files/folders plus `file_upload` | `repo_snapshot` for GitHub import plus uploads/Drive | `file_upload` and external search/Drive-style business context; no strong official repo path verified |
| `repo_freshness_default` | Higher than snapshot tools, but still not equivalent to local live filesystem truth | Medium-high if users manually sync; stale if they do not | Low; imported repos are stale by default after import | Low |
| `repo_write_mode` | `no_repo_writeback` through the GitHub app itself | `limited_write_surfaces`; project sync is read/sync oriented, not a general writeback path | `no_repo_writeback` for GitHub import | `no_repo_writeback` verified in this pass |
| `connector_mode` | Strong. Apps, connected data sources, and MCP-style app ecosystem | Strong. Integrations plus remote MCP patterns | Medium. Connected Apps vary by account, app, and region | Weak-to-medium from official evidence reviewed |
| `agentic_tool_use` | Strong. Agent mode explicitly includes browser, files, code execution, and terminal | Medium-high. Strong connector/action model and coding surfaces, but not the same documented browser-agent shape as ChatGPT | Medium. Connected apps and research surfaces exist, but not a verified peer to ChatGPT agent for coding | Low from official evidence reviewed |
| `approval_checkpoint` | Strong. Explicit confirmations and takeover for sensitive steps | Strong enough to model. Connector actions and external actions are approval-sensitive | Medium. Permissions exist, but approval semantics are less explicit in the coding flow docs reviewed | Low-to-medium |
| `output_surface` | `canvas`, `project_share`, shareable chats | `artifact`, `project_share` | `canvas`, chat sharing, account-limited sharing behavior | `chat_share`; richer surfaces are not yet strong enough in the official evidence to treat as first-class coding artifacts |
| `privacy_training_posture` | Consumer caution required; Business/Enterprise stronger | Stronger commercial posture; consumer still distinct | Strong admin/workspace split; consumer caution required | Consumer caution required; business posture materially different |
| `best_operational_interpretation` | Strong read/analyze/agent platform with approval gates | Strong project-knowledge and selective-sync platform | Snapshot-analysis and connected-app platform | Lower-trust research/drafting platform |

## Trust Axes

Use these instead of a single trust score.

### `execution_trust`

How much Babel should trust the platform to carry out multi-step coding work safely and coherently.

Current defaults:
- ChatGPT: `high`
- Claude: `high`
- Gemini: `medium`
- Grok: `low`

### `data_trust`

How comfortable Babel should be with sensitive internal code or documents on that platform, assuming the user is not already on a hardened business tier.

Current defaults:
- ChatGPT: `medium`
- Claude: `medium-to-high`
- Gemini: `medium`
- Grok: `low`

### `freshness_trust`

How likely the repo/context view is to match current upstream state without explicit refresh.

Current defaults:
- ChatGPT: `high` for live-query reading, but still below local filesystem truth
- Claude: `medium-to-high` with manual sync discipline
- Gemini: `low`
- Grok: `low`

### `action_trust`

How comfortable Babel should be routing external actions, connector calls, or agentic steps through the platform.

Current defaults:
- ChatGPT: `high`
- Claude: `high`
- Gemini: `medium`
- Grok: `low`

## Platform Notes

### ChatGPT

What changed from the earlier Babel matrix:
- Repo ingestion should no longer be treated as just generic file/context handling.
- The stronger interpretation is `repo_live_query`, not `repo_snapshot`, for GitHub-connected reading and search.
- The GitHub path is still read-only for repo changes, so Babel must not confuse repo analysis with repo writeback.

What Babel should infer:
- good for live codebase analysis
- good for approval-routed agentic tasks
- not the same thing as a write-capable repo automation surface

### Claude

What still looks strongest:
- project knowledge
- selective repository sync
- artifact-oriented outputs
- stronger project-level coding workflows than most web products

What Babel should infer:
- Claude deserves a stronger `repo_selective_sync` concept than the older generic `repo-sync` label
- sync freshness is conditional on user refresh behavior
- Claude should remain one of Babel’s higher-trust web coding platforms

### Gemini

What the attached research clarified:
- GitHub import is useful, but it is still a snapshot model
- snapshot limits and staleness are the important design facts
- Gemini is valuable for analysis, not for assuming an autonomous coding writeback loop

What Babel should infer:
- treat Gemini as `repo_snapshot`
- attach stronger staleness warnings
- keep privacy/account-type distinctions explicit

### Grok

What the attached research clarified:
- Babel should be more conservative here
- Grok does not yet deserve to be modeled as a peer to ChatGPT/Claude for autonomous coding operations
- business/enterprise and consumer Grok must be treated separately if Babel ever supports it more deeply

What Babel should infer:
- downgrade coding trust
- default to research/synthesis use
- avoid routing sensitive or repo-critical coding flows here by default

## What Babel Should Add Based On This Matrix

### Recommended Router Fields

- `container_model`
- `ingestion_mode`
- `repo_write_mode`
- `output_surface`
- `execution_trust`
- `data_trust`
- `freshness_trust`
- `action_trust`
- `approval_mode`

### Recommended Future Docs

- [PLATFORM_MODE_GUIDELINES.md](./PLATFORM_MODE_GUIDELINES.md)
- `docs/ROUTER_PLATFORM_FIELDS.md`
- `docs/WEB_PRODUCT_PRIVACY_NOTES.md`

### Recommended Future Overlays

- `06_Task_Overlays/Repo-Ingestion-Mode-Guard-v1.0.md`
- `06_Task_Overlays/Connector-Safety-Overlay-v1.0.md`
- `06_Task_Overlays/Artifact-Ready-Output-v1.0.md`

## Caveats

- Product features move quickly.
- Plan and region restrictions materially change behavior.
- Web-product repo access is still not equivalent to local filesystem truth.
- Consumer and business tiers should not be treated as the same privacy surface.
