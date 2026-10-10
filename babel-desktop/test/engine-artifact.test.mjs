// License: Apache-2.0 - see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  resolveStableReleaseCandidate,
  resolvePreviewCandidate,
  ensureLockfileForCli,
} from '../native/engine-artifact.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

test('resolveStableReleaseCandidate resolves tag commit when release target_commitish is a branch', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.1.1',
            target_commitish: 'main',
            assets: [
              {
                name: 'babel-cli-0.1.1.tgz',
                browser_download_url: 'https://github.com/gthgomez/Babel/releases/download/v0.1.1/babel-cli-0.1.1.tgz',
              },
            ],
          }),
        };
      }
      if (u.includes('/commits/v0.1.1')) {
        return {
          ok: true,
          json: async () => ({
            sha: SHA_C,
          }),
        };
      }
      return {ok: false, status: 404};
    };

    const res = await resolveStableReleaseCandidate(SHA_A);
    assert.equal(res.state, 'available');
    assert.equal(res.channel, 'stable');
    assert.equal(res.currentSha, SHA_A);
    assert.equal(res.availableSha, SHA_C);
    assert.equal(res.candidate.tag, 'v0.1.1');
    assert.equal(res.candidate.sourceSha, SHA_C);
    assert.equal(res.candidate.tgzName, 'babel-cli-0.1.1.tgz');

    // If current SHA already matches
    const currentRes = await resolveStableReleaseCandidate(SHA_C);
    assert.equal(currentRes.state, 'current');
    assert.equal(currentRes.availableSha, SHA_C);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveStableReleaseCandidate returns unsupported when tag commit cannot be resolved', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.1.1',
            target_commitish: 'main',
            assets: [
              {
                name: 'babel-cli-0.1.1.tgz',
                browser_download_url: 'https://github.com/gthgomez/Babel/releases/download/v0.1.1/babel-cli-0.1.1.tgz',
              },
            ],
          }),
        };
      }
      return {ok: false, status: 404};
    };

    const res = await resolveStableReleaseCandidate(SHA_A);
    assert.equal(res.state, 'unsupported');
    assert.match(res.detail, /No qualified stable CLI archive was found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function qualifiedMainCheckRuns(sha, extra = []) {
  const required = ['security', 'public-content-policy', 'linux-validation', 'windows-portability'];
  const runs = required.map((name, index) => ({
    id: String(1000 + index),
    name,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    started_at: `2026-01-02T00:0${index}:00Z`,
    completed_at: `2026-01-02T00:0${index}:00Z`,
    app: {id: 15368},
    details_url: `https://github.com/gthgomez/Babel/actions/runs/99/job/${index}`,
  }));
  return [...runs, ...extra];
}

test('resolvePreviewCandidate requires all GitHub Actions check-runs to succeed', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Success case
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/commits/main')) {
        return {ok: true, json: async () => ({sha: SHA_B})};
      }
      if (u.includes(`/commits/${SHA_B}/check-runs`)) {
        return {
          ok: true,
          json: async () => ({
            total_count: qualifiedMainCheckRuns(SHA_B, [
              {id: '2000', name: 'optional-audit', head_sha: SHA_B, status: 'completed', conclusion: 'failure', app: {id: 15368}, details_url: 'https://github.com/gthgomez/Babel/actions/runs/1/job/1'},
            ]).length,
            check_runs: qualifiedMainCheckRuns(SHA_B, [
              {id: '2000', name: 'optional-audit', head_sha: SHA_B, status: 'completed', conclusion: 'failure', app: {id: 15368}, details_url: 'https://github.com/gthgomez/Babel/actions/runs/1/job/1'},
            ]),
          }),
        };
      }
      return {ok: false, status: 404};
    };

    const successRes = await resolvePreviewCandidate(SHA_A);
    assert.equal(successRes.state, 'available');
    assert.equal(successRes.channel, 'preview');
    assert.equal(successRes.availableSha, SHA_B);

    // 2. In-progress check
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/commits/main')) return {ok: true, json: async () => ({sha: SHA_B})};
      if (u.includes(`/commits/${SHA_B}/check-runs`)) {
        const runs = qualifiedMainCheckRuns(SHA_B);
        runs[0] = {...runs[0], status: 'in_progress', conclusion: null};
        return {ok: true, json: async () => ({total_count: runs.length, check_runs: runs})};
      }
      return {ok: false, status: 404};
    };

    const inProgressRes = await resolvePreviewCandidate(SHA_A);
    assert.equal(inProgressRes.state, 'unsupported');
    assert.match(inProgressRes.detail, /in_progress/);

    // 3. Failed check
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/commits/main')) return {ok: true, json: async () => ({sha: SHA_B})};
      if (u.includes(`/commits/${SHA_B}/check-runs`)) {
        const runs = qualifiedMainCheckRuns(SHA_B);
        runs[0] = {...runs[0], conclusion: 'failure'};
        return {ok: true, json: async () => ({total_count: runs.length, check_runs: runs})};
      }
      return {ok: false, status: 404};
    };

    const failedRes = await resolvePreviewCandidate(SHA_A);
    assert.equal(failedRes.state, 'unsupported');
    assert.match(failedRes.detail, /not qualified/);

    // 4. Zero check-runs
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/commits/main')) return {ok: true, json: async () => ({sha: SHA_B})};
      if (u.includes(`/commits/${SHA_B}/check-runs`)) {
        return {
          ok: true,
          json: async () => ({
            total_count: 0,
            check_runs: [],
          }),
        };
      }
      return {ok: false, status: 404};
    };

    const zeroRes = await resolvePreviewCandidate(SHA_A);
    assert.equal(zeroRes.state, 'unsupported');
    assert.match(zeroRes.detail, /no CI check-runs were found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ensureLockfileForCli handles local, bundled, and remote acquisition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-lock-'));
  try {
    const cliRoot = join(dir, 'cli');
    mkdirSync(cliRoot, {recursive: true});

    // 1. Existing lockfile in cliRoot
    writeFileSync(join(cliRoot, 'package-lock.json'), '{"lockfileVersion": 3}');
    const alreadyPresent = await ensureLockfileForCli({cliRoot});
    assert.equal(alreadyPresent, true);

    rmSync(join(cliRoot, 'package-lock.json'));

    // 2. Bundled lockfile in resourcesPath
    const resourcesPath = join(dir, 'resources');
    const bundledLock = join(resourcesPath, 'babel-runtime', 'cli', 'package-lock.json');
    mkdirSync(join(resourcesPath, 'babel-runtime', 'cli'), {recursive: true});
    writeFileSync(bundledLock, '{"lockfileVersion": 3, "bundled": true}');

    const bundledCopied = await ensureLockfileForCli({cliRoot, resourcesPath});
    assert.equal(bundledCopied, true);
    assert.equal(JSON.parse(readFileSync(join(cliRoot, 'package-lock.json'), 'utf8')).bundled, true);

    rmSync(join(cliRoot, 'package-lock.json'));
    rmSync(resourcesPath, {recursive: true, force: true});

    // 3. Fallback to download from repo
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/contents/babel-cli/package-lock.json')) {
          return {
            ok: true,
            json: async () => ({
              encoding: 'base64',
              content: Buffer.from(JSON.stringify({lockfileVersion: 3, remote: true})).toString('base64'),
            }),
          };
        }
        return {ok: false, status: 404};
      };

      const remoteFetched = await ensureLockfileForCli({cliRoot, sourceSha: SHA_B});
      assert.equal(remoteFetched, true);
      assert.equal(JSON.parse(readFileSync(join(cliRoot, 'package-lock.json'), 'utf8')).remote, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
