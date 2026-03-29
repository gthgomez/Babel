# Private To Public Workflow

`Babel-private` is the source-of-truth. `Babel-public` is a derived export.

Do not mass-scrub the private repo to make it publishable. Export intentionally instead.

## Surface Classification Baseline

- Public-safe: onboarding docs, examples, release notes, behavioral OS, model adapters, and generic reusable domains/skills
- Dual-use with sanitization: orchestrators, `prompt_catalog.yaml`, some domain/skill docs, tests, fixtures, and tooling
- Private-only: private overlays, private task deltas, operator notes, local machine paths, live deployment details, and repo-specific operating heuristics
- Export tooling: release checklist, sanitization rules, and public scrub checks

## Workflow

1. Author and improve Babel in `Babel-private`
2. Classify the target surface with `docs/SURFACE_CLASSIFICATION_GATE.md`
3. Decide what is truly exportable
4. Copy only the exportable set into `Babel-public`
5. Replace private overlays with sanitized example overlays such as `Example-SaaS-Backend-Context.md` or `Example-Mobile-Suite-Context.md`
6. Rewrite public-only IDs, examples, catalog entries, and orchestrator examples so they are generic and safe
7. Run the public export checklist and public scrub tool inside `Babel-public`
8. Publish only after the public repo passes validation and manual review

## Maintenance Rules

- New product work lands in `Babel-private` first
- Generic improvements can flow both ways
- Sanitization-only edits belong in `Babel-public`
- Personalized overlays stay private unless deliberately converted into public example overlays
- Public onboarding, examples, and release notes live in the public repo and should stay focused on adoption
