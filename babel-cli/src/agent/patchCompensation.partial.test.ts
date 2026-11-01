import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compensatePatchWrites } from './patchCompensation.js';
import { recordEffectIntent, recordEffectTerminal } from '../executor/effectLedger.js';
import { captureEffectParentIdentity } from '../executor/effectPathIdentity.js';
import { WorkspaceTransactionManager } from '../services/workspaceTransactions.js';

test('compensation removes a host-attested full create when durable effect evidence matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-compensation-full-create-'));
  const path = join(root, 'created.txt');
  const full = 'created by this dispatch\n';
  try {
    writeFileSync(path, full);
    const st = statSync(path);
    const original = recordEffectIntent({
      runDir: root, sessionId: 'session', mutationBatchId: 'batch',
      effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
      targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
      preImageHashes: { [path]: WorkspaceTransactionManager.missingPathDigest() }, intendedContent: full,
    });
    recordEffectTerminal(root, original, { status: 'failed', error: 'dispatch reported failure after create' });
    const result = await compensatePatchWrites([path], new Map(), new Set([path]),
      new Map([[path, full]]), new Map([[path, original]]),
      { runDir: root, runId: 'session', agentId: 'test', babelRoot: root }, undefined,
      new Map([[path, {
        device: st.dev.toString(),
        inode: st.ino.toString(),
        expectedContent: full,
      }]]));
    assert.equal(result.rolledBack.length, 1);
    assert.equal(existsSync(path), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compensation refuses create rollback without trustworthy ownership (partial bytes on disk)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-compensation-partial-refuse-'));
  const path = join(root, 'created.txt');
  const full = 'created by this dispatch\n';
  const partial = full.slice(0, 10);
  try {
    writeFileSync(path, partial);
    const original = recordEffectIntent({
      runDir: root, sessionId: 'session', mutationBatchId: 'batch',
      effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
      targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
      preImageHashes: { [path]: WorkspaceTransactionManager.missingPathDigest() }, intendedContent: full,
    });
    recordEffectTerminal(root, original, { status: 'failed', error: 'partial orphan' });
    const result = await compensatePatchWrites([path], new Map(), new Set([path]),
      new Map([[path, full]]), new Map([[path, original]]),
      { runDir: root, runId: 'session', agentId: 'test', babelRoot: root });
    assert.equal(result.rolledBack.length, 0);
    assert.match(result.failures.join(), /not restored|identity/i);
    assert.equal(readFileSync(path, 'utf8'), partial);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
