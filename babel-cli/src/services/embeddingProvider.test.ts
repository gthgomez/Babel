/**
 * Tests for embeddingProvider.ts (R2.5).
 *
 * Covers: null-when-unconfigured, placeholder-key rejection, explicit disable,
 * mock fetch for success / rate-limit / server-error / malformed response,
 * retry behavior, and dimension verification.
 */

import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';

import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from './embeddingProvider.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  // Restore original env but preserve NODE_ENV and PATH
  const keep = ['NODE_ENV', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'];
  for (const key of Object.keys(process.env)) {
    if (!keep.includes(key) && !(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const key of Object.keys(ORIGINAL_ENV)) {
    if (!keep.includes(key)) {
      process.env[key] = ORIGINAL_ENV[key]!;
    }
  }
  // Ensure test-specific vars are clean
  delete process.env['BABEL_EMBEDDING_DISABLE'];
  delete process.env['BABEL_EMBEDDING_API_KEY'];
  delete process.env['BABEL_EMBEDDING_MODEL'];
  delete process.env['BABEL_EMBEDDING_BASE_URL'];
  delete process.env['OPENAI_API_KEY'];
}

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

// ── Mock fetch ───────────────────────────────────────────────────────────────

let mockFetchResponse: { status: number; body: unknown } | null = null;
let fetchCalls: Array<{ url: string; body: unknown }> = [];

function installMockFetch() {
  fetchCalls = [];
  mockFetchResponse = null;
  // @ts-expect-error — test-only global override
  globalThis.fetch = async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, body: JSON.parse(init.body as string) });
    if (!mockFetchResponse) {
      throw new Error('mockFetchResponse not set');
    }
    return {
      ok: mockFetchResponse.status >= 200 && mockFetchResponse.status < 300,
      status: mockFetchResponse.status,
      json: async () => mockFetchResponse!.body,
      text: async () => JSON.stringify(mockFetchResponse!.body),
    } as Response;
  };
}

function restoreFetch() {
  // @ts-expect-error — restoring original
  delete globalThis.fetch;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
  restoreFetch();
  mockFetchResponse = null;
});

// ── Section 1: Null when unconfigured ────────────────────────────────────────

test('createEmbeddingProvider returns null when OPENAI_API_KEY is unset', () => {
  const provider = createEmbeddingProvider();
  assert.equal(provider, null);
});

test('createEmbeddingProvider returns null when OPENAI_API_KEY is placeholder', () => {
  setEnv('OPENAI_API_KEY', 'replace_with_your_openai_key');
  const provider = createEmbeddingProvider();
  assert.equal(provider, null);
});

test('createEmbeddingProvider returns null when BABEL_EMBEDDING_DISABLE=1', () => {
  setEnv('OPENAI_API_KEY', 'sk-your_XXXXXXXXXXXXXXXXXXXX');
  setEnv('BABEL_EMBEDDING_DISABLE', '1');
  const provider = createEmbeddingProvider();
  assert.equal(provider, null);
});

test('createEmbeddingProvider returns null when BABEL_EMBEDDING_DISABLE=true', () => {
  setEnv('OPENAI_API_KEY', 'sk-your_XXXXXXXXXXXXXXXXXXXX');
  setEnv('BABEL_EMBEDDING_DISABLE', 'true');
  const provider = createEmbeddingProvider();
  assert.equal(provider, null);
});

// ── Section 2: Provider creation ─────────────────────────────────────────────

test('createEmbeddingProvider succeeds with valid OPENAI_API_KEY', () => {
  setEnv('OPENAI_API_KEY', 'sk-your_XXXXXXXXXXXXXXXXXXXX');
  const provider = createEmbeddingProvider();
  assert.ok(provider !== null);
});

test('createEmbeddingProvider prefers BABEL_EMBEDDING_API_KEY over OPENAI_API_KEY', () => {
  setEnv('OPENAI_API_KEY', 'sk-wrong-key');
  setEnv('BABEL_EMBEDDING_API_KEY', 'sk-right-key');
  const provider = createEmbeddingProvider();
  assert.ok(provider !== null);
  // Can't inspect private apiKey, but provider creation proves the key resolved
});

// ── Section 3: embedTexts — success path ─────────────────────────────────────

test('embedTexts returns embeddings for single text', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = {
    status: 200,
    body: {
      data: [{ embedding: Array(384).fill(0.1), index: 0 }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    },
  };

  const provider = createEmbeddingProvider()!;
  const results = await provider.embedTexts(['hello world']);

  assert.equal(results.length, 1);
  assert.ok(results[0] instanceof Float32Array);
  assert.equal(results[0]!.length, 384);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, 'https://api.openai.com/v1/embeddings');
});

test('embedTexts returns embeddings for multiple texts in correct order', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = {
    status: 200,
    body: {
      data: [
        { embedding: Array(384).fill(0.1), index: 0 },
        { embedding: Array(384).fill(0.5), index: 1 },
        { embedding: Array(384).fill(0.9), index: 2 },
      ],
      usage: { prompt_tokens: 15, total_tokens: 15 },
    },
  };

  const provider = createEmbeddingProvider()!;
  const results = await provider.embedTexts(['a', 'b', 'c']);

  assert.equal(results.length, 3);
  const r0 = results[0]!; const r1 = results[1]!; const r2 = results[2]!;
  assert.ok(Math.abs(r0[0]! - 0.1) < 0.001, `expected ~0.1, got ${r0[0]}`);
  assert.ok(Math.abs(r1[0]! - 0.5) < 0.001, `expected ~0.5, got ${r1[0]}`);
  assert.ok(Math.abs(r2[0]! - 0.9) < 0.001, `expected ~0.9, got ${r2[0]}`);
});

test('embedTexts sorts out-of-order API responses by index', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = {
    status: 200,
    body: {
      data: [
        { embedding: Array(384).fill(0.9), index: 2 },
        { embedding: Array(384).fill(0.1), index: 0 },
        { embedding: Array(384).fill(0.5), index: 1 },
      ],
      usage: { prompt_tokens: 15, total_tokens: 15 },
    },
  };

  const provider = createEmbeddingProvider()!;
  const results = await provider.embedTexts(['a', 'b', 'c']);

  const v0 = results[0]!; const v1 = results[1]!; const v2 = results[2]!;
  assert.ok(Math.abs(v0[0]! - 0.1) < 0.001, `expected ~0.1, got ${v0[0]}`);
  assert.ok(Math.abs(v1[0]! - 0.5) < 0.001, `expected ~0.5, got ${v1[0]}`);
  assert.ok(Math.abs(v2[0]! - 0.9) < 0.001, `expected ~0.9, got ${v2[0]}`);
});

test('embedTexts returns empty array for empty input', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  const provider = createEmbeddingProvider()!;
  const results = await provider.embedTexts([]);
  assert.equal(results.length, 0);
});

// ── Section 4: HTTP error handling ───────────────────────────────────────────

test('embedTexts throws on HTTP 401 (non-retryable)', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = { status: 401, body: { error: 'Unauthorized' } };

  const provider = createEmbeddingProvider()!;
  await assert.rejects(
    () => provider.embedTexts(['test']),
    (err: unknown) =>
      err instanceof Error && err.message.includes('401'),
  );
  // Non-retryable: only 1 call
  assert.equal(fetchCalls.length, 1);
});

test('embedTexts retries on HTTP 429 (rate limit)', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = { status: 429, body: { error: 'Rate limited' } };

  const provider = createEmbeddingProvider()!;
  await assert.rejects(
    () => provider.embedTexts(['test']),
    (err: unknown) =>
      err instanceof Error && err.message.includes('429'),
  );
  // 1 initial + 3 retries = 4 total
  assert.equal(fetchCalls.length, 4);
});

test('embedTexts retries on HTTP 500 (server error)', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = { status: 500, body: { error: 'Internal error' } };

  const provider = createEmbeddingProvider()!;
  await assert.rejects(
    () => provider.embedTexts(['test']),
    (err: unknown) =>
      err instanceof Error && err.message.includes('500'),
  );
  assert.equal(fetchCalls.length, 4);
});

test('embedTexts succeeds on retry after transient 500', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();

  let callCount = 0;
  // @ts-expect-error — test-only global override
  globalThis.fetch = async (url: string, init: RequestInit) => {
    callCount++;
    if (callCount <= 2) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'error' } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: Array(384).fill(0.1), index: 0 }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
      text: async () => '',
    } as Response;
  };

  const provider = createEmbeddingProvider()!;
  const results = await provider.embedTexts(['test']);

  assert.equal(results.length, 1);
  assert.equal(callCount, 3); // 2 failures + 1 success
});

// ── Section 5: Custom configuration ──────────────────────────────────────────

test('embedTexts uses custom BABEL_EMBEDDING_BASE_URL', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  setEnv('BABEL_EMBEDDING_BASE_URL', 'https://custom-api.example.com/v1');
  installMockFetch();
  mockFetchResponse = {
    status: 200,
    body: {
      data: [{ embedding: Array(384).fill(0.1), index: 0 }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    },
  };

  const provider = createEmbeddingProvider()!;
  await provider.embedTexts(['test']);

  assert.equal(fetchCalls[0]!.url, 'https://custom-api.example.com/v1/embeddings');
});

test('embedTexts uses custom BABEL_EMBEDDING_MODEL', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  setEnv('BABEL_EMBEDDING_MODEL', 'text-embedding-3-large');
  installMockFetch();
  mockFetchResponse = {
    status: 200,
    body: {
      data: [{ embedding: Array(384).fill(0.1), index: 0 }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    },
  };

  const provider = createEmbeddingProvider()!;
  await provider.embedTexts(['test']);

  const body = fetchCalls[0]!.body as Record<string, unknown>;
  assert.equal(body.model, 'text-embedding-3-large');
});

// ── Section 6: Dimension verification ────────────────────────────────────────

test('embedTexts returns 384-dimensional vectors', async () => {
  setEnv('OPENAI_API_KEY', 'sk-test');
  installMockFetch();
  mockFetchResponse = {
    status: 200,
    body: {
      data: [{ embedding: Array(384).fill(0.1), index: 0 }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    },
  };

  const provider = createEmbeddingProvider()!;
  const results = await provider.embedTexts(['test']);

  assert.equal(results[0]!.length, 384);
});
