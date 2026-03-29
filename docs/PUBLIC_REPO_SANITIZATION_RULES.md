# Public Repo Sanitization Rules

Apply these rules to `Babel-public` and public release artifacts only.

Do not use this document as a reason to mass-scrub `Babel-private`.

## Never Publish

- real app names or private project names unless they are intentionally public
- package IDs, bundle IDs, product IDs, subscription IDs, or SKUs
- local filesystem paths
- live deployment URLs, environment-specific endpoints, or service identifiers
- internal function names, endpoint paths, or monitoring module names tied to private systems
- operator notes, private heuristics, or personalized workflow details
- exact timeout tables, routing thresholds, or operational tuning that fingerprints private systems

## Public-Safe Replacements

- placeholders like `<YOUR_PROJECT_ROOT>`, `/project/root/`, `https://example.com/api`, `com.example.app`, or `example_pro_product`
- sanitized example overlays such as `Example-SaaS-Backend-Context.md`
- generic example project IDs instead of private repo names

## Public Export Expectation

- keep skills generic and reusable
- keep public onboarding short and beginner-friendly
- keep `v9` as the public default story
- keep `v8` in the background as compatibility-only

Before release, run `tools/validate-public-release.ps1` plus the deterministic preview checks in `docs/PUBLIC_EXPORT_CHECKLIST.md`.
