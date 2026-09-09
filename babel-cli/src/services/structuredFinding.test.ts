import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createStructuredFinding,
  deduplicateFindings,
  computeFindingFingerprint,
} from './structuredFinding.js';
import { verifyFindingStatically } from './findingVerifier.js';

test('structuredFinding: generates distinct instance IDs and stable semantic fingerprints', () => {
  const f1 = createStructuredFinding({
    candidateDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    executionId: 'exec-1',
    reviewerId: 'mimo-v2.5',
    category: 'concurrency',
    severity: 'P1',
    path: 'src/state/queue.ts',
    line: 42,
    claim: 'Race condition when dequeuing empty items concurrently',
    defectClass: 'race_condition',
  });

  const f2 = createStructuredFinding({
    candidateDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    executionId: 'exec-2',
    reviewerId: 'longcat-2.0',
    category: 'concurrency',
    severity: 'P1',
    path: 'src/state/queue.ts',
    line: 42,
    claim: 'Different wording for the exact same race condition in queue',
    defectClass: 'race_condition',
  });

  // Different instance IDs (different execution and claim text)
  assert.notEqual(f1.finding_instance_id, f2.finding_instance_id);

  // Exact same fingerprint! (same category, path, line, defectClass)
  assert.equal(f1.finding_fingerprint, f2.finding_fingerprint);

  // Deduplication collapses them into 1
  const deduped = deduplicateFindings([f1, f2]);
  assert.equal(deduped.length, 1);
});

test('findingVerifier: rejects hallucinated files or out-of-bounds lines statically', () => {
  const tempDir = join(tmpdir(), `babel-test-verifier-${Date.now()}`);
  mkdirSync(join(tempDir, 'source', 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'source', 'src', 'valid.ts'), 'line 1\nline 2\nline 3\n');

  try {
    const validFinding = createStructuredFinding({
      candidateDigest: 'a'.repeat(64),
      executionId: 'exec-1',
      reviewerId: 'reviewer',
      category: 'correctness',
      severity: 'P1',
      path: 'src/valid.ts',
      line: 2,
      claim: 'Valid issue at line 2',
    });

    const verified = verifyFindingStatically(validFinding, {
      snapshotRoot: tempDir,
      scope: ['src/valid.ts'],
    });
    assert.equal(verified.verification_status, 'CONFIRMED');

    // Hallucinated file not in scope
    const notInScope = createStructuredFinding({
      candidateDigest: 'a'.repeat(64),
      executionId: 'exec-1',
      reviewerId: 'reviewer',
      category: 'correctness',
      severity: 'P1',
      path: 'src/hallucinated.ts',
      line: 1,
      claim: 'Phantom file',
    });
    const rejectedScope = verifyFindingStatically(notInScope, {
      snapshotRoot: tempDir,
      scope: ['src/valid.ts'],
    });
    assert.equal(rejectedScope.verification_status, 'REJECTED_FALSE_POSITIVE');
    assert.match(rejectedScope.evidence_refs?.[0] ?? '', /path_not_in_candidate_scope/);

    // Line out of bounds
    const outOfBounds = createStructuredFinding({
      candidateDigest: 'a'.repeat(64),
      executionId: 'exec-1',
      reviewerId: 'reviewer',
      category: 'correctness',
      severity: 'P1',
      path: 'src/valid.ts',
      line: 999,
      claim: 'Line 999 does not exist',
    });
    const rejectedBounds = verifyFindingStatically(outOfBounds, {
      snapshotRoot: tempDir,
      scope: ['src/valid.ts'],
    });
    assert.equal(rejectedBounds.verification_status, 'REJECTED_FALSE_POSITIVE');
    assert.match(rejectedBounds.evidence_refs?.[0] ?? '', /exceeds_total_lines/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
