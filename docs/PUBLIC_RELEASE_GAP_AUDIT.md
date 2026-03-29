# Public Release Gap Audit

## Scope

This note captures the release-hardening audit for `Babel-public`.

## Gap Classification

| Gap | Finding | Classification | Resolution |
| --- | --- | --- | --- |
| Public runtime truth gap | Public docs were stronger than the public proof path. | Fix by rewriting docs and adding public proof. | Repositioned the repo as a runnable public-safe control-plane subset and made validation + manifest preview the canonical first success path. |
| Public wrapper mismatch | `tools/resolve-local-stack.ps1` and `tools/run-babel-local-cli.ps1` reflected private assumptions and stale project sets. | Fix by exporting sanitized implementation. | Replaced both wrappers with public-safe versions. `resolve-local-stack` now uses the real resolver preview script; `run-babel-local-cli` no longer depends on private lifecycle scripts. |
| v9 resolver credibility gap | Public docs described a catalog-driven typed lane, but the easiest public helper flow did not clearly prove it. | Fix by exporting sanitized implementation and proof artifacts. | Added `babel-cli/scripts/preview_manifest.ts`, golden preview JSON artifacts, regression tests, and wrapper smoke tests. |
| Android/mobile inconsistency | Public docs/catalog positioned Android as real, but helper tooling did not expose it cleanly. | Fix by exporting sanitized implementation and rewriting docs. | Added `mobile` / `example_mobile_suite` support to the public preview helper flow and added a mobile golden preview. |
| Onboarding/installability gap | New users lacked one clean "clone, install, validate, preview" path. | Fix by rewriting docs/commands. | Updated `README.md`, `START_HERE.md`, `BABEL_BIBLE.md`, `PROJECT_CONTEXT.md`, `docs/ARCHITECTURE.md`, and `docs/BABEL_LOCAL_MODE.md` around the public-safe validation + preview path. |
| Export-path drift | Public-safe hardening lived too much in the export output and not enough in the generator. | Fix by adjusting export tooling. | Added public templates, a stronger export test path, and updated export status/checklist docs so the next export regenerates the hardened release face. |

## Chosen Public Shape

`Babel-public` is now treated as a **runnable public-safe Babel control-plane subset**.

That claim is supported by:

- deterministic catalog validation
- deterministic resolver preview
- deterministic golden manifest preview artifacts
- read-only MCP inspection
- regression tests for resolver, preview, routing, and MCP behavior
