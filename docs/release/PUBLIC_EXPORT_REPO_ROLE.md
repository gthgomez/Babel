# Public Repo Role and Guidelines

<!--
status: ACTIVE
last_verified: 2026-07-24
-->
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
