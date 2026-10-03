import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BUDGET_PRESET_VALUES,
  EvidenceRefV1Schema,
  PatternCardV1Schema,
  ResearchMissionV1Schema,
  parseResearchArtifact,
  type PatternCardV1,
} from './contracts.js';
import { FakeResearchProvider, fakeBlobSha, sha256Hex } from './fakeProvider.js';
import { createResearchMission, resolveBudget } from './missionPlanner.js';
import {
  appendJsonl,
  initializeResearchRun,
  missionRunDirName,
  readJsonl,
  researchRunPaths,
} from './artifacts.js';

const FIXED_NOW = new Date('2026-10-03T12:00:00.000Z');

function makeMission(projectRoot: string) {
  return createResearchMission({
    problem: 'How can we make long-running agent work crash-resilient?',
    projectRoot,
    budgetPreset: 'normal',
    now: FIXED_NOW,
    missionId: 'mission_test_0001',
  });
}

function fixtureCorpus() {
  return [
    {
      providerRepoId: '1001',
      fullName: 'acme/durable-runner',
      defaultBranch: 'main',
      commitSha: 'a'.repeat(40),
      description: 'Durable agent workflow runner with crash recovery',
      language: 'TypeScript',
      topics: ['durable-execution', 'agents'],
      archived: false,
      stars: 120,
      forks: 9,
      pushedAt: '2026-09-01T00:00:00Z',
      licenseSpdxId: 'MIT',
      isFork: false,
      files: {
        'README.md': 'durable execution with journal replay after crash',
        'src/journal.ts': 'append-only journal of task transitions',
      },
    },
    {
      providerRepoId: '1002',
      fullName: 'mirror/durable-runner',
      parentProviderRepoId: '1001',
      defaultBranch: 'main',
      commitSha: 'b'.repeat(40),
      description: 'fork of acme/durable-runner',
      language: 'TypeScript',
      topics: [],
      archived: false,
      stars: 1,
      forks: 0,
      pushedAt: '2026-08-01T00:00:00Z',
      licenseSpdxId: 'MIT',
      isFork: true,
      files: { 'README.md': 'fork' },
    },
  ];
}

test('mission serializes and deserializes deterministically', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-research-'));
  const mission = makeMission(root);
  const json = JSON.parse(JSON.stringify(mission));
  const reparsed = ResearchMissionV1Schema.parse(json);
  assert.deepEqual(reparsed, mission);
  assert.equal(mission.schema_version, 1);
  assert.equal(mission.budget_preset, 'normal');
  assert.deepEqual(mission.budget, BUDGET_PRESET_VALUES.normal);
  assert.equal(mission.source_policy.execute_foreign_code, false);
  assert.equal(mission.source_policy.allow_repository_mutation, false);
});

test('mission rejects unknown fields and wrong schema_version', () => {
  assert.throws(() => ResearchMissionV1Schema.parse({ schema_version: 2 }));
  assert.throws(() =>
    ResearchMissionV1Schema.parse({
      schema_version: 1,
      mission_id: 'm',
      mission_kind: 'solution_hunt',
      created_at: '2026-10-03T00:00:00Z',
      problem: { statement: 'x', desired_outcome: 'y', failure_modes: [], constraints: [], non_goals: [] },
      target: { project_root: '/tmp', head_sha: null, repo_map_digest: null },
      budget: BUDGET_PRESET_VALUES.low,
      budget_preset: 'low',
      source_policy: { providers: ['github'], execute_foreign_code: false, allow_repository_mutation: false },
      rogue_field: true,
    }),
  );
});

test('budget presets are distinct and complete', () => {
  for (const preset of ['low', 'normal', 'deep'] as const) {
    const budget = resolveBudget(preset);
    assert.deepEqual(budget, BUDGET_PRESET_VALUES[preset]);
  }
  assert.ok(BUDGET_PRESET_VALUES.low.max_model_calls < BUDGET_PRESET_VALUES.deep.max_model_calls);
});

test('parseResearchArtifact gives a labeled error', () => {
  assert.throws(() => parseResearchArtifact(ResearchMissionV1Schema, null, 'mission.json'), /Invalid mission\.json/);
});

test('evidence ref validates full sha and line ordering', () => {
  const base = {
    schema_version: 1,
    evidence_id: 'ev_1',
    repository_id: '1001',
    repository_full_name: 'acme/durable-runner',
    commit_sha: 'a'.repeat(40),
    path: 'src/journal.ts',
    content_hash: sha256Hex('x'),
    acquisition_method: 'github_contents' as const,
    observed_at: FIXED_NOW.toISOString(),
  };
  assert.equal(EvidenceRefV1Schema.parse(base).evidence_id, 'ev_1');
  assert.throws(() => EvidenceRefV1Schema.parse({ ...base, commit_sha: 'abc123' }));
  assert.throws(() => EvidenceRefV1Schema.parse({ ...base, start_line: 5, end_line: 2 }));
  assert.doesNotThrow(() => EvidenceRefV1Schema.parse({ ...base, start_line: 1, end_line: 1 }));
});

test('pattern card requires evidence and sources, evidence state is bounded', () => {
  const card: PatternCardV1 = {
    schema_version: 1,
    pattern_id: 'pat_1',
    mission_id: 'mission_test_0001',
    title: 'Append-only journal replay',
    problem: 'state loss on crash',
    mechanism: 'task transitions appended to a journal and replayed',
    preconditions: [],
    tradeoffs: ['journal growth'],
    evidence_refs: ['ev_1'],
    sources: [{ repository_id: '1001', commit_sha: 'a'.repeat(40) }],
    license_observations: [{ repository_id: '1001', spdx_id: 'MIT', status: 'known' }],
    applicability: {
      target_head_sha: null,
      local_evidence_refs: [],
      hypothesis: '',
      integration_risks: [],
    },
    next_action: 'gather_more_evidence',
    evidence_state: 'SOURCE_CONFIRMED',
  };
  assert.equal(PatternCardV1Schema.parse(card).evidence_state, 'SOURCE_CONFIRMED');
  assert.throws(() => PatternCardV1Schema.parse({ ...card, evidence_refs: [] }));
  assert.throws(() => PatternCardV1Schema.parse({ ...card, evidence_state: 'PROVEN_BY_VIBES' }));
  assert.throws(() => PatternCardV1Schema.parse({ ...card, sources: [] }));
});

test('fake provider search, resolve, tree, and read deterministically', async () => {
  const provider = new FakeResearchProvider({ repositories: fixtureCorpus() });
  const page = await provider.searchRepositories('durable crash recovery');
  assert.equal(page.totalCount, 1);
  assert.equal(page.repositories[0]!.identity.observed_full_name, 'acme/durable-runner');

  const identity = page.repositories[0]!.identity;
  const revision = await provider.resolveRevision(identity, 'main');
  assert.equal(revision.commitSha, 'a'.repeat(40));
  await assert.rejects(provider.resolveRevision(identity, 'nope'));

  const tree = await provider.getTree(revision);
  assert.equal(tree.truncated, false);
  assert.deepEqual(tree.entries.map((e) => e.path), ['README.md', 'src/journal.ts']);

  const file = await provider.readTextFile(revision, 'src/journal.ts');
  assert.equal(file.contentHash, sha256Hex('append-only journal of task transitions'));
  assert.equal(file.blobSha, fakeBlobSha(file.content));
  await assert.rejects(provider.readTextFile(revision, 'missing.ts'));

  const code = await provider.searchCode('journal');
  assert.deepEqual(code.map((c) => c.path), ['README.md', 'src/journal.ts']);
});

test('fake provider can simulate truncated trees explicitly', async () => {
  const provider = new FakeResearchProvider({
    repositories: fixtureCorpus(),
    truncateTreeFor: ['acme/durable-runner'],
  });
  const page = await provider.searchRepositories('durable');
  const revision = await provider.resolveRevision(page.repositories[0]!.identity);
  const tree = await provider.getTree(revision);
  assert.equal(tree.truncated, true);
});

test('research run artifacts initialize and append atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-research-'));
  const mission = makeMission(root);
  const paths = initializeResearchRun(mission, root);
  assert.equal(researchRunPaths(root, mission).missionJson, paths.missionJson);
  assert.ok(existsSync(paths.missionJson));
  const persisted = JSON.parse(readFileSync(paths.missionJson, 'utf8'));
  assert.equal(persisted.mission_id, 'mission_test_0001');
  assert.equal(missionRunDirName(mission).endsWith('mission_test_0001'), true);

  appendJsonl(paths.candidatesJsonl, { candidate_id: 'c1' });
  appendJsonl(paths.candidatesJsonl, { candidate_id: 'c2' });
  assert.deepEqual(readJsonl(paths.candidatesJsonl), [{ candidate_id: 'c1' }, { candidate_id: 'c2' }]);
  assert.deepEqual(readJsonl(paths.patternsJsonl), []);
});
