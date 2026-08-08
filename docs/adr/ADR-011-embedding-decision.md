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

## 4. Offline Behavior (Graceful No-Op)

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

**Failure-path test requirement**: The embedding provider test suite must assert FTS5 fallback when the API is down.

---

## 5. Cost Estimate

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

## 6. Dimension Lock

The vec0 virtual table is created with `FLOAT[384]` at first initialization (`vectorIndex.ts` line 55). This dimension is **baked into the SQLite schema**. Changing it requires:

1. Dropping the `vec_files` virtual table
2. Re-creating it with the new dimension
3. Re-indexing all embeddings from scratch

**The dimension must match the embedding model's output**. `text-embedding-3-small` outputs 384-dim vectors by default — this is a fixed property of the model and is unlikely to change. If a different model or dimension is needed in the future, the migration path is:
- Add a `dimension` parameter to `VectorIndex` constructor (already supported: `constructor(dbPath, dimension = 384)`)
- On dimension mismatch, drop and recreate the vec0 table
- Re-index

---

## 7. Implementation Plan (6–10h, post-decision)

### 7.1 New module: `src/services/embeddingProvider.ts` (2–3h)

```typescript
interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<Float32Array[]>;
}

function createEmbeddingProvider(): EmbeddingProvider | null;
```

- `OpenAiEmbeddingProvider` calls `POST https://api.openai.com/v1/embeddings` via `fetch`
- Reads config from env vars (see §3)
- Returns `null` when API key is unset or `BABEL_EMBEDDING_DISABLE=1`
- Retries HTTP 429/5xx with exponential backoff (3 attempts, 1s/2s/4s delays)

### 7.2 Wire `indexProject()` in `indexer.ts` (1–2h)

After the FTS indexing block at line 476:

```typescript
// After FTS indexing completes
const provider = createEmbeddingProvider();
if (provider && this.vectorIndex) {
  const embeddingFn = (text: string) =>
    provider.embedTexts([text]).then((vs) => vs[0]!);
  await this.vectorIndex.indexEmbeddings(embeddingFn, onProgress);
}
```

- Registers a `BackgroundTaskRegistry` task for embedding progress
- Skips entirely if no provider configured (existing FTS indexing is unaffected)

### 7.3 Wire `search()` in `indexer.ts` (1–2h)

Restructure `SemanticIndexer.search()` to attempt vector search first:

```typescript
public search(query: string, limit = 5): SearchHit[] {
  if (this.embedFn && this.vectorIndex) {
    try {
      const queryVec = await this.embedFn(query);
      const vectorHits = this.vectorIndex.search(queryVec, limit);
      if (vectorHits.length > 0) {
        return this.resolveVectorHits(vectorHits);
      }
    } catch {
      // Fall through to FTS
    }
  }
  // FTS5 fallback
  return this.ftsSearch(query, limit);
}
```

### 7.4 Wire `handleSemanticSearch` in `chronicleMemory.ts` (30 min)

At module init (or first call):

```typescript
const provider = createEmbeddingProvider();
if (provider) {
  globalIndexer.setEmbeddingFunction((text) =>
    provider.embedTexts([text]).then((vs) => vs[0]!),
  );
}
```

Remove the TODO comment at line 186.

### 7.5 Tests (2–3h)

| Test file | What it covers |
|-----------|---------------|
| `embeddingProvider.test.ts` (NEW) | `createEmbeddingProvider()` returns null when unconfigured; mocks `fetch` for success, rate-limit, server-error, malformed response; verifies retry behavior; verifies dimension (384) |
| `indexer.test.ts` (extend) | Vector results blended with FTS results; fallback when embedding function throws; null provider path |
| G8 closure | Explicit test: embedding API returns 500 → `search()` returns FTS5 results (does not throw) |

---

## 8. Validation Criteria

- [ ] Embedding function registered at startup when configured
- [ ] `SemanticIndexer.search()` blends vector results
- [ ] Graceful no-op when unconfigured (API key unset)
- [ ] Failure-path test: embedding API down → FTS5 fallback

---

## Appendix A: Files Referenced

| File | Relevance |
|------|-----------|
| `babel-cli/src/services/vectorIndex.ts` | vec0 table schema, `indexEmbeddings()`, `search()` signatures |
| `babel-cli/src/services/vectorIndex.test.ts` | Validates the full storage/query stack works with a test embedding function |
| `babel-cli/src/services/indexer.ts` | `SemanticIndexer` with `setEmbeddingFunction` hook + 2 TODOs (lines 482, 501) |
| `babel-cli/src/tools/chronicleMemory.ts` | `handleSemanticSearch` with TODO (line 186) |
| `babel-cli/src/config/` | API key configuration |
| `babel-cli/package.json` | `sqlite-vec: ^0.1.9` runtime dependency confirmed |
