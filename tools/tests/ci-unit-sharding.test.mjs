import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

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
