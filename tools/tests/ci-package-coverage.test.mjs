import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  assert.deepEqual([...matrix.suite].sort(), [...components].sort());
  assert.deepEqual(matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.deepEqual(matrix.exclude, [{ os: 'windows-latest', suite: 'test:smoke-fixtures' }]);
  assert.equal(job.strategy['fail-fast'], false);
  const unit = job.steps.find(step => step.id === 'package_component');
  assert.match(unit.run, /test-concurrency=1/);
  assert.match(unit.run, /matrix\.suite/);
  assert.match(unit.run, /exit \$LASTEXITCODE/);
});

test('both protected platform checks depend on package and architecture coverage', () => {
  for (const name of ['linux-validation', 'windows-portability']) {
    const job = workflow.jobs[name];
    for (const dependency of ['security', 'public-content-policy', 'package-components', 'architecture-regressions']) {
      assert.ok(job.needs.includes(dependency), `${name} must gate ${dependency}`);
    }
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.if, undefined, 'Default dependency success must remain fail closed');
  }
});

test('Docker image is immutable and scoped to the Ubuntu smoke step with no host fallback', () => {
  const job = workflow.jobs['package-components'];
  assert.ok(job, 'Missing isolated hosted smoke job');
  const smoke = job.steps.find(step => step.id === 'docker_smoke');
  assert.ok(smoke);
  assert.match(smoke.if, /matrix\.suite == 'test:smoke-fixtures'/);
  assert.match(smoke.env.BABEL_BENCHMARK_DOCKER_IMAGE, /^node@sha256:[a-f0-9]{64}$/);
  assert.equal(job.env?.BABEL_BENCHMARK_DOCKER_IMAGE, undefined);
  assert.equal(workflow.env?.BABEL_BENCHMARK_DOCKER_IMAGE, undefined);
  for (const step of job.steps.filter(step => step !== smoke)) {
    assert.equal(step.env?.BABEL_BENCHMARK_DOCKER_IMAGE, undefined);
  }
  const prepare = job.steps.find(step => step.id === 'docker_prepare');
  assert.match(prepare.run, /docker info/);
  assert.match(prepare.run, /docker pull node@sha256:[a-f0-9]{64}/);
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
