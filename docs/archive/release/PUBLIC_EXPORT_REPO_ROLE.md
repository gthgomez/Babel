# Public Repo Role and Guidelines

<!--
status: SUPERSEDED
last_verified: 2026-07-24
-->
> **Archived (2026-08-15).** Historical predecessor of the consolidated public-content
> policy. Its unique durable rule ("preserve the onboarding path, examples, and release
> notes") and the content restrictions were merged into
> [PUBLIC_REPO_CONTENT_POLICY.md](../../release/PUBLIC_REPO_CONTENT_POLICY.md).
>
> Superseded by:
> - [PUBLIC_REPO_CONTENT_POLICY.md](../../release/PUBLIC_REPO_CONTENT_POLICY.md)
> - [PUBLIC_RELEASE_CHECKLIST.md](../../release/PUBLIC_RELEASE_CHECKLIST.md)

This document describes the role and content guidelines for the public canonical repository at github.com/gthgomez/Babel.

The public repository is the independent canonical source for the Babel prompt operating system.

The public repo must:

- stay safe to publish and easy to understand
- keep `v9` as the visible default product story
- publish no active `v8` fallback claims; `v9` is the live runtime story
- preserve the onboarding path, examples, and release notes

The public repo must not contain:

- references to private or development-only repository names or internal workspace labels
- local filesystem paths
- package IDs, bundle IDs, product IDs, or SKUs
- live deployment URLs, service identifiers, or internal endpoint names
- operator-specific notes, environment-specific heuristics, or internal routing thresholds

This repository is the canonical public source. Content that is specific to individual development environments should be kept in local forks or separate configuration, not committed here.
