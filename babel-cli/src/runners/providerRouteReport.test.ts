import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveFamilyModelPolicy,
  resolveModelByKey,
} from '../modelPolicy.js'
import { buildProviderRouteReport } from '../runners/providerRouteReport.js'

test('vendor compatibility aliases expose requested and resolved identity', () => {
  for (const requested of ['claude', 'gemini', 'codex']) {
    const policy = resolveModelByKey({ key: requested })
    assert.equal(policy.requestedModelId, requested)
    assert.equal(policy.provider, 'deepseek')
    assert.equal(policy.providerModelId, 'deepseek-v4-flash')
    assert.equal(policy.aliasResolvedFrom, requested)
    assert.equal(policy.aliasResolvedTo, 'deepseek/deepseek-v4-flash')
    assert.match(policy.aliasNotice ?? '', /compatibility alias/)
    assert.ok(policy.warnings.some(warning => warning.includes('compatibility alias')))
  }
})

test('an explicit backend selection carries no alias claim', () => {
  const policy = resolveModelByKey({ key: 'deepseek-v4-flash' })
  assert.equal(policy.requestedModelId, 'deepseek-v4-flash')
  assert.equal(policy.aliasResolvedFrom, undefined)
  assert.equal(policy.aliasResolvedTo, undefined)
  assert.equal(policy.warnings.some(warning => warning.includes('compatibility alias')), false)
})

test('a vendor family name routed to another transport is disclosed', () => {
  const policy = resolveFamilyModelPolicy({ family: 'Claude' })
  assert.equal(policy.provider, 'deepseek')
  assert.match(policy.aliasNotice ?? '', /Requested family "Claude" is a compatibility route/)
  assert.ok(policy.warnings.some(warning => warning.includes(`not a "anthropic" model`)))
})

test('a matching family transport carries no compatibility warning', () => {
  const policy = resolveFamilyModelPolicy({ family: 'DeepSeek', requestedTier: 'cheap' })
  assert.equal(policy.provider, 'deepseek')
  assert.equal(policy.aliasNotice, undefined)
  assert.equal(policy.warnings.some(warning => warning.includes('compatibility route')), false)
})

test('route report separates configured capability from qualified capability', () => {
  const env = { DEEPSEEK_API_KEY: undefined } as NodeJS.ProcessEnv
  const report = buildProviderRouteReport({
    requestedModel: 'deepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    budgetUsd: 2,
    budgetSource: 'user',
    env,
  })
  assert.equal(report.requested_model, 'deepseek-v4-flash')
  assert.equal(report.resolved_provider, 'deepseek')
  assert.equal(report.capabilities.native_tool_stream, true)
  assert.equal(report.capabilities.native_tools_qualified, true)
  assert.equal(report.credential.required, true)
  assert.equal(report.credential.present, false)
  assert.equal(report.credential.variable, 'DEEPSEEK_API_KEY')
  assert.equal(report.budget.enforcement, 'standard-work-task-allowance')
  assert.deepEqual(report.budget.unsupported_lanes, ['plan', 'thorough work', 'apply'])
  assert.equal(report.connectivity, 'unverified')
  assert.equal(report.observed_model, null)
})

test('route report never marks a provider authenticated because it is configured', () => {
  const report = buildProviderRouteReport({
    provider: 'groq',
    model: 'fixture-model',
    env: { GROQ_API_KEY: 'synthetic-inert-value' } as NodeJS.ProcessEnv,
  })
  assert.equal(report.credential.present, true)
  assert.equal(report.capabilities.authority_conformance, 'untested')
  assert.equal(report.capabilities.native_tools_qualified, false)
  assert.equal(report.connectivity, 'unverified')
})

test('route report marks remote providers unusable offline and loopback Ollama usable', () => {
  const env = { BABEL_OFFLINE: '1' } as NodeJS.ProcessEnv
  const remote = buildProviderRouteReport({ provider: 'deepseek', model: 'deepseek-v4-flash', env })
  assert.equal(remote.offline.active, true)
  assert.equal(remote.offline.usable, false)
  assert.equal(remote.offline.provider_local, false)
  const local = buildProviderRouteReport({
    provider: 'ollama',
    model: 'llama3:8b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    env,
  })
  assert.equal(local.offline.usable, true)
  assert.equal(local.offline.provider_local, true)
})
