import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createHostReviewController,
  type HostReviewCandidate,
  type HostReviewExecutionRequest,
  type HostReviewExecutionResult,
} from './hostReviewController.js'
import { validateBabelReviewCache } from './babelReviewQueue.js'

const candidate: HostReviewCandidate = {
  repository: 'gthgomez/Babel',
  pr_number: 152,
  task_id: 'task-152',
  task_hash: 'a'.repeat(64),
  base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
  builder_id: 'builder:astra-1',
  diff_numstat_digest: 'd'.repeat(64),
  scope: ['scripts/agent-pr-gate.ps1'],
}

function result(request: HostReviewExecutionRequest, overrides: Partial<HostReviewExecutionResult> = {}): HostReviewExecutionResult {
  return {
    controller_id: request.controller_id,
    controller_run_id: request.controller_run_id,
    execution_id: request.execution_id,
    status: 'COMPLETED',
    reviewed_candidate: { ...request.candidate },
    reviewer_id: 'reviewer:astra-2',
    review_provider: 'claude-code',
    reviewer_model: 'claude-test',
    reviewed_at: new Date().toISOString(),
    scope: [...request.candidate.scope],
    verdict: 'APPROVE',
    findings: [],
    blocking_findings: [],
    isolation: request.required_isolation,
    ...overrides,
  }
}

function createIdFactory(): () => string {
  let sequence = 0
  return () => `controller-id-${++sequence}`
}

describe('hostReviewController', () => {
  it('serializes only a controller-created exact candidate handoff', async () => {
    let received: HostReviewExecutionRequest | undefined
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => {
        received = request
        return result(request)
      } },
    })

    const handoff = await controller.review(candidate)

    assert.equal(received?.reviewer_class, 'independent_readonly_ai')
    assert.deepEqual(received?.required_isolation, {
      mode: 'text_only_no_tools', candidate_write: false, github_mutation: false, merge: false, controller_state_access: false,
    })
    assert.equal(handoff.kind, 'host_review_handoff_v2')
    assert.equal(handoff.task_hash, candidate.task_hash)
    assert.equal(handoff.reviews[0].diff_numstat_digest, candidate.diff_numstat_digest)
    assert.equal(handoff.reviews[0].execution_id, 'controller-id-2')
    assert.equal(handoff.reviews[0].review_provider, 'claude-code')
  })

  it('stamps controller provenance the strict cache validator admits at both levels', async () => {
    const version = 'e'.repeat(64)
    const sourceSha = 'f'.repeat(40)
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      isolation_mode: 'readonly_sandbox',
      adapter: { launch: async (request) => result(request, {
        reviewer_id: `babel-chat-mimo-v2.5-${request.execution_id}`,
        review_provider: 'opencode-go',
        reviewer_model: 'mimo-v2.5',
        isolation: { mode: 'readonly_sandbox', candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
        harness: { name: 'babel', mode: 'chat', version, source_sha: sourceSha, execution_id: request.execution_id },
      }) },
    })

    const handoff = await controller.review(candidate)
    // This is the exact regression: the controller stamps provenance on the
    // handoff and on each review, and the strict queue/cache schema must admit
    // both, or every fresh review round dies after the paid child completes.
    assert.equal(handoff.provenance, 'TRUSTED_CONTROLLER_EVIDENCE')
    assert.equal(handoff.reviews[0].provenance, 'TRUSTED_CONTROLLER_EVIDENCE')
    const validated = validateBabelReviewCache(handoff, { candidate, model: 'mimo-v2.5', round: 'controller-id-1', version, sourceSha })
    assert.equal(validated.provenance, 'TRUSTED_CONTROLLER_EVIDENCE')
    assert.equal(validated.reviews[0].provenance, 'TRUSTED_CONTROLLER_EVIDENCE')
  })

  it('rejects a fabricated result from another controller or execution', async () => {
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { controller_id: 'host-controller:other', execution_id: 'fabricated-execution' }) },
    })

    await assert.rejects(controller.review(candidate), /not produced for this controller launch/)
  })

  it('rejects a replayed result from an earlier controller launch', async () => {
    let first: HostReviewExecutionResult | undefined
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => {
        if (!first) {
          first = result(request)
          return first
        }
        return first
      } },
    })

    await controller.review(candidate)
    await assert.rejects(controller.review(candidate), /not produced for this controller launch/)
  })

  it('rejects a builder result and missing observed provider or model', async () => {
    const builderController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { reviewer_id: candidate.builder_id }) },
    })
    await assert.rejects(builderController.review(candidate), /distinct from builder/)

    const attributionController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { review_provider: '', reviewer_model: '' }) },
    })
    await assert.rejects(attributionController.review(candidate), /review_provider/)
  })

  it('rejects an adapter that does not report the required isolation', async () => {
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, {
        isolation: { ...request.required_isolation, candidate_write: true } as unknown as HostReviewExecutionResult['isolation'],
      }) },
    })

    await assert.rejects(controller.review(candidate), /isolation contract/)
  })

  it('rejects missing isolation booleans and UNKNOWN attribution', async () => {
    const isolationController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, {
        isolation: { ...request.required_isolation, github_mutation: undefined } as unknown as HostReviewExecutionResult['isolation'],
      }) },
    })
    await assert.rejects(isolationController.review(candidate), /isolation contract/)

    const unknownController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { review_provider: 'UNKNOWN', reviewer_model: 'unknown' }) },
    })
    await assert.rejects(unknownController.review(candidate), /review_provider cannot be UNKNOWN/)

    const unknownModelController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { reviewer_model: ' unknown ' }) },
    })
    await assert.rejects(unknownModelController.review(candidate), /reviewer_model cannot be UNKNOWN/)
  })

  it('rejects absolute and traversal forms in controller-provided scope', async () => {
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request) },
    })

    for (const unsafePath of ['/root/file', '\\server\\share', 'C:\\escape', 'dir/../escape', 'dir\\safe.ts', 'dir\\..\\escape']) {
      await assert.rejects(controller.review({ ...candidate, scope: [unsafePath] }), /unsafe path/)
    }
  })

  it('snapshots and freezes nested scope before the worker can mutate it', async () => {
    let mutationWasDenied = false
    const mutableCandidate = { ...candidate, scope: ['scripts/agent-pr-gate.ps1'] }
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => {
        try { (request.candidate.scope as string[]).push('forged.ts') } catch { mutationWasDenied = true }
        return result(request)
      } },
    })

    const handoff = await controller.review(mutableCandidate)
    mutableCandidate.scope.push('after-launch.ts')

    assert.equal(mutationWasDenied, true)
    assert.deepEqual(handoff.reviews[0].scope, ['scripts/agent-pr-gate.ps1'])
    assert.equal(Object.isFrozen(handoff.reviews[0].scope), true)
  })

  it('uses the entry snapshot when the original candidate mutates during an await', async () => {
    let release!: () => void
    let started!: () => void
    const waitForRelease = new Promise<void>((resolve) => { release = resolve })
    const workerStarted = new Promise<void>((resolve) => { started = resolve })
    const mutableCandidate: HostReviewCandidate = { ...candidate, scope: ['scripts/agent-pr-gate.ps1'] }
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => {
        started()
        await waitForRelease
        return result(request)
      } },
    })

    const pending = controller.review(mutableCandidate, 'GREEN')
    await workerStarted
    mutableCandidate.head_sha = 'e'.repeat(40)
    mutableCandidate.task_hash = 'f'.repeat(64)
    mutableCandidate.scope.push('after-await.ts')
    release()
    const handoff = await pending

    assert.equal(handoff.head_sha, candidate.head_sha)
    assert.equal(handoff.task_hash, candidate.task_hash)
    assert.deepEqual(handoff.reviews[0].scope, ['scripts/agent-pr-gate.ps1'])
  })

  it('rejects failed executions and a result bound to a stale head', async () => {
    const failedController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { status: 'FAILED' }) },
    })
    await assert.rejects(failedController.review(candidate), /did not complete/)

    const staleHeadController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { reviewed_candidate: { ...request.candidate, head_sha: 'e'.repeat(40) } }) },
    })
    await assert.rejects(staleHeadController.review(candidate), /exact candidate binding mismatch/)
  })

  it('rejects stale results and scopes that differ from the controller request', async () => {
    const staleController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      now: () => Date.parse('2026-09-07T00:30:00.000Z'),
      adapter: { launch: async (request) => result(request, { reviewed_at: '2026-09-07T00:00:00.000Z' }) },
    })
    await assert.rejects(staleController.review(candidate), /stale/)

    const scopeController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { scope: ['README.md'] }) },
    })
    await assert.rejects(scopeController.review(candidate), /scope does not match/)
  })

  it('serializes two distinct fresh reviews for RED and rejects a duplicate reviewer', async () => {
    let launches = 0
    const controller = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { reviewer_id: `reviewer:astra-${++launches}` }) },
    })

    const handoff = await controller.review(candidate, 'RED')

    assert.equal(handoff.reviews.length, 2)
    assert.notEqual(handoff.reviews[0].execution_id, handoff.reviews[1].execution_id)
    assert.notEqual(handoff.reviews[0].reviewer_id, handoff.reviews[1].reviewer_id)
    assert.equal(handoff.reviews[0].task_hash, handoff.reviews[1].task_hash)

    const duplicateController = createHostReviewController({
      controller_id: 'host-controller:primary',
      create_id: createIdFactory(),
      adapter: { launch: async (request) => result(request, { reviewer_id: 'reviewer:reused' }) },
    })
    await assert.rejects(duplicateController.review(candidate, 'RED'), /requires distinct reviewer identities/)
  })
})
