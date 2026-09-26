import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type HostReviewHandoffV3,
  type IndependentReviewEvidenceV3,
  type IndependentReviewRuntime,
  assertSafeChallengeId,
  publicIndependentReviewHandoffV3,
  validateHostReviewHandoffV3,
  validateIndependentReviewEvidenceV3,
} from './independentReviewEvidenceV3.js'

function createValidEvidence(overrides?: Partial<IndependentReviewEvidenceV3>): IndependentReviewEvidenceV3 {
  const base: IndependentReviewEvidenceV3 = {
    schema_version: 3,
    kind: 'independent_agent_review_v3',
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    repository: 'gthgomez/Babel',
    pr_number: 180,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    candidate_digest: 'c'.repeat(64),
    diff_numstat_digest: 'd'.repeat(64),
    task_id: 'task-180',
    task_hash: 'e'.repeat(64),
    builder: {
      kind: 'codex',
      principal_id: 'codex-agent-builder-1',
      execution_id: 'codex-exec-builder-1',
    },
    reviewer: {
      kind: 'codex',
      principal_id: 'codex-agent-reviewer-2',
      execution_id: 'codex-exec-reviewer-2',
    },
    controller_run_id: 'controller-run-180',
    challenge_id: 'challenge-180-xyz',
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-subagent-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
      requested_provider: 'openai',
      observed_provider: 'openai',
      requested_model: 'gpt-5-codex',
      observed_model: 'gpt-5-codex-2026-08',
      model_attribution: 'observed',
    },
    review_mode: 'exact_diff',
    reviewed_at: new Date().toISOString(),
    scope: ['src/services/auth.ts', 'src/utils/crypto.ts'],
    verdict: 'APPROVE',
    findings: [],
    blocking_findings: [],
    isolation: {
      candidate_write: false,
      github_mutation: false,
      merge: false,
      controller_state_access: false,
    },
  }

  return { ...base, ...overrides }
}

test('independentReviewEvidenceV3: accepts same agent family with distinct principal and execution', () => {
  const evidence = createValidEvidence({
    builder: { kind: 'codex', principal_id: 'principal-A', execution_id: 'exec-A' },
    reviewer: { kind: 'codex', principal_id: 'principal-B', execution_id: 'exec-B' },
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-adapter-v1',
      controller_execution_id: 'exec-B',
    },
  })
  const validated = validateIndependentReviewEvidenceV3(evidence)
  assert.equal(validated.verdict, 'APPROVE')
})

test('independentReviewEvidenceV3: accepts different agent families (Claude -> Codex, Babel -> Codex, etc.)', () => {
  const claudeToCodex = createValidEvidence({
    builder: { kind: 'claude-code', principal_id: 'claude-p1', execution_id: 'claude-e1' },
    reviewer: { kind: 'codex', principal_id: 'codex-p2', execution_id: 'codex-e2' },
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-adapter-v1',
      controller_execution_id: 'codex-e2',
    },
  })
  assert.equal(validateIndependentReviewEvidenceV3(claudeToCodex).reviewer.kind, 'codex')

  const codexToClaude = createValidEvidence({
    builder: { kind: 'codex', principal_id: 'codex-p1', execution_id: 'codex-e1' },
    reviewer: { kind: 'claude-code', principal_id: 'claude-p2', execution_id: 'claude-e2' },
    runtime: {
      agent_kind: 'claude-code',
      adapter_id: 'claude-cli-v1',
      controller_execution_id: 'claude-e2',
      requested_provider: 'anthropic',
      observed_provider: 'anthropic',
    },
  })
  assert.equal(validateIndependentReviewEvidenceV3(codexToClaude).reviewer.kind, 'claude-code')
})

test('independentReviewEvidenceV3: accepts valid Babel reviewer with OpenCode-Go provider and version digest', () => {
  const babelEvidence = createValidEvidence({
    reviewer: { kind: 'babel', principal_id: 'babel-p2', execution_id: 'babel-e2' },
    runtime: {
      agent_kind: 'babel',
      adapter_id: 'babel-chat-v1',
      controller_execution_id: 'babel-e2',
      observed_provider: 'opencode-go',
      runtime_version: 'f'.repeat(64),
      requested_model: 'mimo-v2.5',
      observed_model: 'mimo-v2.5',
      model_attribution: 'observed',
    },
  })
  assert.equal(validateIndependentReviewEvidenceV3(babelEvidence).runtime.agent_kind, 'babel')
})

test('independentReviewEvidenceV3: accepts unknown/unavailable model attribution', () => {
  const unkModel = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-subagent-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
      observed_model: null,
      model_attribution: 'unavailable',
    },
  })
  assert.equal(validateIndependentReviewEvidenceV3(unkModel).runtime.model_attribution, 'unavailable')
})

test('independentReviewEvidenceV3: rejects matching principal ID', () => {
  const invalid = createValidEvidence({
    builder: { kind: 'codex', principal_id: 'same-principal', execution_id: 'exec-A' },
    reviewer: { kind: 'codex', principal_id: 'same-principal', execution_id: 'exec-B' },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(invalid), /REVIEWER_PRINCIPAL_NOT_INDEPENDENT/)
})

test('independentReviewEvidenceV3: rejects matching execution ID', () => {
  const invalid = createValidEvidence({
    builder: { kind: 'codex', principal_id: 'p-1', execution_id: 'same-exec' },
    reviewer: { kind: 'claude-code', principal_id: 'p-2', execution_id: 'same-exec' },
    runtime: {
      agent_kind: 'claude-code',
      adapter_id: 'claude-cli-v1',
      controller_execution_id: 'same-exec',
    },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(invalid), /REVIEWER_EXECUTION_NOT_DISTINCT/)
})

test('independentReviewEvidenceV3: rejects runtime controller execution ID mismatch', () => {
  const invalid = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-adapter-v1',
      controller_execution_id: 'invented-exec-id',
    },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(invalid), /RUNTIME_EXECUTION_ID_MISMATCH/)
})

test('independentReviewEvidenceV3: rejects external reviewer claiming OpenCode-Go provider or Babel adapter', () => {
  const badProvider = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-adapter-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
      observed_provider: 'opencode-go',
    },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(badProvider), /EXTERNAL_REVIEWER_CANNOT_CLAIM_OPENCODE_GO/)

  const badAdapter = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'babel-chat-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
    },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(badAdapter), /EXTERNAL_REVIEWER_CANNOT_CLAIM_BABEL_ADAPTER/)
})

test('independentReviewEvidenceV3: rejects Babel reviewer without OpenCode-Go or invalid version', () => {
  const badBabelProvider = createValidEvidence({
    reviewer: { kind: 'babel', principal_id: 'b-p2', execution_id: 'b-e2' },
    runtime: {
      agent_kind: 'babel',
      adapter_id: 'babel-chat-v1',
      controller_execution_id: 'b-e2',
      observed_provider: 'anthropic',
      runtime_version: '1'.repeat(64),
    },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(badBabelProvider), /BABEL_REVIEWER_MUST_USE_OPENCODE_GO/)

  const badBabelVersion = createValidEvidence({
    reviewer: { kind: 'babel', principal_id: 'b-p2', execution_id: 'b-e2' },
    runtime: {
      agent_kind: 'babel',
      adapter_id: 'babel-chat-v1',
      controller_execution_id: 'b-e2',
      observed_provider: 'opencode-go',
      runtime_version: 'short-version',
    },
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(badBabelVersion), /BABEL_REVIEWER_INVALID_VERSION_DIGEST/)
})

test('independentReviewEvidenceV3: rejects APPROVE verdict with blocking findings', () => {
  const invalid = createValidEvidence({
    verdict: 'APPROVE',
    blocking_findings: ['Found fatal security bypass in auth.ts:42'],
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(invalid), /APPROVE_VERDICT_CANNOT_HAVE_BLOCKING_FINDINGS/)
})

test('independentReviewEvidenceV3: rejects unsafe scope paths and scope mismatch', () => {
  const traversal = createValidEvidence({
    scope: ['../outside.ts'],
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(traversal), /UNSAFE_SCOPE_PATH/)

  const valid = createValidEvidence({ scope: ['src/a.ts'] })
  assert.throws(() => validateIndependentReviewEvidenceV3(valid, { candidateScope: ['src/b.ts'] }), /SCOPE_MISMATCH/)
})

test('independentReviewEvidenceV3: rejects stale or future reviews', () => {
  const past = createValidEvidence({
    reviewed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(past), /REVIEW_EVIDENCE_STALE_OR_FUTURE/)

  const future = createValidEvidence({
    reviewed_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(future), /REVIEW_EVIDENCE_STALE_OR_FUTURE/)
})

test('hostReviewHandoffV3: validates handoff and rejects duplicate reviewer identities', () => {
  const r1 = createValidEvidence({
    reviewer: { kind: 'codex', principal_id: 'p-1', execution_id: 'e-1' },
    runtime: { agent_kind: 'codex', adapter_id: 'a-1', controller_execution_id: 'e-1' },
  })
  const r2 = createValidEvidence({
    challenge_id: 'challenge-180-abc',
    reviewer: { kind: 'claude-code', principal_id: 'p-2', execution_id: 'e-2' },
    runtime: { agent_kind: 'claude-code', adapter_id: 'a-2', controller_execution_id: 'e-2' },
  })

  const validHandoff: HostReviewHandoffV3 = {
    schema_version: 3,
    kind: 'host_review_handoff_v3',
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    repository: r1.repository,
    pr_number: r1.pr_number,
    base_sha: r1.base_sha,
    head_sha: r1.head_sha,
    candidate_digest: r1.candidate_digest,
    diff_numstat_digest: r1.diff_numstat_digest,
    task_id: r1.task_id,
    task_hash: r1.task_hash,
    controller_run_id: r1.controller_run_id,
    reviews: [r1, r2],
  }

  const validated = validateHostReviewHandoffV3(validHandoff)
  assert.equal(validated.reviews.length, 2)

  // Duplicate reviewer principal must throw
  const dupPrincipalHandoff: HostReviewHandoffV3 = {
    ...validHandoff,
    reviews: [
      r1,
      createValidEvidence({
        challenge_id: 'challenge-180-dup-p',
        reviewer: { kind: 'claude-code', principal_id: 'p-1', execution_id: 'e-3' },
        runtime: { agent_kind: 'claude-code', adapter_id: 'a-2', controller_execution_id: 'e-3' },
      }),
    ],
  }
  assert.throws(() => validateHostReviewHandoffV3(dupPrincipalHandoff), /DUPLICATE_REVIEWER_PRINCIPAL/)

  // Duplicate reviewer execution must throw
  const dupExecutionHandoff: HostReviewHandoffV3 = {
    ...validHandoff,
    reviews: [
      r1,
      createValidEvidence({
        challenge_id: 'challenge-180-dup-e',
        reviewer: { kind: 'claude-code', principal_id: 'p-3', execution_id: 'e-1' },
        runtime: { agent_kind: 'claude-code', adapter_id: 'a-2', controller_execution_id: 'e-1' },
      }),
    ],
  }
  assert.throws(() => validateHostReviewHandoffV3(dupExecutionHandoff), /DUPLICATE_REVIEWER_EXECUTION/)

  // Duplicate challenge ID must throw
  const dupChallengeHandoff: HostReviewHandoffV3 = {
    ...validHandoff,
    reviews: [
      r1,
      createValidEvidence({
        challenge_id: r1.challenge_id,
        reviewer: { kind: 'claude-code', principal_id: 'p-4', execution_id: 'e-4' },
        runtime: { agent_kind: 'claude-code', adapter_id: 'a-2', controller_execution_id: 'e-4' },
      }),
    ],
  }
  assert.throws(() => validateHostReviewHandoffV3(dupChallengeHandoff), /DUPLICATE_CHALLENGE_ID/)

  // Public projection strips provenance
  const pub = publicIndependentReviewHandoffV3(validHandoff)
  assert.equal(pub['provenance'], undefined)
  assert.equal((pub['reviews'] as Array<Record<string, unknown>>)[0]!['provenance'], undefined)
  assert.equal((pub['reviews'] as Array<Record<string, unknown>>)[0]!['schema_version'], 3)
})

test('independentReviewEvidenceV3: enforces safe challenge ID rules', () => {
  assertSafeChallengeId('valid-challenge_123')
  assert.throws(() => assertSafeChallengeId('../escape'), /UNSAFE_CHALLENGE_ID/)
  assert.throws(() => assertSafeChallengeId('path/traversal'), /UNSAFE_CHALLENGE_ID/)
  assert.throws(() => assertSafeChallengeId('C:\\windows'), /UNSAFE_CHALLENGE_ID/)
  assert.throws(() => assertSafeChallengeId(''), /UNSAFE_CHALLENGE_ID/)
  assert.throws(() => assertSafeChallengeId('a'.repeat(129)), /UNSAFE_CHALLENGE_ID/)
  assert.throws(() => assertSafeChallengeId('has spaces'), /UNSAFE_CHALLENGE_ID/)
})

test('independentReviewEvidenceV3: rejects LOCAL_UNAUTHENTICATED when requireAuthoritative is set', () => {
  const unauthEvidence = createValidEvidence({ provenance: 'LOCAL_UNAUTHENTICATED' })
  // Valid when requireAuthoritative is false
  validateIndependentReviewEvidenceV3(unauthEvidence)

  // Throws when requireAuthoritative is true
  assert.throws(
    () => validateIndependentReviewEvidenceV3(unauthEvidence, { requireAuthoritative: true }),
    /LOCAL_UNAUTHENTICATED_EVIDENCE_CANNOT_SATISFY_AUTHORITY/
  )
})

test('independentReviewEvidenceV3: execution_purpose distinguishes certification from review and repair', () => {
  const certEvidence = createValidEvidence({
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    execution_purpose: 'FINAL_CERTIFICATION',
  })
  // Final certification satisfies authoritative requirements
  validateIndependentReviewEvidenceV3(certEvidence, { requireAuthoritative: true })

  const dogfoodEvidence = createValidEvidence({
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    execution_purpose: 'DOGFOOD_REVIEW',
  })
  // Valid as review evidence
  validateIndependentReviewEvidenceV3(dogfoodEvidence)
  // Rejection: review/repair cannot masquerade as final independent certification
  assert.throws(
    () => validateIndependentReviewEvidenceV3(dogfoodEvidence, { requireAuthoritative: true }),
    /NON_CERTIFICATION_EVIDENCE_CANNOT_SATISFY_AUTHORITY/
  )

  const repairEvidence = createValidEvidence({
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    execution_purpose: 'REVIEW_REPAIR',
  })
  assert.throws(
    () => validateIndependentReviewEvidenceV3(repairEvidence, { requireAuthoritative: true }),
    /NON_CERTIFICATION_EVIDENCE_CANNOT_SATISFY_AUTHORITY/
  )
})

test('independentReviewEvidenceV3: candidate repair producer cannot certify the candidate it modified', () => {
  const repairProducerExecutionId = 'exec-repair-agent-001'
  const certifierEvidence = createValidEvidence({
    reviewer: { kind: 'codex', principal_id: 'p-certifier', execution_id: repairProducerExecutionId },
    runtime: { agent_kind: 'codex', adapter_id: 'codex-adapter', controller_execution_id: repairProducerExecutionId },
    execution_purpose: 'FINAL_CERTIFICATION',
  })

  // Same execution that produced the repair cannot certify it
  assert.throws(
    () => validateIndependentReviewEvidenceV3(certifierEvidence, { producerExecutionId: repairProducerExecutionId }),
    /CANDIDATE_PRODUCER_CANNOT_CERTIFY/
  )

  // A fresh distinct execution CAN certify
  const freshExecutionId = 'exec-fresh-certifier-002'
  const freshCertifierEvidence = createValidEvidence({
    reviewer: { kind: 'codex', principal_id: 'p-certifier-fresh', execution_id: freshExecutionId },
    runtime: { agent_kind: 'codex', adapter_id: 'codex-adapter', controller_execution_id: freshExecutionId },
    execution_purpose: 'FINAL_CERTIFICATION',
  })
  validateIndependentReviewEvidenceV3(freshCertifierEvidence, { producerExecutionId: repairProducerExecutionId })
})

test('independentReviewEvidenceV3: mutation invalidates prior approval (approval(A) != approval(B))', () => {
  const candidateADigest = 'a'.repeat(64)
  const candidateBDigest = 'b'.repeat(64)

  const evidenceA = createValidEvidence({
    candidate_digest: candidateADigest,
    execution_purpose: 'FINAL_CERTIFICATION',
  })

  // Evidence for A fails validation against candidate B
  assert.throws(
    () => validateIndependentReviewEvidenceV3(evidenceA, { candidate_digest: candidateBDigest }),
    /CANDIDATE_BINDING_MISMATCH: candidate_digest/
  )
})

test('independentReviewEvidenceV3: accepts optional fresh context/process runtime fields', () => {
  const evidence = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-subagent-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
      fresh_context: true,
      fresh_process: true,
      parent_execution_id: 'x',
      session_id: 'y',
    },
  })

  const validated = validateIndependentReviewEvidenceV3(evidence)
  assert.equal(validated.runtime.fresh_context, true)
  assert.equal(validated.runtime.fresh_process, true)
  assert.equal(validated.runtime.parent_execution_id, 'x')
  assert.equal(validated.runtime.session_id, 'y')
})

test('independentReviewEvidenceV3: rejects non-boolean fresh_context', () => {
  const evidence = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-subagent-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
      fresh_context: 'yes',
    } as unknown as IndependentReviewRuntime,
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(evidence))
})

test('independentReviewEvidenceV3: still rejects unknown runtime fields (strictness preserved)', () => {
  const evidence = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-subagent-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
      unknown_runtime_field: 'nope',
    } as unknown as IndependentReviewRuntime,
  })
  assert.throws(() => validateIndependentReviewEvidenceV3(evidence))
})

test('independentReviewEvidenceV3: accepts minimal evidence without the new runtime fields', () => {
  const evidence = createValidEvidence({
    runtime: {
      agent_kind: 'codex',
      adapter_id: 'codex-subagent-v1',
      controller_execution_id: 'codex-exec-reviewer-2',
    },
  })
  const validated = validateIndependentReviewEvidenceV3(evidence)
  assert.equal(validated.runtime.fresh_context, undefined)
  assert.equal(validated.runtime.fresh_process, undefined)
  assert.equal(validated.runtime.parent_execution_id, undefined)
  assert.equal(validated.runtime.session_id, undefined)
})


