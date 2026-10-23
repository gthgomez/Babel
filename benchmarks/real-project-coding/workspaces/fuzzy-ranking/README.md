# Stable ranked candidates

Read PROMPT.md for the complete, frozen task contract.

This is an extracted, adapted real-project feature exercise. The existing
src/fuzzy.ts is byte-for-byte Babel source. The ranking API is a new benchmark
feature proposal; the throwing src/rankCandidates.ts starter was authored for
this exercise. It is not a historical Babel issue or an existing upstream bug.

## Run the public tests

Use Node.js 24.x (tested on 24.19.0) with native TypeScript support. No installation
or dependency download is needed:

    node --test tests/public.test.mjs

Other Node versions or patches need revalidation under the package toolchain
policy. This extracted fixture does not exercise the full Babel build or UI.

## Source attribution

Upstream: https://github.com/gthgomez/Babel
Path: babel-cli/src/utils/fuzzy.ts
Commit: 34dd34d9d5bca03550eae9c1e59a73942c932957
Git blob: 4f7c4ebb0d3836b3c16713b84354357c3dd2e669
License: Apache-2.0. The package-level license and source notices accompany
this benchmark.
