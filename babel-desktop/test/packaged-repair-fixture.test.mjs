// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createRepairFixture, assertRepairBaseline, assertRepairComplete, FIXED_PARSER,
} from './packaged-electron-acceptance/packaged-repair-fixture.mjs';

test('repair oracle distinguishes the red baseline, a scoped fix, and unrelated changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-repair-oracle-'));
  try {
    const project = join(root, 'project');
    await createRepairFixture(project);
    const baseline = await assertRepairBaseline(project);
    assert.equal(baseline.testExit, 1);
    await assert.rejects(assertRepairComplete(project), /independent test/);

    await writeFile(join(project, 'parser.mjs'), FIXED_PARSER, 'utf8');
    const repaired = await assertRepairComplete(project);
    assert.equal(repaired.testExit, 0);
    assert.deepEqual(repaired.diff, {path: 'parser.mjs', additions: 1, deletions: 1});
    assert.match(repaired.patch, /-export const add = \(a, b\) => a - b/);
    assert.match(repaired.patch, /\+export const add = \(a, b\) => a \+ b/);
    await assert.rejects(assertRepairBaseline(project), /baseline/);

    await writeFile(join(project, 'unexpected.txt'), 'unrelated\n', 'utf8');
    await assert.rejects(assertRepairComplete(project), /scoped diff/);
    assert.equal(await readFile(join(project, 'parser.mjs'), 'utf8'), FIXED_PARSER);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('repair oracle rejects a passing but out-of-scope change to the verifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-repair-control-'));
  try {
    const project = join(root, 'project');
    await createRepairFixture(project);
    await writeFile(join(project, 'verify.mjs'),
      "import test from 'node:test'\nfor (let i = 0; i < 4; i++) test(`fake-${i}`, () => {})\n", 'utf8');
    await assert.rejects(assertRepairComplete(project), /scoped diff/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
