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
  projectFindingReview,
  buildVerifiedReviewFindings,
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
    symbol: 'dequeue', behavior: 'concurrent empty dequeue races',
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
    symbol: 'dequeue', behavior: 'concurrent empty dequeue races',
  });

  // Different instance IDs (different execution and claim text)
  assert.notEqual(f1.finding_instance_id, f2.finding_instance_id);

  // Exact same fingerprint! (same category, path, line, defectClass)
  assert.equal(f1.finding_fingerprint, f2.finding_fingerprint);

  // Deduplication collapses them into 1
  const deduped = deduplicateFindings([f1, f2]);
  assert.equal(deduped.length, 1);
});

test('canonical observations deduplicate whitespace variants without losing blocking status', t => {
  const root = join(tmpdir(), `babel-finding-duplicates-${Date.now()}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'source', 'src'), { recursive: true });
  writeFileSync(join(root, 'source', 'src', 'a.ts'), 'throw new Error("empty");\n');
  const findings = buildVerifiedReviewFindings({ candidateDigest: 'a'.repeat(64), executionId: 'review', reviewerId: 'reviewer',
    scope: ['src/a.ts'], snapshotRoot: root,
    verdict: { blocking_findings: ['src/a.ts:1 throws on empty input'], findings: [' src/a.ts:1 throws on empty input ', '\tsrc/a.ts:1 throws on empty input'] } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.policy_blocking, true);
});

test('canonical review exposes unresolved findings without calling location checks confirmation', () => {
  const finding = createStructuredFinding({ candidateDigest: 'a'.repeat(64), executionId: 'review',
    reviewerId: 'reviewer', category: 'security', severity: 'P1', path: 'unspecified', claim: 'possible authorization bypass' });
  const result = projectFindingReview({ verdict: 'APPROVE', uncertain: false }, [{ ...finding, verification_status: 'LOCATION_INVALID' }]);
  assert.equal(result.verdict, 'BLOCK');
  assert.match(result.blocking_findings[0]!, /LOCATION_INVALID.*semantic validation unavailable/);
  const locationOnly = projectFindingReview({ verdict: 'BLOCK', uncertain: false }, [{ ...finding, verification_status: 'LOCATION_VALID' }]);
  assert.match(locationOnly.blocking_findings[0]!, /LOCATION_VALID.*semantic validation unavailable/);
  assert.doesNotMatch(locationOnly.blocking_findings[0]!, /CONFIRMED|REPRODUCED/);
  assert.equal(projectFindingReview({ verdict: 'BLOCK', uncertain: true }, []).verdict, 'BLOCK');
});

test('finding identity preserves distinct bugs and path case while surviving line shifts', () => {
  const input = { candidateDigest: 'a'.repeat(64), executionId: 'first', reviewerId: 'reviewer',
    category: 'correctness' as const, severity: 'P1' as const, path: 'src/Queue.ts',
    symbol: 'dequeue', defectClass: 'empty_queue', behavior: 'throws when queue is empty',
    line: 10, claim: 'src/Queue.ts:10 throws on empty queue' };
  const first = createStructuredFinding(input);
  const moved = createStructuredFinding({ ...input, candidateDigest: 'b'.repeat(64), executionId: 'second',
    line: 30, claim: 'src/Queue.ts:30 throws on empty queue' });
  assert.equal(first.finding_fingerprint, moved.finding_fingerprint);
  assert.notEqual(first.finding_instance_id, moved.finding_instance_id);
  assert.notEqual(first.finding_fingerprint, createStructuredFinding({ ...input, path: 'src/queue.ts' }).finding_fingerprint);
  assert.notEqual(first.finding_fingerprint, createStructuredFinding({ ...input, behavior: 'drops the next queued item' }).finding_fingerprint);
  const { symbol: _symbol, defectClass: _class, behavior: _behavior, ...noIdentity } = input;
  assert.equal(deduplicateFindings([createStructuredFinding(noIdentity),
    createStructuredFinding({ ...noIdentity, claim: 'src/Queue.ts:10 drops another item' })]).length, 2);
  assert.equal(deduplicateFindings([createStructuredFinding({ ...noIdentity, claim: 'src/Queue.ts:10 rejects localhost:80' }),
    createStructuredFinding({ ...noIdentity, claim: 'src/Queue.ts:10 rejects localhost:443' })]).length, 2);
});

test('structuredFinding: parseFindingFromModelClaim extracts location without synthesizing scope[0]', () => {
  const scope = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

  // Claim specifically references src/b.ts:42
  const p1 = parseFindingFromModelClaim('Buffer overflow in src/b.ts:42 when reading header', scope);
  assert.equal(p1.path, 'src/b.ts');
  assert.equal(p1.line, 42);
  assert.equal(p1.category, 'correctness');

  // Claim references relative ./src/b.ts:42 or .\src/b.ts:42
  const p1Rel = parseFindingFromModelClaim('Buffer overflow in ./src/b.ts:42', scope);
  assert.equal(p1Rel.path, 'src/b.ts');
  assert.equal(p1Rel.line, 42);

  const p1Win = parseFindingFromModelClaim('Buffer overflow in .\\src/b.ts:42', scope);
  assert.equal(p1Win.path, 'src/b.ts');
  assert.equal(p1Win.line, 42);

  // Claim mentions security secret in src/c.ts line 15
  const p2 = parseFindingFromModelClaim('Hardcoded credential secret found in src/c.ts line 15', scope);
  assert.equal(p2.path, 'src/c.ts');
  assert.equal(p2.line, 15);
  assert.equal(p2.category, 'security');

  // Claim does NOT mention any file: must NOT synthesize scope[0] ('src/a.ts')
  const p3 = parseFindingFromModelClaim('General code quality issue without specified file', scope);
  assert.equal(p3.path, 'unspecified');
  assert.equal(p3.line, undefined);
  assert.equal(parseFindingFromModelClaim('src/A.ts:2 fails', ['src/a.ts', 'src/A.ts']).path, 'src/A.ts');
  assert.equal(parseFindingFromModelClaim('src/a.ts.backup:2 fails', ['src/a.ts']).path, 'unspecified');
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
    defectClass: 'missing_signature_verification',
    symbol: 'authenticate', behavior: 'missing signature verification',
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
    defectClass: 'missing_signature_verification',
    symbol: 'authenticate', behavior: 'missing signature verification',
  });
  f2.verification_status = 'LOCATION_VALID';

  const corroborated = corroborateFindings([[f1], [f2]]);
  assert.equal(corroborated.length, 1);
  assert.equal(corroborated[0]!.verification_status, 'CORROBORATED');
  assert.equal(corroborated[0]!.verification_source, 'multi_reviewer_corroboration');
});

test('findingVerifier: verifyFindingAgainstSnapshot fails closed with LOCATION_INVALID when scope is omitted', () => {
  const f = createStructuredFinding({
    candidateDigest: 'a'.repeat(64),
    executionId: 'exec-1',
    reviewerId: 'reviewer',
    category: 'correctness',
    severity: 'P1',
    path: 'src/file.ts',
    line: 1,
    claim: 'Issue without explicit scope',
  });
  const verified = verifyFindingAgainstSnapshot(f, '/nonexistent/root');
  assert.equal(verified.verification_status, 'LOCATION_INVALID');
  assert.match(verified.evidence_refs?.[0] ?? '', /path_not_in_candidate_scope/);
});

test('location verification preserves real source directories and rejects malformed ranges', t => {
  const root = join(tmpdir(), `babel-source-location-${Date.now()}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'source', 'source'), { recursive: true });
  writeFileSync(join(root, 'source', 'source', 'a.ts'), 'export const value = 1;\n');
  const input = { candidateDigest: 'a'.repeat(64), executionId: 'test', reviewerId: 'reviewer',
    category: 'correctness' as const, severity: 'P1' as const, path: 'source/a.ts', claim: 'source/a.ts has a defect' };
  const verify = (line: number, end_line?: number) => verifyFindingAgainstSnapshot(
    createStructuredFinding({ ...input, line, ...(end_line !== undefined ? { end_line } : {}) }), root, ['source/a.ts']);
  assert.equal(verify(1).verification_status, 'LOCATION_VALID');
  assert.equal(verify(0).verification_status, 'LOCATION_INVALID');
  assert.equal(verify(1, 999).verification_status, 'LOCATION_INVALID');
  assert.equal(verify(2, 1).verification_status, 'LOCATION_INVALID');
});
