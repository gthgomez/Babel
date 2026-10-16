import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStructuredFinding } from './structuredFinding.js'
import { applyFindingAssessments, parseFindingValidation, findingValidationPrompt, validateFindingValidationArtifact } from './babelFindingValidation.js'

const finding = createStructuredFinding({ candidateDigest: 'a'.repeat(64), executionId: 'original',
  reviewerId: 'original', category: 'correctness', severity: 'P1', path: 'src/a.ts', line: 1, claim: 'throws on empty input' })
const assessment = { finding_instance_id: finding.finding_instance_id, disposition: 'supported' as const,
  reason: 'empty input reaches the throw', evidence: [{ path: 'src/a.ts', line: 1, excerpt: 'throw new Error("empty")' }] }
const payload = (assessments: unknown[]) => ({ mode: 'chat', terminal_outcome: 'NO_CHANGE_REQUIRED', write_count: 0,
  answer: { answer: JSON.stringify({ assessments }) } })

test('fresh validation requires exact findings, source evidence, and read-only completion', () => {
  assert.deepEqual(parseFindingValidation(payload([assessment]), [finding]), [assessment])
  for (const values of [[], [assessment, assessment], [{ ...assessment, finding_instance_id: 'b'.repeat(64) }]]) {
    assert.throws(() => parseFindingValidation(payload(values), [finding]), /SCOPE_MISMATCH/)
  }
  assert.throws(() => parseFindingValidation(payload([{ ...assessment, evidence: [] }]), [finding]), /EVIDENCE_MISSING/)
  assert.throws(() => parseFindingValidation({ ...payload([assessment]), write_count: 1 }, [finding]), /NOT_COMPLETED/)
  assert.match(findingValidationPrompt(), /cannot run code or tests/)
})

test('validation artifacts bind exact execution and observed model and retain failures', () => {
  const artifact = { schema_version: 1, harness: 'babel', mode: 'chat', purpose: 'finding_validation',
    status: 'finding_validation_completed', execution_id: 'fresh', model: 'mimo-v2.5',
    payload: payload([assessment]), assessments: [assessment], calls: [{ status: 'completed', metadata: { provider: 'opencode-go', observed_model_id: 'mimo-v2.5' } }] }
  const expected = { executionId: 'fresh', model: 'mimo-v2.5', findings: [finding] }
  assert.deepEqual(validateFindingValidationArtifact(artifact, expected), [assessment])
  assert.throws(() => validateFindingValidationArtifact({ ...artifact, execution_id: 'original' }, expected))
  assert.throws(() => validateFindingValidationArtifact({ ...artifact, model: 'another' }, expected))
  assert.throws(() => validateFindingValidationArtifact({ ...artifact, calls: [{ ...artifact.calls[0], status: 'failed' }] }, expected))
  assert.throws(() => validateFindingValidationArtifact({ ...artifact, assessments: [{ ...assessment, disposition: 'refuted' }] }, expected), /ARTIFACT_MISMATCH/)
})

test('source support cannot promote invalid locations, mismatched citations, or claim reproduction', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-finding-validation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'source', 'src'), { recursive: true })
  writeFileSync(join(root, 'source', 'src/a.ts'), assessment.evidence[0]!.excerpt + '\n')
  const located = { ...finding, verification_status: 'LOCATION_VALID' as const }
  const supported = applyFindingAssessments([located], [assessment], root, 'fresh')[0]!
  assert.equal(supported.verification_status, 'SOURCE_SUPPORTED')
  assert.ok(supported.evidence_refs?.includes('reproduction:unavailable_readonly_reviewer'))
  assert.equal(applyFindingAssessments([{ ...finding, verification_status: 'LOCATION_INVALID' }], [assessment], root, 'fresh')[0]!.verification_status, 'INCONCLUSIVE')
  assert.equal(applyFindingAssessments([located], [{ ...assessment, evidence: [{ ...assessment.evidence[0]!, excerpt: 'invented' }] }], root, 'fresh')[0]!.verification_status, 'INCONCLUSIVE')
  assert.equal(applyFindingAssessments([located], [{ ...assessment, disposition: 'refuted' }], root, 'fresh')[0]!.verification_status, 'SOURCE_REFUTED')
})
