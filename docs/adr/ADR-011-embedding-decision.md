# R2.5 — Embedding Provider Decision

<!--
status: ACTIVE
last_verified: 2026-08-08
-->
> **Date**: 2026-07-03
> **Source**: OSS-2 / R2.5 from the architectural audit
> **Status**: Implemented — OpenAI embeddings are optional and FTS5 remains the fallback

---

## 1. Current State

The entire vector storage and query infrastructure is **complete and tested**:

| Component | Status |
|-----------|--------|
| `sqlite-vec` dependency (`^0.1.9`) | Installed |
| `VectorIndex` class (vec0 table, KNN search, `indexEmbeddings`, `search`) | Implemented + tested |
| `VectorIndex.initialize()` auto-creates vec0 virtual table at dimension 384 | Working |
| `has_embedding` column auto-added to `fts_files` | Working |
| `SemanticIndexer.setEmbeddingFunction()` hook | Defined, exposed on `globalIndexer` |
| `SemanticIndexer.vectorIndex` lazy getter | Returns `VectorIndex` or null if extension fails |

`embeddingProvider.ts` now provides the OpenAI text-to-vector adapter. The indexer
generates embeddings after FTS indexing, `searchWithEmbedding()` falls back to FTS5,
and `semantic_search` lazily registers the provider. The remaining boundary is
operational: embeddings are disabled when no API key is configured and never make
semantic search unavailable.

---

## 2. Decision: OpenAI `text-embedding-3-small`

### Rationale

| Factor | Assessment |
|--------|-----------|
| **Dimension match** | `text-embedding-3-small` outputs 384-dim vectors by default — exact match with the existing vec0 table schema (`FLOAT[384]`) |
| **API key exists** | An API key can be configured (listed as "Optional provider key for future/provider-specific surfaces") |
| **Cost** | $0.02/1M tokens. Indexing a large project (~500 files × ~100K tokens/file = 50M tokens) costs **~$1.00**. Incremental re-indexing costs near zero. |
| **No new dependencies** | Can call the REST API directly via `fetch` (already used extensively in the codebase). No SDK needed. |
| **Latency** | ~100ms per call; batch API supports up to 2048 inputs per call |
| **Maturity** | OpenAI embeddings are the industry default; behavior is well-understood and deterministic |

### Why not local/offline embedding?

| Factor | Local (Transformers.js / ONNX) | API (OpenAI) |
|--------|-------------------------------|-------------|
| Dependency size | 20–50MB (onnxruntime-node + model weights) | 0MB |
| Inference latency | 500ms–2s per text on CPU | ~100ms per batch |
| First-run cost | Model download on `npm install` or first use | None |
| Offline support | Yes | No (requires network) |
| Consistency with existing architecture | No — Babel is API-first for AI | Yes — Babel already requires API keys for LLM providers |

**The existing FTS5 fallback already handles the "no API" case.** When the API key is unset or the API is unreachable, `SemanticIndexer.search()` already delegates to FTS5 full-text search. The embedding path is additive — it improves results when available, degrades gracefully when not.

---

## 3. Configuration Design

```
BABEL_EMBEDDING_API_KEY=                      # optional explicit key override
BABEL_EMBEDDING_MODEL=text-embedding-3-small  # default model
BABEL_EMBEDDING_BASE_URL=                     # default: https://api.openai.com/v1
BABEL_EMBEDDING_DISABLE=0                     # set to 1 (or true) to skip embeddings
```

When no explicit override is supplied, the provider uses the standard OpenAI key
environment setting. The implementation fixes vectors at 384 dimensions to match the
current vec0 table; provider selection and batch-size configuration are not public
settings yet.

---

## 4. External Content Boundary

When an embedding provider is configured, Babel sends the text content of each
not-yet-embedded indexed file and each `semantic_search` query to the configured
embedding endpoint. The default endpoint is OpenAI; `BABEL_EMBEDDING_BASE_URL` may
select another compatible provider. Treat this as external content egress: do not
enable embeddings for repositories whose policy forbids sending their content to an
external service.

Embeddings remain disabled until a valid embedding or OpenAI API key is configured.
Set `BABEL_EMBEDDING_DISABLE=1` (or `true`) to disable the path explicitly; FTS5
continues to provide local search without external embedding requests.

---

## 5. Offline Behavior (Graceful No-Op)

The embedding path is **strictly additive** — it never blocks or degrades existing functionality:

| Scenario | Behavior |
|----------|----------|
| API key unset | `createEmbeddingProvider()` returns `null` → `setEmbeddingFunction` never called → `search()` uses FTS5 only |
| `BABEL_EMBEDDING_DISABLE=1` | Same as above — explicit disable |
| API returns HTTP 429 (rate limit) | Retry with exponential backoff (3 attempts); give up and log warning |
| API returns HTTP 5xx (server error) | Retry with exponential backoff (3 attempts); give up and log warning |
| Network timeout | Fail the individual batch; continue with next batch |
| `sqlite-vec` extension fails to load | `vectorIndex` getter returns `null` → embedding path skipped |
| Embedding succeeds but vector search returns no hits | Fall back to FTS5 results (already the search contract) |

---

## 6. Cost Estimate

**One-time indexing cost** (per project):

| Project size | Files | Tokens | Cost |
|-------------|-------|--------|------|
| Small (<100 files) | 100 | ~5M | $0.10 |
| Medium (~500 files) | 500 | ~50M | $1.00 |
| Large (~2000 files) | 2000 | ~200M | $4.00 |

**Per-query cost**: Negligible — one embedding call per `semantic_search` invocation (~10–100 tokens = $0.0000002–$0.000002).

**Incremental re-indexing**: Near zero — only newly added/changed files are re-embedded (`has_embedding = 0` increment).

**Monthly cost**: If a user runs indexing once and makes ~1000 semantic searches/month: ~$1.02/month.

---

## 7. Dimension Lock

The vec0 virtual table is created with `FLOAT[384]` at first initialization (`vectorIndex.ts` line 55). This dimension is **baked into the SQLite schema**. Changing it requires:

1. Dropping the `vec_files` virtual table
2. Re-creating it with the new dimension
3. Re-indexing all embeddings from scratch

**The dimension must match the embedding model's output**. `text-embedding-3-small` outputs 384-dim vectors by default — this is a fixed property of the model and is unlikely to change. If a different model or dimension is needed in the future, the migration path is:
- Add a `dimension` parameter to `VectorIndex` constructor (already supported: `constructor(dbPath, dimension = 384)`)
- On dimension mismatch, drop and recreate the vec0 table
- Re-index

---

## 8. Implementation Evidence

| Artifact | Implemented behavior |
|----------|----------------------|
| `babel-cli/src/services/embeddingProvider.ts` | Configured OpenAI-compatible provider, explicit disable path, response-shape/dimension validation, and retry handling |
| `babel-cli/src/services/vectorIndex.ts` | Incremental vector creation from stored FTS file content |
| `babel-cli/src/services/indexer.ts` | Vector ranking with FTS5 fallback when vectors are unavailable or fail |
| `babel-cli/src/tools/chronicleMemory.ts` | Lazy provider registration for `semantic_search` |
| `babel-cli/src/services/embeddingProvider.test.ts` | Configuration, disable, provider response, retry, and dimension coverage |

---

## Appendix A: Files Referenced

| File | Relevance |
|------|-----------|
| `babel-cli/src/services/vectorIndex.ts` | vec0 table schema, `indexEmbeddings()`, `search()` signatures |
| `babel-cli/src/services/vectorIndex.test.ts` | Validates the full storage/query stack works with a test embedding function |
| `babel-cli/src/services/indexer.ts` | `SemanticIndexer` embedding registration, indexing, vector search, and FTS5 fallback |
| `babel-cli/src/tools/chronicleMemory.ts` | Lazy provider registration for `handleSemanticSearch` |
| `babel-cli/src/config/` | API key configuration |
| `babel-cli/package.json` | `sqlite-vec: ^0.1.9` runtime dependency confirmed |
