import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const require = createRequire(new URL('babel-cli/package.json', root));
const { load } = require('js-yaml');
const workflow = load(readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('babel-cli/package.json', root), 'utf8'));
const components = pkg.scripts.test.split(/\s*&&\s*/).map(command => {
  const match = /^npm run ([a-z0-9:-]+)$/.exec(command);
  assert.ok(match, `Unrecognized canonical package component: ${command}`);
  return match[1];
});

test('every canonical package component runs on Linux; all portable components also run on Windows', () => {
  const job = workflow.jobs['package-components'];
  assert.ok(job, 'Missing hosted package component coverage');
  const matrix = job.strategy.matrix;
  assert.deepEqual(matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(job.strategy['fail-fast'], false);
  const portable = job.steps.find(step => step.id === 'package_component');
  assert.match(portable.run, /package\.scripts\.test/);
  assert.match(portable.run, /npm run \$suite/);
  assert.deepEqual(workflow.jobs['unit-shards'].strategy.matrix.os, matrix.os);
  assert.equal(workflow.jobs['docker-smoke']['runs-on'], 'ubuntu-latest');
  assert.ok(components.includes('test:unit') && components.includes('test:smoke-fixtures'));
});

test('portable execution runs every selected component and retains any failing subprocess status', t => {
  const base = mkdtempSync(join(tmpdir(), 'babel-ci-components-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const packageRoot = join(base, 'package');
  mkdirSync(packageRoot);
  mkdirSync(join(base, 'artifacts', 'ci-package'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ scripts: { test: 'npm run test:unit && npm run test:future-one && npm run test:smoke-fixtures && npm run test:future-two' } }));
  const script = workflow.jobs['package-components'].steps.find(step => step.id === 'package_component').run;
  // A controlled executable stand-in records selection without running the heavy suites.
  const npm = `function npm { param($verb, $suite)\nif ($verb -ne 'run') { throw 'Unexpected invocation' }\nWrite-Output "selected:$suite"\n$global:LASTEXITCODE = if ($suite -eq $env:BABEL_CI_PROBE_FAILURE) { 7 } else { 0 }\n}\n`;
  for (const failed of ['', 'test:future-one']) {
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', npm + script], {
      cwd: packageRoot, env: { ...process.env, BABEL_CI_PROBE_FAILURE: failed }, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, failed ? 7 : 0, result.stderr);
    const selected = [...result.stdout.matchAll(/selected:([a-z0-9:-]+)/g)].map(match => match[1]);
    assert.deepEqual(selected, ['test:future-one', 'test:future-two']);
    const results = JSON.parse(readFileSync(join(base, 'artifacts', 'ci-package', 'results.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.deepEqual(results.map(result => result.suite), ['test:future-one', 'test:future-two']);
    assert.deepEqual(results.map(result => result.exitCode), failed ? [7, 0] : [0, 0]);
  }
});

test('both protected platform checks depend on package and architecture coverage', () => {
  for (const name of ['linux-validation', 'windows-portability']) {
    const job = workflow.jobs[name];
    for (const dependency of ['security', 'public-content-policy', 'package-components', 'architecture-regressions']) {
      assert.ok(job.needs.includes(dependency), `${name} must gate ${dependency}`);
    }
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.if, 'always()', 'Required jobs must run and explicitly reject failed/skipped dependencies');
    const guard = job.steps[0];
    assert.equal(guard.env.NEEDS_JSON, '${{ toJSON(needs) }}');
    assert.equal(guard.name, 'Require every coverage dependency to succeed');
  }
});

test('real protected-job dependency guards reject failure, cancellation, skipped and missing results', () => {
  for (const name of ['linux-validation', 'windows-portability']) {
    const guard = workflow.jobs[name].steps[0];
    assert.equal(guard.name, 'Require every coverage dependency to succeed');
    for (const result of ['success', 'failure', 'cancelled', 'skipped', null]) {
      const dependencies = Object.fromEntries(workflow.jobs[name].needs.map(dependency => [dependency, { result: 'success' }]));
      dependencies['package-components'].result = result;
      const processResult = spawnSync('pwsh', ['-NoProfile', '-Command', guard.run], {
        env: { ...process.env, NEEDS_JSON: JSON.stringify(dependencies) }, encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(processResult.error);
      assert.equal(processResult.status === 0, result === 'success', `${name}: ${result}: ${processResult.stderr}`);
    }
    const empty = spawnSync('pwsh', ['-NoProfile', '-Command', guard.run], {
      env: { ...process.env, NEEDS_JSON: '{}' }, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(empty.error);
    assert.notEqual(empty.status, 0, `${name}: missing dependencies must fail`);
  }
});

test('Docker image is immutable and scoped to the Ubuntu smoke step with no host fallback', () => {
  const job = workflow.jobs['docker-smoke'];
  assert.ok(job, 'Missing isolated hosted smoke job');
  const smoke = job.steps.find(step => step.id === 'docker_smoke');
  assert.ok(smoke);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(smoke.if, undefined, 'Dedicated smoke job always executes its smoke step');
  assert.match(smoke.env.BABEL_BENCHMARK_DOCKER_IMAGE, /^node@sha256:[a-f0-9]{64}$/);
  assert.equal(job.env?.BABEL_BENCHMARK_DOCKER_IMAGE, undefined);
  assert.equal(workflow.env?.BABEL_BENCHMARK_DOCKER_IMAGE, undefined);
  for (const step of job.steps.filter(step => step !== smoke)) {
    assert.equal(step.env?.BABEL_BENCHMARK_DOCKER_IMAGE, undefined);
  }
  const prepare = job.steps.find(step => step.id === 'docker_prepare');
  assert.match(prepare.run, /docker info/);
  assert.match(prepare.run, /docker pull node@sha256:[a-f0-9]{64}/);
  assert.match(prepare.run, /echo "uid=\$\(id -u\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(prepare.run, /echo "gid=\$\(id -g\)" >> "\$GITHUB_OUTPUT"/);
  assert.equal(smoke.env.BABEL_BENCHMARK_DOCKER_EXTRA_ARGS,
    '--user ${{ steps.docker_prepare.outputs.uid }}:${{ steps.docker_prepare.outputs.gid }}');
  for (const other of Object.values(workflow.jobs)) {
    assert.equal(other.env?.BABEL_BENCHMARK_DOCKER_EXTRA_ARGS, undefined);
    for (const step of other.steps ?? []) {
      if (step !== smoke) assert.equal(step.env?.BABEL_BENCHMARK_DOCKER_EXTRA_ARGS, undefined);
    }
  }
  const text = readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8');
  assert.doesNotMatch(text, /BABEL_ALLOW_HOST_FALLBACK\s*[:=]\s*['"]?1/);
  assert.doesNotMatch(text, /BABEL_DOCKER_DISABLE\s*[:=]\s*['"]?true/);
});

test('scanner and real budget checker regressions run on both standard platforms', () => {
  const job = workflow.jobs['architecture-regressions'];
  assert.ok(job, 'Missing scanner regression coverage');
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  for (const path of ['tools/tests/architectural-boundaries.test.mjs', 'tools/tests/architectural-budget.test.mjs', 'tools/tests/test-architectural-budget-allowlist.ps1', 'tools/tests/ci-package-coverage.test.mjs']) {
    assert.ok(commands.includes(path), `Missing ${path}`);
  }
});

test('coverage jobs retain exact head and checkout identity and raw execution logs', () => {
  for (const name of ['package-components', 'architecture-regressions']) {
    const job = workflow.jobs[name];
    assert.ok(job, `Missing ${name}`);
    const identity = job.steps.find(step => step.name === 'Record candidate identity');
    assert.match(identity.run, /github\.event\.pull_request\.head\.sha/);
    assert.match(identity.run, /git rev-parse HEAD/);
    assert.match(identity.run, /merge-base --is-ancestor/);
    const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload.if, 'always()');
    assert.equal(upload.with['if-no-files-found'], 'error');
  }
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.on.pull_request !== undefined || Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.on.pull_request_target, undefined);
});
