import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256Canonical } from '../acceptance/canonical.js';
import {
  classifyReceiptKind,
  ReceiptIndex,
  RECEIPT_INDEX_FILENAME,
} from './receiptIndex.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'babel-receipt-index-'));
}

test('P07 receipt index: lookup survives a host restart', () => {
  const dir = tempDir();
  try {
    const first = ReceiptIndex.open({ directory: dir });
    const recorded = first.recordReceipt({
      receipt_id: 'receipt-1',
      payload: { receiptId: 'receipt-1', exitCode: 0, stale: false },
      recorded_at: '2026-09-19T00:00:00.000Z',
    });
    assert.equal(recorded.ok, true);

    // Simulate a fresh host: a brand-new instance reads the persisted document.
    const reopened = ReceiptIndex.open({ directory: dir });
    const lookup = reopened.lookup('receipt-1');
    assert.equal(lookup.status, 'available');
    if (lookup.status === 'available') {
      assert.equal(lookup.receipt.receipt_id, 'receipt-1');
      assert.equal(lookup.receipt.content_hash, sha256Canonical({ receiptId: 'receipt-1', exitCode: 0, stale: false }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: a missing object resolves to explicit unavailable, never regenerated', () => {
  const dir = tempDir();
  try {
    const index = ReceiptIndex.open({ directory: dir });
    const missing = index.lookup('does-not-exist');
    assert.equal(missing.status, 'unavailable');
    if (missing.status === 'unavailable') {
      assert.equal(missing.reason, 'not_recorded');
      assert.equal('receipt' in missing, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: old receipt adapter preserves legacy payloads verbatim', () => {
  const dir = tempDir();
  try {
    const index = ReceiptIndex.open({ directory: dir });
    const legacy = { command: 'npm test', exit_code: 0, summary: 'ok' };
    const result = index.recordReceipt({ receipt_id: 'legacy-1', payload: legacy });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.kind, 'legacy_receipt');
      assert.deepEqual(result.record.payload, legacy);
      assert.equal(result.record.content_hash, sha256Canonical(legacy));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: re-recording the same identity and payload is idempotent', () => {
  const dir = tempDir();
  try {
    const index = ReceiptIndex.open({ directory: dir });
    const payload = { receiptId: 'r', boundRevision: { fileHashes: {} }, stale: false };
    const first = index.recordReceipt({ receipt_id: 'r', payload });
    const second = index.recordReceipt({ receipt_id: 'r', payload });
    assert.equal(first.ok && first.created, true);
    assert.equal(second.ok && second.created, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: a conflicting payload for an existing identity is refused', () => {
  const dir = tempDir();
  try {
    const index = ReceiptIndex.open({ directory: dir });
    index.recordReceipt({ receipt_id: 'r', payload: { exit_code: 0 } });
    const conflict = index.recordReceipt({ receipt_id: 'r', payload: { exit_code: 1 } });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, 'conflicting_receipt_identity');
    // The original is untouched.
    const lookup = index.lookup('r');
    assert.equal(lookup.status, 'available');
    if (lookup.status === 'available')
      assert.deepEqual(lookup.receipt.payload, { exit_code: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: a tampered document opens as inconsistent and disables lookups', () => {
  const dir = tempDir();
  try {
    const index = ReceiptIndex.open({ directory: dir });
    index.recordReceipt({ receipt_id: 'r', payload: { exit_code: 0 } });
    const file = join(dir, RECEIPT_INDEX_FILENAME);
    const document = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: Array<{ content_hash: string }>;
    };
    // Mutate the payload without updating the content hash.
    document.entries[0]!.content_hash = 'f'.repeat(64);
    writeFileSync(file, JSON.stringify(document), 'utf8');

    const reopened = ReceiptIndex.open({ directory: dir });
    assert.equal(reopened.status().consistent, false);
    const lookup = reopened.lookup('r');
    assert.equal(lookup.status, 'unavailable');
    if (lookup.status === 'unavailable')
      assert.equal(lookup.reason, 'index_inconsistent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: corrupt JSON opens as an inconsistent empty index', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, RECEIPT_INDEX_FILENAME), '{not json', 'utf8');
    const index = ReceiptIndex.open({ directory: dir });
    assert.equal(index.status().consistent, false);
    assert.equal(index.size(), 0);
    assert.equal(index.lookup('anything').status, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 receipt index: classifyReceiptKind is descriptive only', () => {
  assert.equal(
    classifyReceiptKind({ receiptId: 'x', boundRevision: { fileHashes: {} }, stale: false }),
    'verifier_receipt',
  );
  assert.equal(
    classifyReceiptKind({ requestedOutcome: 'A', finalOutcome: 'B', allowed: true }),
    'completion_decision',
  );
  assert.equal(
    classifyReceiptKind({ receiptId: 'x', status: 'settled' }),
    'execution_receipt',
  );
  assert.equal(classifyReceiptKind({ summary: 'legacy' }), 'legacy_receipt');
});
