import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compensatePatchWrites } from './agent/patchCompensation.js';
import { recordEffectIntent, recordEffectTerminal } from './executor/effectLedger.js';
import { captureEffectParentIdentity } from './executor/effectPathIdentity.js';
import { WorkspaceTransactionManager } from './services/workspaceTransactions.js';
import {
  __testOnlyBeforePartialAttest,
  __testOnlySetWriteUtf8ToFd,
  writeUtf8FileSafely,
  type TrustedFileCreationEvidence,
} from './sandboxFileWrites.js';
import {
  creationOwnershipFromTrustedEvidence,
  getTrustedFileCreationEvidence,
  SafeExecutor,
} from './sandbox.js';

const assertSafe = () => {};

const EXTERNAL = 'EXTERNAL_BEFORE_ATTEST\n';

test('concurrent pathname write before attestation must not bind ownership or delete external bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-partial-concurrency-'));
  const target = join(root, 'created.txt');
  const intended = 'created line 1\ncreated line 2\n';
  const prefix = intended.slice(0, 20);
  try {
    let evidence: TrustedFileCreationEvidence | undefined;
    __testOnlySetWriteUtf8ToFd((fd, content) => {
      if (content !== intended) {
        writeFileSync(fd, content, 'utf-8');
        return;
      }
      writeFileSync(fd, prefix, 'utf-8');
      throw new Error('truncated write fault');
    });
    __testOnlyBeforePartialAttest(({ targetPath }) => {
      assert.equal(targetPath, target);
      writeFileSync(targetPath, EXTERNAL);
    });
    try {
      assert.throws(
        () => writeUtf8FileSafely('created.txt', target, intended, true, assertSafe, {
          createOnly: true,
          onCreated: value => { evidence = value; },
        }),
        /truncated write fault/,
      );
    } finally {
      __testOnlySetWriteUtf8ToFd(null);
      __testOnlyBeforePartialAttest(null);
    }

    assert.equal(evidence?.settlementIncomplete, true);
    assert.equal(evidence?.unsettledSizeBytes, Buffer.byteLength(EXTERNAL));
    assert.equal(readFileSync(target, 'utf8'), EXTERNAL);
    assert.equal(creationOwnershipFromTrustedEvidence(evidence, target, intended), undefined);

    const st = await import('node:fs/promises').then(fs => fs.stat(target));
    const full = intended;
    const original = recordEffectIntent({
      runDir: root, sessionId: 'session', mutationBatchId: 'batch',
      effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [target],
      targetParentIdentities: { [target]: captureEffectParentIdentity(target) },
      preImageHashes: { [target]: WorkspaceTransactionManager.missingPathDigest() }, intendedContent: full,
    });
    recordEffectTerminal(root, original, { status: 'failed', error: 'partial settlement' });
    const rollback = await compensatePatchWrites([target], new Map(), new Set([target]),
      new Map([[target, full]]), new Map([[target, original]]),
      { runDir: root, runId: 'session', agentId: 'test', babelRoot: root });
    assert.equal(rollback.rolledBack.length, 0);
    assert.equal(readFileSync(target, 'utf8'), EXTERNAL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('genuine truncated write without concurrency preserves ambiguous partial file (no rollback success)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-partial-truncated-'));
  const target = join(root, 'created.txt');
  const intended = 'created line 1\ncreated line 2\n';
  const prefix = intended.slice(0, 20);
  try {
    __testOnlySetWriteUtf8ToFd((fd, content) => {
      if (content !== intended) {
        writeFileSync(fd, content, 'utf-8');
        return;
      }
      writeFileSync(fd, prefix, 'utf-8');
      throw new Error('truncated write fault');
    });
    try {
      const result = new SafeExecutor(root).fileWrite('file1.txt', intended, { createOnly: true });
      assert.equal(result.exit_code, 1);
      const evidence = getTrustedFileCreationEvidence(result);
      assert.equal(evidence?.settlementIncomplete, true);
      assert.equal(evidence?.unsettledSizeBytes, Buffer.byteLength(prefix));
      assert.equal(creationOwnershipFromTrustedEvidence(evidence, join(root, 'file1.txt'), intended), undefined);
      assert.equal(readFileSync(join(root, 'file1.txt'), 'utf8'), prefix);
    } finally {
      __testOnlySetWriteUtf8ToFd(null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completed create-only write still binds full intended ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-partial-full-'));
  const target = join(root, 'created.txt');
  const content = 'completed create\n';
  try {
    let evidence: TrustedFileCreationEvidence | undefined;
    writeUtf8FileSafely('created.txt', target, content, true, assertSafe, {
      createOnly: true,
      onCreated: value => { evidence = value; },
    });
    assert.equal(evidence?.settlementIncomplete, undefined);
    assert.equal(creationOwnershipFromTrustedEvidence(evidence, target, content)?.expectedContent, content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('post-attestation pathname replacement leaves file intact and ownership unsettled', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-partial-replace-'));
  const target = join(root, 'created.txt');
  const intended = 'created line 1\n';
  const prefix = intended.slice(0, 12);
  try {
    __testOnlySetWriteUtf8ToFd((fd, content) => {
      writeFileSync(fd, prefix, 'utf-8');
      throw new Error('truncated write fault');
    });
    try {
      let evidence: TrustedFileCreationEvidence | undefined;
      assert.throws(
        () => writeUtf8FileSafely('created.txt', target, intended, true, assertSafe, {
          createOnly: true,
          onCreated: value => { evidence = value; },
        }),
        /truncated write fault/,
      );
      writeFileSync(target, 'replacement after attestation\n');
      assert.equal(evidence?.settlementIncomplete, true);
      assert.equal(creationOwnershipFromTrustedEvidence(evidence, target, intended), undefined);
      assert.equal(readFileSync(target, 'utf8'), 'replacement after attestation\n');
    } finally {
      __testOnlySetWriteUtf8ToFd(null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
