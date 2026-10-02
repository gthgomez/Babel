import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const { load } = createRequire(new URL('babel-cli/package.json', root))('js-yaml');
const workflow = load(readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8'));
// Immutable pre-optimization coverage floor. Updating it requires deliberate review.
const original = spawnSync('git', ['-c', 'core.fsmonitor=false', 'show', '260e94bfa7672b98cf5dcac5f12c5b227944aa07:.github/workflows/typecheck.yml'], {
  cwd: fileURLToPath(root), encoding: 'utf8', timeout: 15000,
});
assert.ifError(original.error);
assert.equal(original.status, 0, original.stderr);
const baseline = load(original.stdout);

test('the final combined stack enforces all real architecture budgets on Linux and Windows', () => {
  const job = workflow.jobs['architecture-regressions'];
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  const budget = job.steps.find(step => step.name === 'Enforce full combined architecture budget');
  assert.ok(budget, 'Full architecture enforcement must begin with the final owner split');
  assert.equal(budget.run, 'pwsh -NoProfile -File tools/check-architectural-budget.ps1');
  assert.equal(budget.if, undefined);
  assert.equal(budget['continue-on-error'], undefined);
});

test('required stable platform names are explicit fail-closed aggregates', () => {
  for (const name of ['linux-validation', 'windows-portability']) {
    const job = workflow.jobs[name];
    assert.equal(job.name, name);
    assert.equal(job.if, 'always()');
    assert.equal(job.steps.length, 1, 'Aggregate must not serialize the full workloads');
    for (const dependency of ['security', 'public-content-policy', 'architecture-regressions', 'package-components', 'unit-shards', 'docker-smoke', 'platform-core', 'harness-runtime', 'chat-truth']) {
      assert.ok(job.needs.includes(dependency), `${name} must gate ${dependency}`);
    }
    assert.ok(job.needs.includes(name === 'linux-validation' ? 'remote-ui-browser' : 'windows-policy'));
  }
});

test('independent hosted workloads start without security-policy or other workload serialization', () => {
  for (const name of ['architecture-regressions', 'package-components', 'unit-shards', 'docker-smoke', 'platform-core', 'harness-runtime', 'chat-truth', 'remote-ui-browser', 'windows-policy']) {
    const job = workflow.jobs[name];
    assert.ok(job, `Missing ${name}`);
    assert.equal(job.needs, undefined, `${name} must run independently behind the aggregates`);
    assert.equal(job['continue-on-error'], undefined);
    assert.ok(['ubuntu-latest', 'windows-latest', '${{ matrix.os }}'].includes(job['runs-on']));
    assert.equal(job.permissions, undefined, 'Job must inherit contents:read');
  }
});

test('every pre-optimization Linux and Windows command remains covered on its original platform', () => {
  for (const [name, os] of [['linux-validation', 'ubuntu-latest'], ['windows-portability', 'windows-latest']]) {
    const expected = baseline.jobs[name].steps.filter(step => step.run).map(step => JSON.stringify([step.name, step.run, step['working-directory'] ?? '', step.shell ?? '']));
    const actual = [];
    for (const job of Object.values(workflow.jobs)) {
      const platforms = job.strategy?.matrix?.os ?? [job['runs-on']];
      if (!platforms.includes(os)) continue;
      for (const step of job.steps ?? []) {
        const condition = String(step.if ?? '');
        const namedPlatforms = ['ubuntu-latest', 'windows-latest'].filter(platform => condition.includes(platform));
        if (namedPlatforms.length === 1 && namedPlatforms[0] !== os) continue;
        if (step.run) actual.push(JSON.stringify([step.name, step.run, step['working-directory'] ?? '', step.shell ?? '']));
      }
    }
    for (const signature of expected) assert.ok(actual.includes(signature), `${name}: missing original command ${signature}`);
  }
});

test('security, public policy, review contracts, dual-OS manifest and metadata jobs remain semantically unchanged', () => {
  for (const name of ['security', 'public-content-policy', 'review-control-plane-contract', 'policy-integrity', 'public-pr-metadata-tests']) {
    assert.deepEqual(workflow.jobs[name], baseline.jobs[name], `Protected coverage changed: ${name}`);
  }
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, baseline.on);
  assert.deepEqual(workflow.concurrency, baseline.concurrency);
});

test('hosted unit shards retain exhaustive selection evidence with serial execution inside four shards per OS', () => {
  const job = workflow.jobs['unit-shards'];
  assert.ok(job);
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.deepEqual(job.strategy.matrix.shard, [0, 1, 2, 3]);
  assert.equal(job.strategy['fail-fast'], false);
  const run = job.steps.find(step => step.id === 'unit_shard');
  assert.match(run.run, /run_ci_unit_shard\.mjs --shard-index \$\{\{ matrix\.shard \}\} --shard-count 4/);
  assert.match(run.run, /exit \$LASTEXITCODE/);
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.ok(upload.with.path.includes('babel-cli/artifacts/ci-unit'));
});

test('runtime and chat preserve required selection, raw TAP and fail-closed summaries on both operating systems', () => {
  for (const name of ['harness-runtime', 'chat-truth']) {
    const job = workflow.jobs[name];
    assert.ok(job);
    assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
    const commands = job.steps.map(step => step.run ?? '').join('\n');
    assert.ok(commands.includes(`capture_required_tap_selection.mjs ${name}`));
    assert.ok(commands.includes(`summarize_required_tap.mjs ${name}`));
    assert.ok(commands.includes(`artifacts/${name}/full.tap`));
    assert.ok(commands.includes(`npm run test:${name}`));
  }
});
