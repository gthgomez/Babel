import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { summarizeRequiredTap } from '../../babel-cli/scripts/summarize_required_tap.mjs';

const implementation = new URL('../../babel-cli/scripts/run_ci_unit_shard.mjs', import.meta.url);
const prefix = 'tsx --no-warnings=ExperimentalWarning --import ./src/testinfra/register-no-ambient-inference.mjs --test ';
async function api() {
  assert.ok(existsSync(implementation), 'Missing exhaustive canonical unit sharding');
  return import(implementation);
}
function fixture(t, paths, patterns = ['src/*.test.ts', 'src/agent/**/*.test.ts']) {
  const root = mkdtempSync(join(tmpdir(), 'babel-ci-shard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '// controlled discovery fixture\n');
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': prefix + patterns.join(' ') } }));
  return root;
}

test('shards are disjoint and exhaust exactly the canonical direct and recursive patterns', async t => {
  const { prepareUnitShard } = await api();
  const expected = ['src/a.test.ts', 'src/b.test.ts', 'src/agent/c.test.ts', 'src/agent/nested/d.test.ts'].sort();
  const root = fixture(t, [...expected, 'src/ignored.ts', 'src/other/unused.test.ts']);
  const shards = Array.from({ length: 4 }, (_, index) => prepareUnitShard(root, index, 4));
  assert.deepEqual(shards[0].inventory, expected);
  const union = shards.flatMap(shard => shard.selected).sort();
  assert.deepEqual(union, expected);
  assert.equal(new Set(union).size, union.length);
  assert.ok(shards.every(shard => shard.selected.length === 1));
});

test('overlapping canonical globs never execute a file twice', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/agent/a.test.ts', 'src/agent/b.test.ts'], ['src/**/*.test.ts', 'src/agent/*.test.ts']);
  const shard = prepareUnitShard(root, 0, 1);
  assert.deepEqual(shard.selected, ['src/agent/a.test.ts', 'src/agent/b.test.ts']);
});

test('a zero-byte discovered test fails before launching a synthetic file-only result', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/a.test.ts'], ['src/*.test.ts']);
  writeFileSync(join(root, 'src/a.test.ts'), '');
  assert.throws(() => prepareUnitShard(root, 0, 1), /empty test file/);
});

test('canonical no-ambient inference loader and runner options survive sharding', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/a.test.ts'], ['src/*.test.ts']);
  const shard = prepareUnitShard(root, 0, 1);
  assert.deepEqual(shard.args, [
    '--no-warnings=ExperimentalWarning', '--import', './src/testinfra/register-no-ambient-inference.mjs',
    '--test-reporter=./scripts/required_tap_reporter.mjs', '--test-concurrency=1', '--test', 'src/a.test.ts',
  ]);
});

test('invalid shard coordinates and empty shards fail closed', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/a.test.ts'], ['src/*.test.ts']);
  for (const [index, count] of [[-1, 2], [2, 2], [0, 0], [0.5, 2], [0, 1.5], [0, 2]]) {
    assert.throws(() => prepareUnitShard(root, index, count), /shard/i);
  }
});

test('a missing canonical glob or empty total inventory fails instead of certifying incomplete coverage', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/a.test.ts'], ['src/*.test.ts', 'src/missing/*.test.ts']);
  assert.throws(() => prepareUnitShard(root, 0, 1), /matched no test files/);
  const empty = fixture(t, [], ['src/*.test.ts']);
  assert.throws(() => prepareUnitShard(empty, 0, 1), /matched no test files/);
});

test('unexpected runner and shell expressions fail rather than change the canonical selection', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/a.test.ts'], ['src/*.test.ts']);
  for (const script of ['node --test src/*.test.ts', prefix + 'src/*.test.ts && echo bypass', prefix + '"src/*.test.ts"', prefix + '../outside.test.ts']) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': script } }));
    assert.throws(() => prepareUnitShard(root, 0, 1), /canonical|pattern|command/i);
  }
});

test('inventory and selected manifests are stable and differ when the canonical inventory grows', async t => {
  const { prepareUnitShard } = await api();
  const root = fixture(t, ['src/a.test.ts'], ['src/*.test.ts']);
  const before = prepareUnitShard(root, 0, 1);
  assert.match(before.inventoryHash, /^[a-f0-9]{64}$/);
  assert.equal(before.inventoryHash, prepareUnitShard(root, 0, 1).inventoryHash);
  assert.equal(before.inventoryHash, before.selectionHash);
  writeFileSync(join(root, 'src/b.test.ts'), '// new canonical fixture\n');
  assert.notEqual(before.inventoryHash, prepareUnitShard(root, 0, 1).inventoryHash);
});

function runnableFixture(t, fails = false) {
  const base = mkdtempSync(join(tmpdir(), 'babel-ci-unit-capture-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'cli');
  for (const dir of ['scripts', 'src/testinfra', 'node_modules/tsx/dist']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'test:unit': prefix + 'src/*.test.ts' } }));
  // Relocate only the CLI entrypoint. The shared capture helper keeps its real
  // module location so Windows uses the existing native containment owner.
  const capture = new URL('../../babel-cli/scripts/run_logged_tap_child.mjs', import.meta.url).href;
  writeFileSync(join(root, 'scripts/run_ci_unit_shard.mjs'), readFileSync(implementation, 'utf8').replace("'./run_logged_tap_child.mjs'", JSON.stringify(capture)));
  writeFileSync(join(root, 'scripts/required_tap_reporter.mjs'), readFileSync(new URL('../../babel-cli/scripts/required_tap_reporter.mjs', import.meta.url)));
  writeFileSync(join(root, 'src/testinfra/register-no-ambient-inference.mjs'), '');
  writeFileSync(join(root, 'src/actual.test.ts'), `import test from 'node:test'; import { existsSync } from 'node:fs'; test('positive control', () => {}); test('actual disposable test', () => { if (existsSync('artifacts/ci-unit/full.tap')) throw Error('growing TAP must stay outside source capture'); ${fails ? "throw Error('intentional fixture failure')" : ''} });\n`);
  // This fixture needs no TypeScript transpilation. Forward the unchanged
  // canonical argv to Node's real test runner instead of emitting canned TAP.
  writeFileSync(join(root, 'node_modules/tsx/dist/cli.mjs'), `import { spawnSync } from 'node:child_process'; console.error('launcher diagnostic'); const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' }); process.exitCode = result.status ?? 1;\n`);
  return root;
}

for (const fails of [false, true]) test(`standalone shard retains raw TAP, stderr and truthful ${fails ? 'failure' : 'success'} evidence`, t => {
  const root = runnableFixture(t, fails);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const result = spawnSync(process.execPath, ['scripts/run_ci_unit_shard.mjs', '--shard-index', '0', '--shard-count', '1'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, fails ? 1 : 0, result.stderr);
  const artifacts = join(root, 'artifacts/ci-unit');
  assert.ok(existsSync(join(artifacts, 'full.tap')), 'standalone run must retain TAP without CI Tee-Object');
  const tap = readFileSync(join(artifacts, 'full.tap'), 'utf8');
  assert.ok(result.stdout.includes(tap), 'progress remains streamed to the caller');
  assert.ok(!tap.includes('launcher diagnostic'), 'stderr must not corrupt raw TAP');
  assert.match(readFileSync(join(artifacts, 'full.tap.stderr.log'), 'utf8'), /launcher diagnostic/);
  const summary = summarizeRequiredTap('unit', artifacts);
  assert.equal(summary.status, fails ? 'failed' : 'complete');
  assert.equal(summary.testCount, 2);
  assert.equal(summary.failed, fails ? 1 : 0);
  assert.equal(summary.selectedFileCount, 1);
  assert.deepEqual(summary.errors, []);
});

test('a failed launch replaces prior TAP and removes stale execution evidence', t => {
  const root = runnableFixture(t);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const run = () => spawnSync(process.execPath, ['scripts/run_ci_unit_shard.mjs', '--shard-index', '0', '--shard-count', '1'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(run().status, 0);
  const artifacts = join(root, 'artifacts/ci-unit');
  assert.equal(summarizeRequiredTap('unit', artifacts).status, 'complete');
  writeFileSync(join(root, 'node_modules/tsx/dist/cli.mjs'), "console.error('deliberate launch failure'); process.exitCode = 7;\n");
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(readFileSync(join(artifacts, 'full.tap'), 'utf8'), '');
  assert.equal(existsSync(join(artifacts, 'execution.json')), false);
  assert.equal(existsSync(join(artifacts, 'results.json')), false);
  assert.match(readFileSync(join(artifacts, 'full.tap.stderr.log'), 'utf8'), /deliberate launch failure/);
  assert.notEqual(summarizeRequiredTap('unit', artifacts).status, 'complete');
});

test('listing a shard does not launch tests or fabricate execution evidence', t => {
  const root = runnableFixture(t);
  const result = spawnSync(process.execPath, ['scripts/run_ci_unit_shard.mjs', '--shard-index', '0', '--shard-count', '1', '--list'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, 'artifacts/ci-unit/selection.json')));
  assert.equal(existsSync(join(root, 'artifacts/ci-unit/full.tap')), false);
  assert.equal(existsSync(join(root, 'artifacts/ci-unit/execution.json')), false);
  assert.equal(result.stderr, '');
});
