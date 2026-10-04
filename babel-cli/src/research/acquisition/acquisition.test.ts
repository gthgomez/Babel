import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeResearchProvider, sha256Hex, type FakeRepository } from '../fakeProvider.js';
import { buildRepositorySnapshot, excerptLines, selectSnapshotFiles } from './snapshot.js';
import { createEvidenceRef } from './evidence.js';
import { confirmExcerpt, validateEvidenceRefs } from './evidenceValidator.js';

const COMMIT = 'a'.repeat(40);

function repo(): FakeRepository {
  return {
    providerRepoId: '1001',
    fullName: 'acme/durable-runner',
    defaultBranch: 'main',
    commitSha: COMMIT,
    description: 'durable runner',
    language: 'TypeScript',
    topics: [],
    archived: false,
    stars: 10,
    forks: 1,
    pushedAt: '2026-09-01T00:00:00Z',
    licenseSpdxId: 'MIT',
    isFork: false,
    files: {
      'README.md': 'durable execution with journal replay after crash',
      'LICENSE': 'MIT License\n\nCopyright (c) 2026 acme',
      'package.json': '{"name":"durable-runner"}',
      'src/journal.ts': 'export class TaskJournal {\n  append(entry: string): void {}\n}\n',
      'src/unrelated.ts': 'export const nothing = 1;\n',
      'test/journal.test.ts': 'import { TaskJournal } from "../src/journal";\n',
      'docs/architecture.md': 'architecture: journal replay',
    },
  };
}

const SNAP_OPTS = {
  missionId: 'mission_snap',
  now: new Date('2026-10-03T00:00:00Z'),
  byteBudget: 1_000_000,
  maxFiles: 10,
  interestTerms: ['journal', 'replay', 'crash'],
};

async function snap() {
  const provider = new FakeResearchProvider({ repositories: [repo()] });
  const page = await provider.searchRepositories('durable');
  return buildRepositorySnapshot(provider, page.repositories[0]!.identity, SNAP_OPTS);
}

test('ranged evidence cannot certify arbitrary lines using a full-file hash', async () => {
  const snapshot = await snap();
  const full = createEvidenceRef(snapshot, { path: 'src/journal.ts' })!;
  const forged = { ...full, start_line: 2, end_line: 2 };
  assert.equal(validateEvidenceRefs(snapshot, [forged]).valid.length, 0);
  const subset = createEvidenceRef(snapshot, { path: 'src/journal.ts', startLine: 2, endLine: 2 })!;
  assert.equal(subset.content_hash, sha256Hex(excerptLines(snapshot.files.get('src/journal.ts')!, 2, 2)!));
  assert.equal(validateEvidenceRefs(snapshot, [subset]).valid.length, 1);
});

test('snapshot pins the exact commit and hashes every file', async () => {
  const snapshot = await snap();
  assert.equal(snapshot.manifest.commit_sha, COMMIT);
  assert.equal(snapshot.manifest.tree_truncated, false);
  assert.equal(snapshot.manifest.budget_exhausted, false);
  for (const file of snapshot.manifest.files) {
    assert.equal(file.content_hash, sha256Hex(snapshot.files.get(file.path)!));
  }
  const paths = snapshot.manifest.files.map((f) => f.path);
  assert.ok(paths.includes('src/journal.ts'), 'term-matched source must be selected');
  assert.ok(paths.includes('LICENSE'), 'license must be selected');
  assert.ok(paths.includes('test/journal.test.ts'), 'tests must be selected');
  assert.ok(!paths.includes('src/unrelated.ts'), 'irrelevant source must not be fetched');
});

test('file selection honors the maxFiles cap deterministically', () => {
  const paths = Array.from({ length: 30 }, (_, i) => ({ path: `src/journal${i}.ts`, size: 10 }));
  paths.push({ path: 'README.md', size: 10 }, { path: 'LICENSE', size: 10 });
  const selected = selectSnapshotFiles(paths, { ...SNAP_OPTS, maxFiles: 5 });
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.slice(0, 2).map((s) => s.reason), ['license', 'manifest']);
});

test('snapshot records explicit budget exhaustion', async () => {
  const provider = new FakeResearchProvider({ repositories: [repo()] });
  const page = await provider.searchRepositories('durable');
  const snapshot = await buildRepositorySnapshot(provider, page.repositories[0]!.identity, {
    ...SNAP_OPTS,
    byteBudget: 40,
  });
  assert.equal(snapshot.manifest.budget_exhausted, true);
  assert.ok(snapshot.manifest.total_bytes <= 40 + 200);
});

test('evidence refs validate against the snapshot; fabricated ones are rejected', async () => {
  const snapshot = await snap();
  const good = createEvidenceRef(snapshot, { path: 'src/journal.ts' });
  assert.ok(good);

  const excerpt = confirmExcerpt(snapshot, 'src/journal.ts', 1, 2)!;
  const lineRef = createEvidenceRef(snapshot, {
    path: 'src/journal.ts',
    startLine: 1,
    endLine: 2,
    contentHash: excerpt.contentHash,
  });
  assert.ok(lineRef);

  const fake = {
    ...good!,
    evidence_id: 'ev_fabricated',
    path: 'src/never-fetched.ts',
    content_hash: sha256Hex('attacker bytes'),
    start_line: 1,
    end_line: 999,
  };

  const result = validateEvidenceRefs(snapshot, [good!, lineRef!, fake]);
  assert.deepEqual(result.valid.map((r) => r.evidence_id), [good!.evidence_id, lineRef!.evidence_id]);
  assert.equal(result.invalid.length, 1);
  assert.ok(result.entries.find((e) => e.evidence_id === 'ev_fabricated')!.reasons.length > 0);
});

test('validator rejects wrong repo, wrong commit, and bad line ranges', async () => {
  const snapshot = await snap();
  const base = createEvidenceRef(snapshot, { path: 'src/journal.ts' })!;
  const wrongRepo = { ...base, repository_id: '9999' };
  const wrongCommit = { ...base, commit_sha: 'b'.repeat(40) };
  const badRange = { ...base, start_line: 1, end_line: 500 };
  assert.equal(createEvidenceRef(snapshot, { path: 'src/journal.ts', startLine: 1, endLine: 500 }), null);
  const result = validateEvidenceRefs(snapshot, [wrongRepo, wrongCommit, badRange]);
  assert.equal(result.valid.length, 0);
  const reasons = result.entries.flatMap((e) => e.reasons).join('; ');
  assert.match(reasons, /repository mismatch/);
  assert.match(reasons, /commit mismatch/);
  assert.match(reasons, /line range/);
});

test('excerptLines returns null for out-of-range ranges and never fabricates', () => {
  const content = 'one\ntwo\nthree';
  assert.equal(excerptLines(content, 1, 3), content);
  assert.equal(excerptLines(content, 2, 2), 'two');
  assert.equal(excerptLines(content, 1, 4), null);
  assert.equal(excerptLines(content, 0, 2), null);
});
