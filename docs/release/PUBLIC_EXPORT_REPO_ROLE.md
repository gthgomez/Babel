# Public Repo Role and Guidelines

<!--
status: ACTIVE
last_verified: 2026-08-22
-->
This document describes the role and content guidelines for the public canonical repository at github.com/gthgomez/Babel.

The public repository is the independent canonical source of Babel — a local terminal coding agent and coding-agent harness, built on an inspectable prompt operating system as its underlying instruction architecture.

The public repo must:

- stay safe to publish and easy to understand
- keep Chat/Plan/Deep as the visible default product story: Chat is the default daily experience, Plan is review-first, Deep is governed execution; the Prompt OS is the underlying architecture, not the product category
- publish no active `v8` fallback claims; `v9` remains the live runtime orchestrator
- preserve the onboarding path, examples, and release notes

The public repo must not contain:

- references to private or development-only repository names or internal workspace labels
- local filesystem paths
- package IDs, bundle IDs, product IDs, or SKUs
- live deployment URLs, service identifiers, or internal endpoint names
- operator-specific notes, environment-specific heuristics, or internal routing thresholds

This repository is the canonical public source. Content that is specific to individual development environments should be kept in local forks or separate configuration, not committed here.
