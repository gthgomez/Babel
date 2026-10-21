import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ProviderInvocationCompleted } from '../../../runners/base.js'
import {
  EMPTY_VISIBLE_OUTPUT_DIGEST,
  providerInvokeDiagnosticsFromCompletion,
} from './providerInvokeDiagnosticsFromCompletion.js'

const NON_EMPTY_DIGEST = createHash('sha256').update('{"visible":"model text"}').digest('hex')
const ERROR_MATERIAL_DIGEST = createHash('sha256').update('provider normalization fault payload').digest(
  'hex',
)

function baseEvent(
  overrides: Partial<ProviderInvocationCompleted>,
): ProviderInvocationCompleted {
  return {
    inference_id: 'inf-visibility-regression',
    provider: 'openrouter',
    model: 'fixture/model',
    status: 'delivered',
    ...overrides,
  }
}

describe('providerInvokeDiagnosticsFromCompletion visibility provenance', () => {
  it('delivered SHA-256(empty) proves visible content absent with byte length zero', () => {
    const diagnostics = providerInvokeDiagnosticsFromCompletion(
      baseEvent({ output_digest: EMPTY_VISIBLE_OUTPUT_DIGEST }),
    )
    assert.equal(diagnostics.visible_content_present, false)
    assert.equal(diagnostics.visible_content_byte_length, 0)
    assert.equal(diagnostics.output_digest, EMPTY_VISIBLE_OUTPUT_DIGEST)
  })

  it('delivered non-empty digest proves visible content present without inventing byte length', () => {
    const diagnostics = providerInvokeDiagnosticsFromCompletion(
      baseEvent({ output_digest: NON_EMPTY_DIGEST }),
    )
    assert.equal(diagnostics.visible_content_present, true)
    assert.equal(diagnostics.visible_content_byte_length, undefined)
    assert.equal(diagnostics.output_digest, NON_EMPTY_DIGEST)
  })

  it('missing digest on delivered invocation leaves visibility unknown', () => {
    const event = baseEvent({})
    delete event.output_digest
    const diagnostics = providerInvokeDiagnosticsFromCompletion(event)
    assert.equal(diagnostics.visible_content_present, undefined)
    assert.equal(diagnostics.visible_content_byte_length, undefined)
    assert.equal(diagnostics.output_digest, undefined)
  })

  it('failed normalization digest does not assert visible model content', () => {
    const diagnostics = providerInvokeDiagnosticsFromCompletion(
      baseEvent({
        status: 'failed',
        output_digest: ERROR_MATERIAL_DIGEST,
        failure_stage: 'response_normalization',
      }),
    )
    assert.equal(diagnostics.visible_content_present, undefined)
    assert.equal(diagnostics.visible_content_byte_length, undefined)
    assert.equal(diagnostics.output_digest, ERROR_MATERIAL_DIGEST)
  })
})
