import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createStructuredFinding,
  deduplicateFindings,
  computeFindingFingerprint,
  parseFindingFromModelClaim,
} from './structuredFinding.js';
import {
  verifyFindingStatically,
  verifyFindingAgainstSnapshot,
  corroborateFindings,
} from './findingVerifier.js';

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

test('structuredFinding: parseFindingFromModelClaim extracts location without synthesizing scope[0]', () => {
  const scope = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

  // Claim specifically references src/b.ts:42
  const p1 = parseFindingFromModelClaim('Buffer overflow in src/b.ts:42 when reading header', scope);
  assert.equal(p1.path, 'src/b.ts');
  assert.equal(p1.line, 42);
  assert.equal(p1.category, 'correctness');

  // Claim mentions security secret in src/c.ts line 15
  const p2 = parseFindingFromModelClaim('Hardcoded credential secret found in src/c.ts line 15', scope);
  assert.equal(p2.path, 'src/c.ts');
  assert.equal(p2.line, 15);
  assert.equal(p2.category, 'security');

  // Claim does NOT mention any file: must NOT synthesize scope[0] ('src/a.ts')
  const p3 = parseFindingFromModelClaim('General code quality issue without specified file', scope);
  assert.equal(p3.path, 'unspecified');
  assert.equal(p3.line, undefined);
});

test('findingVerifier: rejects hallucinated files or out-of-bounds lines statically and validates real locations', () => {
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
    // Location validation proves structural presence, not semantic truth
    assert.equal(verified.verification_status, 'LOCATION_VALID');
    assert.match(verified.evidence_refs?.[0] ?? '', /location_valid:static_location_verified/);

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
    assert.equal(rejectedScope.verification_status, 'LOCATION_INVALID');
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
    assert.equal(rejectedBounds.verification_status, 'LOCATION_INVALID');
    assert.match(rejectedBounds.evidence_refs?.[0] ?? '', /exceeds_total_lines/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('findingVerifier: corroborateFindings upgrades findings identified by multiple reviewers', () => {
  const f1 = createStructuredFinding({
    candidateDigest: 'a'.repeat(64),
    executionId: 'exec-1',
    reviewerId: 'reviewer-mimo',
    category: 'security',
    severity: 'P1',
    path: 'src/auth.ts',
    line: 10,
    claim: 'Missing token verification in auth header',
  });
  f1.verification_status = 'LOCATION_VALID';

  const f2 = createStructuredFinding({
    candidateDigest: 'a'.repeat(64),
    executionId: 'exec-2',
    reviewerId: 'reviewer-longcat',
    category: 'security',
    severity: 'P1',
    path: 'src/auth.ts',
    line: 10,
    claim: 'Authentication header lacks signature verification',
  });
  f2.verification_status = 'LOCATION_VALID';

  const corroborated = corroborateFindings([[f1], [f2]]);
  assert.equal(corroborated.length, 1);
  assert.equal(corroborated[0]!.verification_status, 'CORROBORATED');
  assert.equal(corroborated[0]!.verification_source, 'multi_reviewer_corroboration');
});
