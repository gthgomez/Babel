import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CandidateRecordV1, RepositoryIdentity } from '../contracts.js';
import { mergeAndDedupeCandidates, type CandidateSearchEntry } from './candidateMerge.js';
import { rankCandidates } from './triage.js';
import { selectDiverseShortlist } from './diversity.js';

const OBSERVED = '2026-10-03T00:00:00Z';

function identity(repoId: string, fullName: string, parentId: string | null = null): RepositoryIdentity {
  return {
    provider_repo_id: repoId,
    provider: 'github',
    observed_full_name: fullName,
    parent_provider_repo_id: parentId,
    default_branch: 'main',
    observed_at: OBSERVED,
  };
}

function entry(repoId: string, fullName: string, overrides: Partial<CandidateSearchEntry> = {}): CandidateSearchEntry {
  return {
    identity: overrides.identity ?? identity(repoId, fullName),
    description: overrides.description ?? null,
    language: overrides.language ?? null,
    topics: overrides.topics ?? [],
    archived: overrides.archived ?? false,
    stars: overrides.stars ?? 10,
    forks: overrides.forks ?? 2,
    pushed_at: overrides.pushed_at ?? '2026-09-15T00:00:00Z',
    license_spdx_id: overrides.license_spdx_id ?? 'MIT',
    is_fork: overrides.is_fork ?? false,
  };
}

test('merge unions hypothesis coverage by stable repo id and counts duplicates', () => {
  const outcome = mergeAndDedupeCandidates([
    { hypothesisId: 'hyp_1', entries: [entry('1', 'acme/runner'), entry('2', 'beta/journal')] },
    { hypothesisId: 'hyp_2', entries: [entry('1', 'acme/runner')] },
  ]);
  assert.equal(outcome.candidates.length, 2);
  assert.equal(outcome.duplicateDiscoveries, 1);
  const merged = outcome.candidates.find((c) => c.identity.provider_repo_id === '1')!;
  assert.deepEqual(merged.matched_hypothesis_ids, ['hyp_1', 'hyp_2']);
});

test('merge collapses same-language forks into the parent family', () => {
  const outcome = mergeAndDedupeCandidates([
    {
      hypothesisId: 'hyp_1',
      entries: [
        entry('1', 'acme/runner', { language: 'TypeScript' }),
        entry('2', 'mirror/runner', { language: 'TypeScript', is_fork: true, identity: identity('2', 'mirror/runner', '1') }),
      ],
    },
  ]);
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.forkFamilyCollapsed, 1);
});

test('merge keeps materially divergent forks (different language)', () => {
  const outcome = mergeAndDedupeCandidates([
    {
      hypothesisId: 'hyp_1',
      entries: [
        entry('1', 'acme/runner', { language: 'TypeScript' }),
        entry('2', 'mirror/runner', { language: 'Rust', is_fork: true, identity: identity('2', 'mirror/runner', '1') }),
      ],
    },
  ]);
  assert.equal(outcome.candidates.length, 2);
});

const TRIAGE_CONTEXT = {
  problemTerms: ['crash-resilient', 'agent'],
  mechanismTerms: ['durable', 'journal', 'checkpoint', 'resume', 'replay'],
  targetLanguages: ['typescript'],
  now: new Date('2026-10-03T00:00:00Z'),
};

test('triage ranks relevance over popularity and keeps full breakdowns', () => {
  const relevant = entry('1', 'acme/durable-agent-runner', {
    description: 'durable agent runner with journal checkpoint resume for crash-resilient work',
    language: 'TypeScript',
    topics: ['durable-execution'],
  });
  const popular = entry('2', 'celebrity/cool-ui', {
    description: 'very popular ui toolkit',
    language: 'TypeScript',
    stars: 50000,
  });
  const ranked = rankCandidates(
    [
      { schema_version: 1, candidate_id: 'cand_popular', matched_hypothesis_ids: ['hyp_1'], ...popular } as CandidateRecordV1,
      { schema_version: 1, candidate_id: 'cand_relevant', matched_hypothesis_ids: ['hyp_1'], ...relevant } as CandidateRecordV1,
    ],
    TRIAGE_CONTEXT,
  );
  assert.equal(ranked[0]!.candidate.candidate_id, 'cand_relevant');
  const factors = ranked[0]!.breakdown.contributions.map((c) => c.factor);
  for (const expected of [
    'problem_term_relevance',
    'mechanism_signal',
    'implementation_evidence',
    'language_compatibility',
    'test_ci_maturity',
    'maintenance_recency',
    'license_clarity',
    'supply_chain_signal',
    'popularity_context',
  ]) {
    assert.ok(factors.includes(expected), `missing factor ${expected}`);
  }
  const popularity = ranked[0]!.breakdown.contributions.find((c) => c.factor === 'popularity_context')!;
  assert.ok(popularity.points <= 2, 'stars must remain a weak signal');
});

test('triage penalizes archived, forked, and unknown-license candidates', () => {
  const base = entry('1', 'acme/thing', {});
  const archived = triageTotal({ ...base, archived: true }, 'cand_a');
  const forked = triageTotal({ ...base, is_fork: true }, 'cand_b');
  const unlicensed = triageTotal({ ...base, license_spdx_id: null }, 'cand_c');
  const clean = triageTotal(base, 'cand_d');
  assert.ok(archived < clean);
  assert.ok(forked < clean);
  assert.ok(unlicensed < clean);
});

function triageTotal(entryValue: ReturnType<typeof entry>, id: string): number {
  return rankCandidates(
    [{ schema_version: 1, candidate_id: id, matched_hypothesis_ids: ['hyp_1'], ...entryValue } as CandidateRecordV1],
    TRIAGE_CONTEXT,
  )[0]!.breakdown.total;
}

test('ranking is deterministic on identical input', () => {
  const candidates = [
    entry('1', 'a/x', { topics: ['durable'] }),
    entry('2', 'b/y', { topics: ['durable'] }),
  ].map((e, i) => ({ schema_version: 1, candidate_id: `cand_${i}`, matched_hypothesis_ids: ['hyp_1'], ...e }) as CandidateRecordV1);
  const first = rankCandidates(candidates, TRIAGE_CONTEXT).map((r) => r.candidate.candidate_id);
  const second = rankCandidates([...candidates].reverse(), TRIAGE_CONTEXT).map((r) => r.candidate.candidate_id);
  assert.deepEqual(first, second);
});

test('diversity selection caps per-org, per-family, and near-duplicate topics', () => {
  const mk = (id: string, fullName: string, topics: string[], score: number) => ({
    candidate: {
      schema_version: 1,
      candidate_id: id,
      identity: identity(id.replace('cand_', ''), fullName),
      matched_hypothesis_ids: ['hyp_1'],
      description: null,
      language: null,
      topics,
      archived: false,
      stars: 0,
      forks: 0,
      pushed_at: null,
      license_spdx_id: 'MIT',
      is_fork: false,
    } as CandidateRecordV1,
    breakdown: { candidate_id: id, contributions: [], penalties: [], total: score },
  });
  const ranked = [
    mk('cand_1', 'orgA/great', ['durable', 'journal'], 90),
    mk('cand_2', 'orgA/alsogreat', ['durable', 'journal', 'wal'], 85),
    mk('cand_3', 'orgA/third', ['durable', 'journal'], 80),
    mk('cand_4', 'orgA/fourth', ['durable', 'journal'], 75),
    mk('cand_5', 'orgB/different', ['scheduler', 'cron'], 70),
  ];
  const shortlist = selectDiverseShortlist(ranked, { limit: 10, maxPerOrg: 2 });
  const fullNames = shortlist.map((s) => s.candidate.identity.observed_full_name);
  assert.deepEqual(fullNames, ['orgA/great', 'orgA/alsogreat', 'orgB/different']);
});
