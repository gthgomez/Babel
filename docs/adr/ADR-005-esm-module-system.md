# ADR-005: ESM Module System

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

## Context

Node.js supports two module systems: CommonJS (`require`/`module.exports`) and ECMAScript Modules (`import`/`export`). The choice affects: import syntax, dynamic import support, test runner compatibility, and tooling integration.

CommonJS is the legacy default and has broader ecosystem support. ESM is the standard and enables static analysis, tree-shaking, and top-level await.

## Decision

We use **ESM exclusively** (`"type": "module"` in `package.json`). All source files use `import`/`export` syntax. The `tsconfig.json` targets `NodeNext` module resolution.

Key implications:
- **Test runner:** Node.js built-in `node:test` with `tsx` loader (`tsx --test`)
- **Dynamic imports:** Used for optional provider SDKs (`@anthropic-ai/sdk`, `groq-sdk`) and lazy-loaded modules
- **No CommonJS interop:** The codebase has zero `require()` calls
- **File extensions:** All relative imports include `.js` extension (per Node.js ESM spec for TypeScript `NodeNext`)

## Alternatives Considered

**CommonJS:** More compatible but legacy. Lacks top-level await (needed for async config loading). Prevents static analysis.

**Hybrid (dual package):** Adds build complexity (separate CJS and ESM outputs). Not justified for a CLI tool that controls its Node.js runtime.

## Consequences

**Benefits:**
- Static analysis and tree-shaking support
- Top-level await enables cleaner async initialization
- Aligned with JavaScript ecosystem direction
- `tsx` provides seamless TypeScript + ESM execution

**Trade-offs:**
- Some npm packages still ship only CJS (handled by `tsx` interop)
- `.js` extension on relative imports is verbose and confusing for TypeScript developers
- `node:test` + `tsx` is less mature than Jest (but avoids Jest's CJS/ESM complexity)
- Provider SDKs must be dynamically imported if they don't support ESM

## Compliance

All new files must use ESM syntax. No `require()` calls. Relative imports must include `.js` extension. Dynamic imports must handle both ESM and CJS modules gracefully.
