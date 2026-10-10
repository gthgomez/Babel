// License: Apache-2.0 - see LICENSE
import {EXPECTED_ORIGIN} from './updater.mjs';

const SHA = /^[a-f0-9]{40}$/;

/** protect-main release evidence on main push (PR-only checks excluded). */
export const PREVIEW_MAIN_REQUIRED_CHECKS = [
  'security',
  'public-content-policy',
  'linux-validation',
  'windows-portability',
];

const RELEASE_GATE_WORKFLOW = 'Public Release Gate';
const GITHUB_ACTIONS_APP_ID = 15368;

function matchesRequiredName(observedName, requiredName) {
  const name = String(observedName ?? '');
  return (
    name === requiredName ||
    name.startsWith(`${requiredName} /`) ||
    name.startsWith(`${requiredName}:`)
  );
}

function observationTimestamp(run) {
  const value = run?.started_at || run?.completed_at;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAuthoritativeReleaseGateRun(run, targetSha) {
  const appId = run?.app?.id;
  if (appId !== GITHUB_ACTIONS_APP_ID) return false;
  if (String(run?.head_sha ?? '').toLowerCase() !== targetSha.toLowerCase()) return false;
  const url = String(run?.details_url ?? '');
  if (!url.includes(`github.com/${EXPECTED_ORIGIN}/actions/runs/`)) return false;
  return true;
}

export async function fetchAllCheckRuns(githubJson, sha) {
  if (!SHA.test(sha)) throw new Error('invalid_commit_sha');
  const rows = [];
  let expected = null;
  for (let page = 1; page <= 100; page++) {
    const data = await githubJson(
      `/repos/${EXPECTED_ORIGIN}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`,
    );
    const total = data?.total_count;
    const batch = Array.isArray(data?.check_runs) ? data.check_runs : null;
    if (typeof total !== 'number' || batch === null) {
      throw new Error('check_runs_response_invalid');
    }
    if (expected === null) expected = total;
    if (expected !== total) throw new Error('check_runs_total_changed');
    rows.push(...batch);
    if (rows.length >= expected) break;
    if (batch.length !== 100) break;
    if (page === 100 && rows.length < expected) throw new Error('check_runs_pagination_incomplete');
  }
  if (expected !== null && rows.length !== expected) {
    throw new Error('check_runs_pagination_incomplete');
  }
  const seen = new Set();
  for (const run of rows) {
    const id = String(run?.id ?? '');
    if (!/^[1-9]\d*$/.test(id) || seen.has(id)) {
      throw new Error('check_runs_duplicate_or_invalid_id');
    }
    seen.add(id);
  }
  return rows;
}

export function resolvePreviewMainRequiredChecks(checkRuns, targetSha) {
  const results = [];
  for (const requiredName of PREVIEW_MAIN_REQUIRED_CHECKS) {
    const matching = checkRuns.filter(run => matchesRequiredName(run?.name, requiredName));
    const exactHead = matching.filter(
      run => String(run?.head_sha ?? '').toLowerCase() === targetSha.toLowerCase(),
    );
    if (exactHead.length === 0) {
      results.push({name: requiredName, status: 'missing', detail: 'required check missing for commit'});
      continue;
    }
    const eligible = exactHead.filter(run => isAuthoritativeReleaseGateRun(run, targetSha));
    if (eligible.length === 0) {
      results.push({name: requiredName, status: 'ambiguous', detail: 'no authoritative release-gate observation'});
      continue;
    }
    const ordered = [...eligible].sort((a, b) => observationTimestamp(b) - observationTimestamp(a));
    const selected = ordered[0];
    const status = String(selected?.status ?? '');
    const conclusion = String(selected?.conclusion ?? '');
    if (status !== 'completed') {
      results.push({name: requiredName, status: 'pending', detail: `check "${requiredName}" is ${status || 'pending'}`});
      continue;
    }
    if (conclusion === 'success') {
      results.push({name: requiredName, status: 'pass', detail: 'success'});
      continue;
    }
    if (conclusion === 'skipped') {
      results.push({name: requiredName, status: 'pass', detail: 'skipped'});
      continue;
    }
    results.push({
      name: requiredName,
      status: 'fail',
      detail: `check "${requiredName}" concluded with ${conclusion || 'failure'}`,
    });
  }
  return results;
}

export function summarizePreviewQualification(results) {
  const pending = results.find(r => r.status === 'pending');
  if (pending) {
    return {ok: false, reason: 'pending', detail: pending.detail};
  }
  const missing = results.find(r => r.status === 'missing' || r.status === 'ambiguous');
  if (missing) {
    return {ok: false, reason: missing.status, detail: missing.detail};
  }
  const failed = results.find(r => r.status === 'fail');
  if (failed) {
    return {ok: false, reason: 'failed', detail: failed.detail};
  }
  return {ok: true, reason: 'qualified', detail: 'All required main checks passed.'};
}
