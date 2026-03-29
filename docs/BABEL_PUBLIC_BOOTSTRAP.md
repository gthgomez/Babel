# Babel Public Bootstrap

This document bootstraps `Babel-public` from `Babel-private`.

Use it when you want a real public export tree without stripping the private source repo.

## Default Destination

The default export target is the sibling folder:

`../Babel-public`

## Command

From the `Babel-private` repo root:

```powershell
pwsh -File tools\export-babel-public.ps1
```

## What The Export Does

- copies a curated public-safe subset of the private repo
- writes a public `REPO_ROLE.md`
- replaces private project overlays with example overlays
- replaces the private project-specific task delta with an example delta
- rewrites known private identifiers only inside the exported tree
- runs the public scrub check and catalog validator inside `Babel-public`

## Public Mapping

- `example_saas_backend` -> `example_saas_backend`
- `example_llm_router` -> `example_llm_router`
- `example_web_audit` -> `example_web_audit`
- `example_mobile_suite` -> `example_mobile_suite`
- private overlays -> `Example-*.md` overlays
- private example_saas_backend task delta -> `Example-SaaS-Backend-Frontend-Professionalism-v1.0.md`

## After Export

1. Review `README.md`, `START_HERE.md`, `BABEL_BIBLE.md`, examples, and release notes in `Babel-public`
2. Run `pwsh -File tools\validate-public-release.ps1`
3. Run `pwsh -File tools\resolve-local-stack.ps1 -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode verified -Format json`
4. Compare the output to `examples/manifest-previews/backend-verified.json`
5. Apply any final public-only hardening inside `Babel-public`, not `Babel-private`

