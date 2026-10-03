import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeResearchProvider, type FakeRepository } from '../fakeProvider.js';
import { createResearchMission } from '../missionPlanner.js';
import { runHuntDiscovery } from '../hunt.js';
import { runDeepAnalysis } from './deepAnalysis.js';


const COMMIT = 'a'.repeat(40);
const FIXED_NOW = new Date('2026-10-03T12:00:00.000Z');

function repo(): FakeRepository {
  return {
    providerRepoId: '1001',
    fullName: 'acme/durable-runner',
    defaultBranch: 'main',
    commitSha: COMMIT,
    description: 'Durable agent workflow runner with crash recovery and journal checkpoints',
    language: 'TypeScript',
    topics: ['durable-execution'],
    archived: false,
    stars: 120,
    forks: 9,
    pushedAt: '2026-09-01T00:00:00Z',
    licenseSpdxId: 'MIT',
    isFork: false,
    files: {
      'README.md': 'durable execution with journal replay after crash',
      'LICENSE': 'MIT License\n\nCopyright (c) 2026',
      'src/journal.ts': 'export class TaskJournal {\n  append(entry: string): void {}\n}\n',
    },
  };
}

function missionFor(root: string) {
  return createResearchMission({
    problem: 'How can we make long-running agent work crash-resilient?',
    projectRoot: root,
    budgetPreset: 'low',
    now: FIXED_NOW,
    missionId: 'mission_deep_test',
  });
}

test('deep analysis snapshots, validates evidence, and earns SOURCE_CONFIRMED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-deep-'));
  const mission = missionFor(root);
  const provider = new FakeResearchProvider({ repositories: [repo()] });
  const hunt = await runHuntDiscovery(mission, provider, { runsRoot: root, now: FIXED_NOW, skipDeepAnalysis: true });
  assert.ok(hunt.shortlist.length > 0);

  const result = await runDeepAnalysis(
    mission,
    provider,
    hunt.shortlist.map((s) => s.candidate),
    hunt.paths,
    { now: FIXED_NOW },
  );

  assert.equal(result.snapshots.length, 1);
  assert.ok(existsSync(hunt.paths.snapshotManifestsJsonl));
  assert.ok(existsSync(hunt.paths.evidenceJsonl));
  assert.ok(existsSync(hunt.paths.evidenceValidationJsonl));
  assert.ok(existsSync(hunt.paths.patternsJsonl));

  const patterns = result.patterns;
  assert.equal(patterns.length, 1);
  const card = patterns[0]!;
  assert.equal(card.evidence_state, 'SOURCE_CONFIRMED', 'all cited refs validated -> earned promotion');
  assert.equal(card.mission_id, 'mission_deep_test');
  assert.equal(card.applicability.target_head_sha, mission.target.head_sha);
  assert.deepEqual(card.license_observations, [
    { repository_id: '1001', spdx_id: 'MIT', status: 'known' },
  ]);

  // Cross-check: refs persisted in the run validate against the persisted snapshot.
  const manifest = JSON.parse(readFileSync(hunt.paths.snapshotManifestsJsonl, 'utf8').split('\n')[0]!);
  assert.equal(manifest.commit_sha, COMMIT);
  const validation = readFileSync(hunt.paths.evidenceValidationJsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { valid: boolean });
  assert.ok(validation.length > 0);
  assert.ok(validation.every((v) => v.valid));
});

test('no unsupported claim reaches SOURCE_CONFIRMED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-deep-'));
  const mission = missionFor(root);
  const provider = new FakeResearchProvider({ repositories: [repo()] });
  const hunt = await runHuntDiscovery(mission, provider, { runsRoot: root, now: FIXED_NOW, skipDeepAnalysis: true });

  // A hostile strategy cites only evidence it never obtained.
  const result = await runDeepAnalysis(mission, provider, hunt.shortlist.map((s) => s.candidate), hunt.paths, {
    now: FIXED_NOW,
    strategy: {
      name: 'hostile_v1',
      run: () =>
        ({
          schema_version: 1,
          problem_match: 'claims everything',
          observations: [
            {
              claim: 'this repo proves Babel must be rewritten',
              evidence_ref_ids: ['ev_fabricated'],
              kind: 'source_observed',
            },
            {
              claim: 'citation-free assertion',
              evidence_ref_ids: [],
              kind: 'source_observed',
            },
          ],
          patterns: [{ name: 'rewrite everything', mechanism: 'trust me', tradeoffs: [] }],
          missing_evidence: [],
        }) as never,
    },
  });

  const card = result.patterns[0]!;
  assert.equal(card.evidence_state, 'DISCOVERED', 'fabricated-only citations can never earn promotion');
  assert.deepEqual(card.evidence_refs, [], 'no valid evidence, no citations');
  assert.ok(result.rejectionCount >= 1);
  assert.ok(!existsSync(hunt.paths.evidenceJsonl), 'no validated evidence was persisted');
});

test('deep analysis respects the max_deep_reads budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-deep-'));
  const mission = createResearchMission({
    problem: 'crash resilience',
    projectRoot: root,
    budgetPreset: 'low',
    now: FIXED_NOW,
  });
  const provider = new FakeResearchProvider({ repositories: [repo(), repo()] });
  const hunt = await runHuntDiscovery(mission, provider, { runsRoot: root, now: FIXED_NOW, skipDeepAnalysis: true });
  const result = await runDeepAnalysis(mission, provider, hunt.shortlist.map((s) => s.candidate), hunt.paths, {
    now: FIXED_NOW,
  });
  assert.ok(result.snapshots.length <= mission.budget.max_deep_reads);
});
