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
    for (const signature of expected) {
      // These suites still run under pwsh in babel-cli and still publish
      // artifacts/<suite>/full.tap. The live Tee-Object target is outside that
      // project so a growing log cannot change repository capture mid-run.
      const relocated = signature.match(/npm run test:(harness-runtime|chat-truth)[^"]*artifacts\/\1\/full\.tap/);
      if (relocated) {
        const suite = relocated[1];
        const stepName = suite === 'harness-runtime'
          ? 'Run required harness runtime suite'
          : 'Run required Chat truth suite';
        const step = workflow.jobs[suite].steps.find(candidate => candidate.name === stepName);
        assert.ok(step, `${name}: ${stepName} missing`);
        assert.equal(step['working-directory'], 'babel-cli');
        assert.equal(step.shell, 'pwsh');
        assert.match(step.run, new RegExp(`Join-Path \\$env:RUNNER_TEMP 'babel-${suite}'`));
        assert.match(step.run, new RegExp(`npm run test:${suite}[^\\n]*Tee-Object -FilePath \\$tap`));
        assert.match(step.run, new RegExp(`Copy-Item -Force \\$tap artifacts/${suite}/full\\.tap`));
        assert.match(step.run, /\$code = \$LASTEXITCODE/);
        assert.match(step.run, /exit \$code/);
        continue;
      }
      assert.ok(actual.includes(signature), `${name}: missing original command ${signature}`);
    }
  }
});

function assertRequiredReviewUnion(candidate) {
  const job = candidate.jobs['platform-core'];
  assert.ok(candidate.jobs['linux-validation'].needs.includes('platform-core'));
  assert.ok(job.strategy.matrix.os.includes('ubuntu-latest'));
  for (const original of baseline.jobs['review-control-plane-contract'].steps.filter(s => s.run?.includes('--test ') || s.run?.includes('foreach ($test'))) {
    const expected = [...original.run.matchAll(/(?:tools\/tests\/[a-z0-9-]+\.ps1|src\/services\/[a-zA-Z0-9]+\.test\.ts)/g)].map(m => m[0]);
    assert.ok(expected.length >= 3);
    const provider = job.steps.find(step => expected.every(path => step.run?.includes(path)));
    assert.ok(provider, 'Required Ubuntu path lost review contract files');
    assert.equal(provider.if, "matrix.os == 'ubuntu-latest'");
    assert.equal(provider['continue-on-error'], undefined);
    if (original.run.includes('foreach')) assert.match(provider.run, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
    else assert.equal(provider.run.replace(/\s+/g, ' ').trim(), original.run.replace(/\s+/g, ' ').trim());
  }
}
test('standalone review contract can be removed only with the complete required Ubuntu union', () => {
  assertRequiredReviewUnion(workflow);
  const missing = structuredClone(workflow);
  missing.jobs['platform-core'].steps.find(s => s.run?.includes('reviewControlPlaneParity.test.ts')).run = 'echo omitted';
  assert.throws(() => assertRequiredReviewUnion(missing));
});
test('security, public policy, review contracts, dual-OS manifest and metadata retain coverage', () => {
  for (const name of ['security', 'public-content-policy', 'policy-integrity']) {
    assert.deepEqual(workflow.jobs[name], baseline.jobs[name], `Protected coverage changed: ${name}`);
  }
  assertRequiredReviewUnion(workflow);
  const metadata = structuredClone(workflow.jobs['public-pr-metadata-tests']);
  assert.equal(metadata.if, undefined);
  assert.equal(metadata.steps[1].if, "github.event_name == 'pull_request'");
  assert.ok(metadata.steps[2].run.includes('not applicable'));
  delete metadata.steps[1].if;
  metadata.steps.pop();
  metadata.if = "github.event_name == 'pull_request'";
  assert.deepEqual(metadata, baseline.jobs['public-pr-metadata-tests']);
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
  // The live TAP must stay outside babel-cli while tests capture that project.
  assert.match(run.run, /Join-Path \$env:RUNNER_TEMP 'babel-ci-unit'/);
  assert.match(run.run, /Tee-Object -FilePath \$tap/);
  assert.match(run.run, /\$shardCode = \$LASTEXITCODE/);
  assert.match(run.run, /Copy-Item -Force \$tap artifacts\/ci-unit\/full\.tap/);
  assert.match(run.run, /exit \$shardCode/);
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
    assert.ok(commands.includes(`Join-Path $env:RUNNER_TEMP 'babel-${name}'`));
    assert.ok(commands.includes(`artifacts/${name}/full.tap`));
    assert.ok(commands.includes(`npm run test:${name}`));
  }
});

function assertImmutableConsumerGraph(candidate) {
  const jobs = candidate.jobs;
  const producer = jobs['consumer-candidate'];
  assert.ok(producer);
  const exactSource = '${{ github.event.pull_request.head.sha || github.sha }}';
  assert.equal(producer.steps[0].with.ref, exactSource);
  assert.equal(producer.steps[0].with['persist-credentials'], false);
  assert.equal(producer.outputs.sha256, '${{ steps.pack.outputs.sha256 }}');
  assert.equal(producer.outputs.source, '${{ steps.pack.outputs.source_sha }}');
  const pack = producer.steps.find(s => s.id === 'pack');
  assert.equal(pack.run, 'npm run package:release');
  assert.equal(pack.env.CANDIDATE_HEAD, exactSource);
  assert.equal(pack.if, undefined);
  const expectedMatrix = {os:['ubuntu-latest','windows-latest','macos-latest'], node:['22.19.0','24.13.1','24']};
  for (const name of ['consumer-build-toolchains','consumer-artifact']) {
    const job = jobs[name];
    assert.deepEqual(job.strategy.matrix, expectedMatrix, name);
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job.if, undefined);
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.steps[0].with.ref, exactSource);
    for (const gate of ['linux-validation','windows-portability']) assert.ok(jobs[gate].needs.includes(name));
  }
  const build = jobs['consumer-build-toolchains'].steps.find(s => s.run === 'npm run build');
  assert.ok(build); assert.equal(build.if, undefined); assert.equal(build['continue-on-error'], undefined);
  const consumer = jobs['consumer-artifact'];
  assert.deepEqual(consumer.needs, ['consumer-candidate']);
  const download = consumer.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, 'consumer-candidate');
  assert.equal(download.if, undefined);
  const verify = consumer.steps.find(s => s.name === 'Verify consumer artifact');
  assert.equal(verify.env.CONSUMER_DIGEST, '${{ needs.consumer-candidate.outputs.sha256 }}');
  assert.equal(verify.env.CONSUMER_SOURCE, '${{ needs.consumer-candidate.outputs.source }}');
  assert.match(verify.run, /--expected-sha256 "\$env:CONSUMER_DIGEST" --expected-source "\$env:CONSUMER_SOURCE"/);
  assert.equal(verify.if, undefined); assert.equal(verify['continue-on-error'], undefined);
  assert.ok(!consumer.steps.some(s => /npm (?:ci|run build|pack)/.test(s.run ?? '')), 'Consumers must use the frozen archive without rebuilding');
}

test('all nine retained build and consumer rows bind the same independent archive and source outputs', () => {
  assertImmutableConsumerGraph(workflow);
  for (const mutate of [
    w => { w.jobs['consumer-artifact'].strategy.matrix.node.pop(); },
    w => { w.jobs['consumer-build-toolchains'].strategy.matrix.os.pop(); },
    w => { w.jobs['consumer-artifact'].steps.find(s => s.name === 'Verify consumer artifact').env.CONSUMER_DIGEST = 'archive supplied digest'; },
    w => { w.jobs['consumer-artifact'].steps.find(s => s.name === 'Verify consumer artifact').env.CONSUMER_SOURCE = '${{ github.sha }}'; },
    w => { w.jobs['consumer-artifact'].steps.push({run:'npm run build'}); },
    w => { w.jobs['consumer-candidate'].steps.find(s => s.id === 'pack').if = 'false'; },
    w => { w.jobs['windows-portability'].needs = w.jobs['windows-portability'].needs.filter(n => n !== 'consumer-build-toolchains'); },
  ]) {
    const changed = structuredClone(workflow); mutate(changed);
    assert.throws(() => assertImmutableConsumerGraph(changed));
  }
});
