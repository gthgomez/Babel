/** PROPOSED NATIVE REGRESSIONS — NOT RUN during this review.
 * Copy into babel-cli/src/testinfra/pr242Audit.regression.test.ts in an isolated
 * checkout of the reviewed head. Run locally with the repository's installed tsx.
 * These import production modules; unlike probes/source_derived_probes.mjs,
 * they are intended to establish actual repository regressions.
 * Do not merge tests that assert defective behavior. These assert desired behavior
 * and are expected to fail on the reviewed head; that expectation is NOT a result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticIndexer, buildRepoMap } from '../services/indexer.js';
import { CostTracker } from '../services/costTracker.js';
import { actualRecoveryEdit } from '../agent/codingLoop/recoveryPlan.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-pr242-native-'));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('B242-02: project B directory cannot retain project A file content', async () => {
  const f = fixture();
  const a = join(f.root, 'a'); const b = join(f.root, 'b');
  const indexer = new SemanticIndexer(join(f.root, 'index', 'fts.db'));
  try {
    mkdirSync(join(a, 'src'), { recursive: true });
    mkdirSync(join(b, 'src', 'shared.ts'), { recursive: true });
    writeFileSync(join(a, 'src', 'shared.ts'), 'export const AlphaPrivateNeedle = 1;');
    writeFileSync(join(b, 'own.ts'), 'export const BetaOwnedNeedle = 2;');
    await indexer.indexProject(a);
    const result = await indexer.withProjectIndex(b, true, async () => ({
      foreign: indexer.search('AlphaPrivateNeedle'),
      owned: indexer.search('BetaOwnedNeedle'),
    }));
    assert.equal(result.foreign.length, 0, 'foreign content must never be attributed to B');
    assert.equal(result.owned.length, 1, 'empty output is not successful isolation');
  } finally { indexer.close(); f.close(); }
});

test('B242-03: restore cannot erase live unknown-only owner accounting', () => {
  const f = fixture();
  try {
    const tracker = new CostTracker(f.root);
    tracker.recordUnknownCharge('unlisted-provider-model', { taskOwnerId: 'A', chargeId: 'late-charge' });
    assert.equal(tracker.getTaskSummary('A').unknownChargeCount, 1);
    tracker.restoreTaskUsage('A', { totalCostUSD: 0, unknownChargeCount: 0, chargeIds: [] });
    assert.equal(tracker.getTaskSummary('A').unknownChargeCount, 1);
    assert.equal(tracker.getTaskSummary('A').costComplete, false);
    assert.deepEqual(tracker.getTaskChargeIds('A'), ['late-charge']);
  } finally { f.close(); }
});

test('B242-07: read-only access to a closed index cannot recreate the database', async () => {
  const f = fixture(); const root = join(f.root, 'project'); const dir = join(f.root, 'index');
  const db = join(dir, 'fts.db'); const indexer = new SemanticIndexer(db);
  try {
    mkdirSync(root); writeFileSync(join(root, 'file.ts'), 'export const OwnedNeedle = 1;');
    await indexer.indexProject(root); indexer.close();
    rmSync(dir, { recursive: true, force: true });
    await assert.rejects(indexer.withProjectIndex(root, false, async () => indexer.search('OwnedNeedle')));
    assert.equal(existsSync(db), false, 'read-only denial must happen before lazy database creation');
  } finally { indexer.close(); f.close(); }
});

test('B242-09: distinct literal newline bytes cannot share recovery identity', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'fixture.txt'), 'original');
    const crlf = actualRecoveryEdit({ type: 'write_file', path: 'fixture.txt', content: 'header\r\nvalue\r\n' }, f.root);
    const lf = actualRecoveryEdit({ type: 'write_file', path: 'fixture.txt', content: 'header\nvalue\n' }, f.root);
    assert.ok(crlf && lf);
    assert.notEqual(crlf.exactFingerprint, lf.exactFingerprint);
    assert.notEqual(crlf.editFingerprint, lf.editFingerprint);
  } finally { f.close(); }
});

test('B242-11: unrelated first files must not consume a target-scoped repo map', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'a.ts'), 'export const unrelatedA = 1;');
    writeFileSync(join(f.root, 'b.ts'), 'export const unrelatedB = 2;');
    mkdirSync(join(f.root, 'zzz', 'target'), { recursive: true });
    writeFileSync(join(f.root, 'zzz', 'target', 'fix.ts'), 'export function targetFix() { return 1; }');
    const map = await buildRepoMap(f.root, { target: 'zzz/target', limit: 2 });
    assert.deepEqual(map.entries.map(e => e.path), ['zzz/target/fix.ts']);
  } finally { f.close(); }
});
