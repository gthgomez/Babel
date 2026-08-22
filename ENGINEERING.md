<!-- License: Apache-2.0 — see LICENSE -->


<!--
status: ACTIVE
last_verified: 2026-07-22
-->
# Engineering Standards — Babel

## Language & Platform
- TypeScript with strict mode, Node.js 22+, ESM modules
- No classes where functions suffice — prefer composition over inheritance
- Explicit return types on all public APIs
- Use `node:` protocol for built-in modules

## Code Style
- 2-space indent, no semicolons
- camelCase for variables and functions, PascalCase for types, classes, and interfaces
- Single quotes for strings, template literals for interpolation and multi-line
- JSDoc on all public exports — include param types, return types, and a brief description

## Testing
- Every new module ships with tests in a co-located `*.test.ts` file
- Test behavior, not implementation — assert outcomes, not internal calls
- Descriptive test names following the pattern: "does X when Y"
- Mock at module boundaries (network, filesystem, external APIs), not internals
- Prefer integration tests over unit tests for I/O paths
- Yield to the event loop in tests that iterate over large collections

## Error Handling
- Typed errors with descriptive messages — extend `Error` with a `code` property
- Never swallow errors silently: log and propagate, or handle explicitly
- Use Result types (`{ ok: true; value: T } | { ok: false; error: E }`) for expected failure paths
- Fail fast for programmer errors — use assertions and invariant checks

## Performance
- Yield to the event loop in unbounded I/O loops: batch size 10-50 for UI paths, 100-500 for data processing
- Lazy-load heavy dependencies — defer `import()` until the module is actually needed
- Cache parsed and compiled artifacts whenever the cost of recomputation exceeds the cost of storage

## Naming
- Files: `kebab-case.ts` for modules, `PascalCase.tsx` for components
- Directories: short, singular nouns (`service/`, `route/`, `component/`)
- No abbreviations except universally understood ones: `ctx`, `req`, `res`, `id`, `db`, `ref`, `args`
- Boolean prefixes: `is`, `has`, `should`, `can`
