# Source and fixture notice

This workspace contains public Babel source from
[gthgomez/Babel, commit 34dd34d9d5bca03550eae9c1e59a73942c932957](https://github.com/gthgomez/Babel/tree/34dd34d9d5bca03550eae9c1e59a73942c932957),
under Apache License 2.0. See `SOURCE.json` for per-file immutable links and
upstream Git blob identifiers. The package includes the upstream license.

**Modification notice:** `remoteUiAssets.ts` has an added first-line benchmark
notice and its local policy import changes from `.js` to `.ts` to execute
under Node 24 native type stripping. No function body was changed. The policy
and service-worker sources are unmodified.

The HTML and app JavaScript are new synthetic fixture payloads. The prompt,
tests and package metadata are newly authored benchmark material, not historical
Babel test results. Missing production shell assets are intentional. The task
does not reproduce or test the active Remote UI application.
