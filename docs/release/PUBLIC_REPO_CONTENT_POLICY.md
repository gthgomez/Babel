# Public Repo Content Policy

<!--
status: ACTIVE
last_verified: 2026-08-15
-->
These rules govern what content may be contributed to or maintained in this public canonical
repository. This document is the **normative public-content policy**; the
[release checklist](./PUBLIC_RELEASE_CHECKLIST.md) derives its operational steps from it.

## Never Publish

- credentials, secrets, API keys, tokens, or private configuration values
- real app names or project names unless they are intentionally public
- private or development-only repository identifiers unless intentionally public
- package IDs, bundle IDs, product IDs, subscription IDs, or SKUs unless intentionally public
- local filesystem paths: Windows user/workspace roots, Unix home directories, or any
  machine-specific path (the scrub checks enforce this mechanically)
- live deployment URLs, environment-specific endpoints, service fingerprints, or internal
  endpoint paths
- internal function names, monitoring module names, or operational details tied to specific
  deployments
- operator notes, environment-specific heuristics, or personalized workflow details
- raw local telemetry or unredacted run evidence
- exact timeout tables, routing thresholds, or operational tuning that fingerprints specific
  systems

## Preferred Placeholders

- `<REPO_ROOT>`, `<PROJECT_ROOT>`, `<WORKSPACE_ROOT>` for repository/workspace paths
- `https://example.com/...`, `com.example.app`, or `example_pro_product` for external
  identifiers
- sanitized example overlays such as `Example-SaaS-Backend-Context.md`
- generic example project IDs instead of specific names

## Public Repo Standards

- keep skills generic and reusable
- keep public onboarding short and beginner-friendly
- teach the **current** CLI surfaces (`babel "<task>"`, `babel plan`, `babel deep`,
  `babel chat-headless`, `babel undo`, `babel resume`, `babel doctor`) — never teach removed
  surfaces (`bl`, `babel-lite`, `lite`, `l`, `full`, `daily`, or Lite-era verbs) as active
  commands except in explicit historical context
- preserve the onboarding path, examples, and release notes
- describe runtime claims against the current architecture (Chat / Plan / Deep + runtime
  harness); do not present old product identities (Lite/Full/Local Mode) or orchestrator
  versions (v8/v9/v10) as current product story
- do not duplicate current provider/model rosters into prose — `config/model-policy.json`
  is the single mutable source of truth

## Enforcement

The public-content checks (`tools/check-public-content-policy.ps1`,
`tools/check-public-scrub.ps1`) and the release gates in
[PUBLIC_RELEASE_CHECKLIST.md](./PUBLIC_RELEASE_CHECKLIST.md) enforce these rules before
publication.
