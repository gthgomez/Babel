# Research V2 — Agent B ownership manifest

Campaign: Babel Research V2 (2026-10-20). Baseline: `d9e42b14b00b6dba25f0415ae16b084363386a01`.

## Exclusive writer (Agent B)

| Path | Responsibility |
|------|----------------|
| `babel-cli/src/research/v2/profiles/general/**` | General profile definition, rubric, report section rules, evaluation expectations |
| `babel-cli/src/research/v2/adapters/web/**` | Web discovery + HTML read adapters (via shared `SourceAccessPort`) |
| `babel-cli/src/research/v2/adapters/documents/**` | Plain-text + PDF document adapters (via shared `SourceAccessPort`) |
| Colocated tests and fixtures under the above | Deterministic general corpus, adapter boundary tests |

## Read-only consumption (Agent A)

Agent B **does not** edit:

- `babel-cli/src/research/v2/contracts/**`, `engine/**`, `persistence/**`, `evidence/**`, `model/**`, `ports/**`, `registry/**`
- Technical profile and GitHub/paper adapters
- CLI registration, package manifests, lockfiles, shared prompt/catalog glue

Cross-boundary needs are interface change requests to Agent A with a failing contract test proposal.

## M0 checkpoint (this branch)

- General development fixture corpus (`fixtures/dev-corpus/`)
- Adapter design documents (`../adapters/web/`, `../adapters/documents/`)
- Contract review checklist (pending Agent A checkpoint relay)
- No engine, no duplicate port definitions, no package.json changes
