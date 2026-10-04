import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeResearchProvider, type FakeRepository } from './fakeProvider.js';
import { createResearchMission } from './missionPlanner.js';
import { runHuntDiscovery } from './hunt.js';
import { RateBudget, RateBudgetExhaustedError, RateBudgetPausedError } from './rateBudget.js';

const FIXED_NOW = new Date('2026-10-03T12:00:00.000Z');

function corpus(): FakeRepository[] {
  return [
    {
      providerRepoId: '1001',
      fullName: 'acme/durable-runner',
      defaultBranch: 'main',
      commitSha: 'a'.repeat(40),
      description: 'Durable agent workflow runner with crash recovery and journal checkpoints',
      language: 'TypeScript',
      topics: ['durable-execution', 'agents'],
      archived: false,
      stars: 120,
      forks: 9,
      pushedAt: '2026-09-01T00:00:00Z',
      licenseSpdxId: 'MIT',
      isFork: false,
      files: { 'README.md': 'durable execution with journal replay after crash' },
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
    {
      providerRepoId: '1003',
      fullName: 'beta/task-journal',
      defaultBranch: 'main',
      commitSha: 'c'.repeat(40),
      description: 'append-only task journal with idempotent resume',
      language: 'TypeScript',
      topics: ['event-sourcing'],
      archived: false,
      stars: 40,
      forks: 4,
      pushedAt: '2026-09-20T00:00:00Z',
      licenseSpdxId: 'Apache-2.0',
      isFork: false,
      files: { 'README.md': 'journal resume' },
    },
  ];
}

function missionFor(runsRoot: string) {
  return createResearchMission({
    problem: 'How can we make long-running agent work crash-resilient?',
    projectRoot: runsRoot,
    budgetPreset: 'normal',
    now: FIXED_NOW,
    missionId: 'mission_hunt_test',
  });
}

test('hunt persists query plan, candidates, scores, and metrics', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-hunt-'));
  const mission = missionFor(runsRoot);
  const provider = new FakeResearchProvider({ repositories: corpus() });
  const result = await runHuntDiscovery(mission, provider, { runsRoot, now: FIXED_NOW });

  assert.equal(result.status, 'COMPLETE');
  assert.ok(existsSync(result.paths.queryPlanJson));
  const plan = JSON.parse(readFileSync(result.paths.queryPlanJson, 'utf8'));
  assert.ok(plan.hypotheses.length >= 5);
  assert.ok(existsSync(result.paths.candidatesJsonl));
  assert.ok(existsSync(result.paths.scoreBreakdownJsonl));

  const fullName = result.candidates.find((c) => c.identity.observed_full_name === 'acme/durable-runner');
  assert.ok(fullName, 'expected the durable runner to be discovered');
  const forked = result.candidates.find((c) => c.identity.observed_full_name === 'mirror/durable-runner');
  assert.ok(!forked, 'same-language fork must collapse into its parent');

  assert.ok(result.metrics.candidate_count_after_dedup >= 2);
  assert.ok(result.metrics.shortlist_count >= 1);
  assert.ok(result.metrics.duplicate_discoveries >= 1);
  assert.ok(existsSync(result.paths.metricsJson));
});

test('hunt surfaces candidates to multiple hypotheses with union coverage', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-hunt-'));
  const provider = new FakeResearchProvider({ repositories: corpus() });
  const result = await runHuntDiscovery(missionFor(runsRoot), provider, { runsRoot, now: FIXED_NOW });
  const runner = result.candidates.find((c) => c.identity.observed_full_name === 'acme/durable-runner')!;
  assert.ok(runner.matched_hypothesis_ids.length >= 2, 'broad hypotheses should overlap on a strong match');
});

test('hunt degrades to INCOMPLETE (not a crash) when the provider budget exhausts', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-hunt-'));
  const mission = missionFor(runsRoot);
  const provider = new FakeResearchProvider({ repositories: corpus() });
  const failingProvider = new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'searchRepositories') {
        return async () => {
          throw new RateBudgetExhaustedError('search request budget exhausted (0)');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const result = await runHuntDiscovery(mission, failingProvider as typeof provider, { runsRoot, now: FIXED_NOW });
  assert.equal(result.status, 'INCOMPLETE');
  assert.match(result.reason ?? '', /budget exhausted/);
  const metrics = JSON.parse(readFileSync(result.paths.metricsJson, 'utf8'));
  assert.equal(metrics.status, 'INCOMPLETE');
});

test('hunt attaches the rate budget snapshot when the provider exposes one', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-hunt-'));
  const provider = new FakeResearchProvider({ repositories: corpus() });
  const withBudget = Object.assign(provider, { budget: new RateBudget(1000, 100) });
  const result = await runHuntDiscovery(missionFor(runsRoot), withBudget, { runsRoot, now: FIXED_NOW });
  assert.ok(result.budget);
  assert.equal(result.budget!.state, 'OK');
});

test('paused discovery persists partial results without starting deep acquisition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hunt-paused-'));
  const provider = new FakeResearchProvider({ repositories: corpus() });
  let searches = 0, resolves = 0;
  const wrapped = new Proxy(provider, { get(target, prop, receiver) {
    if (prop === 'searchRepositories') return async (...args: Parameters<typeof provider.searchRepositories>) => { if (searches++ > 0) throw new RateBudgetPausedError('rate limited', new Date(Date.now() + 30000)); return target.searchRepositories(...args); };
    if (prop === 'resolveRevision') return async (...args: Parameters<typeof provider.resolveRevision>) => { resolves += 1; return target.resolveRevision(...args); };
    return Reflect.get(target, prop, receiver);
  } });
  const result = await runHuntDiscovery(missionFor(root), wrapped, { runsRoot: root });
  assert.equal(result.status, 'PAUSED');
  assert.ok(result.shortlist.length > 0);
  assert.equal(resolves, 0);
  assert.equal(JSON.parse(readFileSync(result.paths.metricsJson, 'utf8')).status, 'PAUSED');
});

test('acquisition errors preserve an honest incomplete hunt receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hunt-acquisition-'));
  const provider = new FakeResearchProvider({ repositories: corpus() });
  const wrapped = new Proxy(provider, { get(target, prop, receiver) {
    if (prop === 'resolveRevision') return async () => { throw new RateBudgetExhaustedError('remote byte budget exhausted'); };
    return Reflect.get(target, prop, receiver);
  } });
  const result = await runHuntDiscovery(missionFor(root), wrapped, { runsRoot: root });
  assert.equal(result.status, 'INCOMPLETE');
  assert.match(result.reason ?? '', /byte budget exhausted/);
  assert.equal(JSON.parse(readFileSync(result.paths.metricsJson, 'utf8')).status, 'INCOMPLETE');
});

test('hunt receipt refreshes actual budget consumption after deep acquisition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hunt-budget-final-'));
  const provider = new FakeResearchProvider({ repositories: corpus() });
  const budget = new RateBudget(1000, 100);
  const wrapped = new Proxy(provider, { get(target, prop, receiver) {
    if (prop === 'budget') return budget;
    if (prop === 'readTextFile') return async (...args: Parameters<typeof provider.readTextFile>) => { const file = await target.readTextFile(...args); budget.recordBytes(Buffer.byteLength(file.content, 'utf8')); return file; };
    return Reflect.get(target, prop, receiver);
  } });
  const result = await runHuntDiscovery(missionFor(root), wrapped, { runsRoot: root });
  assert.ok(budget.bytes > 0);
  assert.equal(result.budget!.bytesDownloaded, budget.bytes);
  assert.equal(JSON.parse(readFileSync(result.paths.metricsJson, 'utf8')).budget.bytesDownloaded, budget.bytes);
});
