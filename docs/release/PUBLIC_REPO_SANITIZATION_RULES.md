# Public Repo Content Policy

<!--
status: ACTIVE
last_verified: 2026-07-24
-->
These rules govern what content may be contributed to or maintained in this public canonical repository.

## Never Publish

- real app names or project names unless they are intentionally public
- package IDs, bundle IDs, product IDs, subscription IDs, or SKUs
- local filesystem paths
- live deployment URLs, environment-specific endpoints, or service identifiers
- internal function names, endpoint paths, or monitoring module names tied to specific deployments
- operator notes, environment-specific heuristics, or personalized workflow details
- exact timeout tables, routing thresholds, or operational tuning that fingerprints specific systems

## Preferred Placeholders

- `<YOUR_PROJECT_ROOT>`, `/project/root/`, `https://example.com/api`, `com.example.app`, or `example_pro_product`
- sanitized example overlays such as `Example-SaaS-Backend-Context.md`
- generic example project IDs instead of specific names

## Public Repo Standards

- keep skills generic and reusable
- keep public onboarding short and beginner-friendly
- keep `v9` as the public default story
- remove `v8` compatibility-language from public-facing runtime claims; `v9` is the live story
