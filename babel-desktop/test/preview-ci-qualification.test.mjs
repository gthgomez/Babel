// License: Apache-2.0 - see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_MAIN_REQUIRED_CHECKS,
  fetchAllCheckRuns,
  resolvePreviewMainRequiredChecks,
  summarizePreviewQualification,
} from '../native/preview-ci-qualification.mjs';

const SHA = 'b'.repeat(40);

function releaseGateRun(name, {status = 'completed', conclusion = 'success', startedAt = '2026-01-02T00:00:00Z'} = {}) {
  return {
    id: String(Math.floor(Math.random() * 1_000_000)),
    name,
    head_sha: SHA,
    status,
    conclusion,
    started_at: startedAt,
    completed_at: startedAt,
    app: {id: 15368},
    details_url: `https://github.com/gthgomez/Babel/actions/runs/123/job/456`,
  };
}

test('resolvePreviewMainRequiredChecks ignores unrelated failed advisory checks', () => {
  const runs = PREVIEW_MAIN_REQUIRED_CHECKS.map((name, index) =>
    releaseGateRun(name, {startedAt: `2026-01-02T00:0${index}:00Z`}),
  );
  runs.push(releaseGateRun('advisory-audit', {conclusion: 'failure'}));
  const results = resolvePreviewMainRequiredChecks(runs, SHA);
  const summary = summarizePreviewQualification(results);
  assert.equal(summary.ok, true);
});

test('resolvePreviewMainRequiredChecks fails when a required check is missing', () => {
  const runs = PREVIEW_MAIN_REQUIRED_CHECKS.slice(0, 3).map(name => releaseGateRun(name));
  const summary = summarizePreviewQualification(resolvePreviewMainRequiredChecks(runs, SHA));
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, 'missing');
});

test('fetchAllCheckRuns paginates beyond the first page', async () => {
  const pages = new Map();
  for (let page = 1; page <= 2; page++) {
    const batch = Array.from({length: page === 1 ? 100 : 35}, (_, index) => ({
      ...releaseGateRun(`shard-${page}-${index}`),
      id: String(page * 1000 + index),
    }));
    pages.set(page, {total_count: 135, check_runs: batch});
  }
  const githubJson = async path => {
    const match = String(path).match(/[?&]page=(\d+)/);
    const page = Number(match?.[1] ?? 1);
    return pages.get(page);
  };
  const runs = await fetchAllCheckRuns(githubJson, SHA);
  assert.equal(runs.length, 135);
});
