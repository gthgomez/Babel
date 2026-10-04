import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubApiError, GitHubResearchProvider } from './githubProvider.js';
import { RateBudget, RateBudgetExhaustedError } from '../rateBudget.js';
import type { RepositoryIdentity } from '../contracts.js';

const REPO: RepositoryIdentity = {
  provider_repo_id: '1001',
  provider: 'github',
  observed_full_name: 'acme/durable-runner',
  parent_provider_repo_id: null,
  default_branch: 'main',
  observed_at: '2026-10-03T00:00:00Z',
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function providerFor(responses: Array<(url: string) => Response>, options: { token?: string } = {}) {
  const seenUrls: string[] = [];
  const authHeaders: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    seenUrls.push(urlText);
    authHeaders.push(
      init?.headers && typeof init.headers === 'object' && 'authorization' in (init.headers as Record<string, string>)
        ? ((init.headers as Record<string, string>)['authorization'] ?? '')
        : '',
    );
    const responder = responses.shift() ?? responses[responses.length - 1]!;
    return responder(urlText);
  }) as typeof fetch;
  const provider = new GitHubResearchProvider({
    fetchImpl,
    ...(options.token ? { token: options.token } : {}),
    rateBudget: new RateBudget(1000, 100),
  });
  return { provider, seenUrls, authHeaders };
}

test('search maps search response into identity-bearing entries', async () => {
  const { provider } = providerFor([
    () =>
      jsonResponse(
        {
          total_count: 1,
          items: [
            {
              id: 1001,
              full_name: 'acme/durable-runner',
              default_branch: 'main',
              description: 'durable runner',
              language: 'TypeScript',
              topics: ['durable'],
              archived: false,
              stargazers_count: 42,
              forks_count: 3,
              pushed_at: '2026-09-01T00:00:00Z',
              license: { spdx_id: 'MIT' },
              fork: false,
            },
          ],
        },
        { 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '9999999999' },
      ),
  ]);
  const page = await provider.searchRepositories('durable runner');
  assert.equal(page.totalCount, 1);
  assert.equal(page.repositories[0]!.identity.provider_repo_id, '1001');
  assert.equal(page.repositories[0]!.license_spdx_id, 'MIT');
  assert.equal(provider.budget.snapshot().remainingPrimary, 4990);
  assert.ok(provider.budget.snapshot().bytesDownloaded > 0);
});

test('search routes through the search request budget', async () => {
  const provider = new GitHubResearchProvider({
    fetchImpl: (async () => jsonResponse({ total_count: 0, items: [] })) as typeof fetch,
    rateBudget: new RateBudget(100, 1),
  });
  await provider.searchRepositories('one');
  await assert.rejects(provider.searchRepositories('two'), RateBudgetExhaustedError);
});

test('resolveRevision and getTree use core endpoints and report truncation', async () => {
  const { provider, seenUrls } = providerFor([
    (url) => {
      assert.ok(url.includes('/repos/acme/durable-runner/commits/main'));
      return jsonResponse({ sha: 'c'.repeat(40) });
    },
    (url) => {
      assert.ok(url.includes('/git/trees/'), url);
      return jsonResponse({
        tree: [
          { path: 'src', type: 'tree', sha: 't1' },
          { path: 'src/journal.ts', type: 'blob', size: 12, sha: 'b1' },
        ],
        truncated: true,
      });
    },
  ]);
  const revision = await provider.resolveRevision(REPO);
  assert.equal(revision.commitSha, 'c'.repeat(40));
  const tree = await provider.getTree(revision);
  assert.equal(tree.truncated, true);
  assert.deepEqual(tree.entries.map((e) => e.path), ['src', 'src/journal.ts']);
  assert.ok(seenUrls.length === 2);
});

test('readTextFile decodes base64 contents and hashes content', async () => {
  const content = 'append-only journal';
  const { provider } = providerFor([
    () => jsonResponse({ encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64'), sha: 'blob1' }),
  ]);
  const revision = { identity: REPO, commitSha: 'c'.repeat(40), ref: 'main' };
  const file = await provider.readTextFile(revision, 'src/journal.ts');
  assert.equal(file.content, content);
  assert.equal(file.blobSha, 'blob1');
  assert.equal(file.contentHash.length, 64);
});

test('token is sent as authorization and redacted from errors', async () => {
  const secretToken = 'gh_super_secret_token_value';
  const { provider, authHeaders } = providerFor(
    [() => new Response('{"message":"nope"}', { status: 403, headers: { 'content-type': 'application/json' } })],
    { token: secretToken },
  );
  await assert.rejects(provider.searchRepositories('x'), (error: unknown) => {
    assert.ok(error instanceof GitHubApiError);
    assert.ok(!error.message.includes(secretToken), 'token leaked into error');
    return true;
  });
  assert.equal(authHeaders[0], `Bearer ${secretToken}`);
});

test('unauthenticated requests send no authorization header', async () => {
  const { provider, authHeaders } = providerFor([() => jsonResponse({ total_count: 0, items: [] })]);
  await provider.searchRepositories('x');
  assert.equal(authHeaders[0], '');
});

test('mission byte budget counts actual UTF8 body bytes across requests, ignoring Content-Length', async () => {
  const body = JSON.stringify({ total_count: 0, items: [], text: 'é' });
  const bytes = Buffer.byteLength(body, 'utf8');
  let requests = 0;
  const budget = new RateBudget(100, 30, bytes * 2);
  const provider = new GitHubResearchProvider({ rateBudget: budget, fetchImpl: (async () => {
    requests += 1;
    return new Response(body, { headers: { 'content-length': '1' } });
  }) as typeof fetch });
  await provider.searchRepositories('one');
  assert.equal(budget.bytes, bytes);
  await provider.searchRepositories('two');
  await assert.rejects(provider.searchRepositories('three'), RateBudgetExhaustedError);
  assert.equal(requests, 2);
  assert.equal(budget.snapshot().state, 'EXHAUSTED');
});

test('oversized streaming body is cancelled at the mission byte cap', async () => {
  const chunks = ['{"tot', 'al_count":0,"items":[]}'];
  let cancelled = false;
  const budget = new RateBudget(100, 30, 8);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(Buffer.from(chunk)); },
    cancel() { cancelled = true; },
  });
  const response = new Response(stream, { headers: { 'content-length': '1' } });
  // Reading the whole body before applying a cap is not a valid boundary.
  Object.defineProperty(response, 'text', { value: async () => { throw new Error('unbounded response.text called'); } });
  const provider = new GitHubResearchProvider({ rateBudget: budget, fetchImpl: (async () => response) as typeof fetch });
  await assert.rejects(provider.searchRepositories('large'), RateBudgetExhaustedError);
  assert.equal(cancelled, true);
  assert.ok(budget.bytes > 8, 'receipt includes the actual overflow chunk already received');
  assert.equal(budget.snapshot().state, 'EXHAUSTED');
});

test('error response bytes consume the same budget before a retry can start', async () => {
  const body = JSON.stringify({ message: 'temporary' });
  const budget = new RateBudget(100, 30, Buffer.byteLength(body));
  let requests = 0;
  const provider = new GitHubResearchProvider({ rateBudget: budget, fetchImpl: (async () => {
    requests += 1;
    return new Response(body, { status: 500 });
  }) as typeof fetch });
  await assert.rejects(provider.searchRepositories('retry'), RateBudgetExhaustedError);
  assert.equal(requests, 1);
});
