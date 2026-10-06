import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeOpenRouterModelMetadata,
  type OpenRouterModelEntry,
} from './openrouterMetadata.js'
import type { CapabilityObservation, ProtocolProfile } from './types.js'

/**
 * Evidence that asserts support for a capability, whether by explicit support
 * outcome or by claiming an advertised observation. A missing parameter must
 * never carry one of these.
 */
function supportedClaims(observation: CapabilityObservation): number {
  return (observation.evidence ?? []).filter(
    (entry) => entry.support === 'supported' || entry.state !== 'unknown',
  ).length
}

function normalizedProtocol(entry: OpenRouterModelEntry): {
  normalized: ReturnType<typeof normalizeOpenRouterModelMetadata>
  protocol: ProtocolProfile
} {
  const normalized = normalizeOpenRouterModelMetadata({
    requestedModel: entry.id,
    observedAt: '2026-10-06T00:00:00.000Z',
    entry,
  })
  const protocol = normalized.providerProfile.protocolProfiles[0]
  assert.ok(protocol)
  return { normalized, protocol }
}

test('missing_parameter_has_no_supported_evidence', () => {
  const { normalized, protocol } = normalizedProtocol({
    id: 'z-ai/glm-5.3-flash',
    supported_parameters: ['tools', 'tool_choice'],
  })

  // A parameter present in supported_parameters remains advertised; it is not
  // behaviorally verified merely because the API listed it.
  assert.equal(protocol.tools.basicTools.state, 'api_advertised')
  assert.equal(protocol.tools.basicTools.support, 'supported')
  assert.equal(protocol.tools.basicTools.confidence, 'high')
  for (const entry of protocol.tools.basicTools.evidence ?? []) {
    assert.equal(entry.state, 'api_advertised')
    assert.notEqual(entry.state, 'behaviorally_verified')
  }

  // A parameter absent from supported_parameters is unknown and must not carry
  // any evidence asserting support.
  const absentObservations: ReadonlyArray<readonly [string, CapabilityObservation]> = [
    ['parallel_tool_calls', protocol.tools.parallelTools],
    ['response_format', protocol.structuredOutput.jsonObjectMode],
    ['reasoning', protocol.reasoning.enabled],
  ]
  for (const [capability, observation] of absentObservations) {
    assert.equal(observation.state, 'unknown', `${capability} state`)
    assert.equal(observation.support, 'unknown', `${capability} support`)
    assert.equal(observation.confidence, 'unknown', `${capability} confidence`)
    assert.equal(
      supportedClaims(observation),
      0,
      `${capability} must not assert supported evidence`,
    )
  }

  // Native capability promises follow the same rule: absent means no Promise.
  assert.equal(normalized.labModel.nativeCapabilities.tools?.state, 'api_advertised')
  assert.equal(normalized.labModel.nativeCapabilities.structuredOutput, undefined)
})

test('absent_reasoning_metadata_has_no_supported_evidence', () => {
  const { protocol } = normalizedProtocol({
    id: 'z-ai/glm-5.3-flash',
    supported_parameters: ['tools'],
  })

  // `reasoning` is advertised only when the entry or parameter list says so.
  assert.equal(protocol.reasoning.enabled.state, 'unknown')
  assert.equal(supportedClaims(protocol.reasoning.enabled), 0)
})
