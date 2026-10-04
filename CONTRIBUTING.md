<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Contributing

## Scope

Babel is a **local coding-agent harness** with an inspectable Prompt OS and
governed execution. Treat runtime, prompt, verification, documentation, and UX
changes as product changes — not as a notes folder.

High-value surfaces:

- TUI / Chat runtime
- Plan and Deep
- providers and tool execution
- authority / policy
- Prompt OS / catalog / routing
- verification, recovery, and evidence
- benchmarks / evals
- docs and integrations

This repository is Babel's canonical public source. Contributions merged here
change the authoritative product; no external repository regenerates this source.
Consumer-specific overlays and operational policy belong in the consumer
repository or another documented external configuration location.

## License

Contributions are submitted under the **Apache License 2.0**. See [LICENSE](./LICENSE).

Historical tagged releases that shipped under MIT remain MIT for those snapshots.
This tree is Apache-2.0 going forward.

## AI-assisted contributions

AI-assisted contributions are allowed.

An AI tool or model listed in commit metadata or a `Co-authored-by` trailer is
**not** treated by Babel documentation as a human copyright contributor merely
because of that attribution.

The person submitting a change is responsible for reviewing it and having the
rights necessary to submit it under Apache-2.0.

This is repository policy, not legal advice. Do not rewrite historical
`Co-authored-by` trailers.

## Working on Babel

[AGENTS.md](AGENTS.md) is the sole contributor operating-policy owner for human
and agent contributors: scope, engineering, prompt/runtime co-evolution,
verification, review, and delivery. Its operating map selects technical references
for the affected surface. This community and licensing page adds no competing
startup or verification checklist.

## Optional local hooks

`pwsh tools/install-hooks.ps1` sets this clone's `core.hooksPath` to `.githooks/`.
`git config --unset core.hooksPath` removes that local setting. The hooks give
fast feedback on staged secrets, private paths, and dependency fingerprints;
required checks remain governed by AGENTS.md and live CI. Hook implementation
and fixtures are in `.githooks/` and `tools/tests/test-public-prevention-gates.ps1`.
