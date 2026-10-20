# Research V2 ownership manifest

Contract checkpoint `2026.10.20-checkpoint.1`. Single writer per path; cross-boundary changes are interface requests.

## Agent A (shared foundation and technical)

| Path | Role |
|------|------|
| `babel-cli/src/research/v2/contracts/` | Versioned Zod schemas and TypeScript types |
| `babel-cli/src/research/v2/ports/` | Shared port interfaces (no production adapters here except fakes) |
| `babel-cli/src/research/v2/fixtures/` | Shared fake ports, example missions, technical fixture data (checkpoint) |
| `babel-cli/src/research/v2/engine/` | Shared engine (M1+, not in checkpoint) |
| `babel-cli/src/research/v2/persistence/` | Durable store implementation (M1+) |
| `babel-cli/src/research/v2/evidence/` | Citation integrity helpers (M1+) |
| `babel-cli/src/research/v2/model/` | ResearchModelPort → ProviderEngine bridge (M1+) |
| `babel-cli/src/research/v2/registry/` | Source adapter registry (M1+) |
| `babel-cli/src/research/v2/profiles/technical/` | Technical profile definition and GitHub/paper adapters (post-contract) |
| CLI registration, `package.json` / lockfile | Agent A only |

## Agent B (general research and web/document)

| Path | Role |
|------|------|
| `babel-cli/src/research/v2/profiles/general/` | General profile definition |
| `babel-cli/src/research/v2/adapters/web/` | Web search/fetch adapters |
| `babel-cli/src/research/v2/adapters/documents/` | Document/PDF extraction adapters |
| General-owned fixtures and colocated tests under those trees | Agent B |

## Read-only for both

- `babel-cli/src/research/contracts.ts` and V1 hunt/inspect paths (preserve behavior)
- `babel-cli/src/runners/openRouterApi.ts`, `providerEngine.ts` (reuse in M1, do not fork)

## Integration authority

Coordinator-owned integration branch; neither A nor B merges to `main` within this campaign without explicit authorization.
