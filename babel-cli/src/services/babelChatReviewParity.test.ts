import assert from 'node:assert/strict'
import test from 'node:test'
import { babelReviewChildEnv } from './babelReviewChild.js'
import {
  BABEL_REVIEWER_PERSONA,
  buildBabelDogfoodReviewPrompt,
  buildBabelDogfoodReviewSystemContext,
  getBabelDogfoodChatConfig,
} from './babelReviewPersona.js'
import { babelReviewModelPolicy, babelReviewPrompt } from './babelChatReview.js'

test('babel dogfood review maintains parity with canonical ChatEngine configuration', () => {
  const config = getBabelDogfoodChatConfig()
  assert.equal(config.executionProfile, 'chat')
  assert.equal(config.compaction, 'normal')
  assert.equal(config.memoryWriteback, true)
  assert.equal(config.toolProfile, 'native')
  assert.equal(config.toolsStripped, false)
  assert.equal(config.personaLayered, true)
})

test('babelReviewChildEnv preserves normal Chat runtime without category D execution drift', () => {
  const env = babelReviewChildEnv({
    source: '/mock/source',
    trustedRoot: '/mock/trusted',
    output: '/mock/state/out.json',
    runs: '/mock/state/runs',
    model: 'mimo-v2.5',
    purpose: 'review',
  })

  // Execution profile is normal chat
  assert.equal(env['BABEL_EXECUTION_PROFILE'], 'chat')

  // Compaction must NOT be turned off
  assert.notEqual(env['BABEL_COMPACTION'], 'off')

  // Tools must NOT be stripped or constrained by review allowlists
  assert.equal(env['BABEL_ALLOWED_TOOLS'], undefined)
  assert.equal(env['BABEL_DISALLOWED_TOOLS'], undefined)

  // Memory writeback must NOT be disabled
  assert.notEqual(env['BABEL_MEMORY_WRITEBACK'], '0')

  // Tool profile remains native
  assert.equal(env['BABEL_TOOL_PROFILE'], 'native')
})

test('reviewer persona layers behavioral guidance on top of Chat without deleting capabilities', () => {
  assert.ok(BABEL_REVIEWER_PERSONA.includes('independent, skeptical software reviewer'))
  assert.ok(BABEL_REVIEWER_PERSONA.includes('Run relevant tests, builds, or checks where useful'))
  assert.ok(BABEL_REVIEWER_PERSONA.includes('Do not approve merely because automated checks are green'))

  const prompt = buildBabelDogfoodReviewPrompt(['src/a.ts', 'src/b.ts'])
  assert.ok(prompt.includes('Review this pull request independently in Babel dogfood chat mode'))
  assert.ok(prompt.toLowerCase().includes('run relevant tests or checks where helpful'))
  assert.ok(prompt.includes('{"verdict":"APPROVE"|"BLOCK"'))

  const legacyPrompt = babelReviewPrompt(['src/a.ts'])
  assert.ok(!legacyPrompt.includes('Do not execute candidate code, use shell, write files'))
})

test('model policy retains exact model and does not silence thinking or alter chat semantics', () => {
  const policy = babelReviewModelPolicy('mimo-v2.5', '/mock/trusted')
  assert.equal(policy.provider, 'opencode-go')
  assert.equal(policy.providerModelId, 'mimo-v2.5')
  assert.equal(policy.nativeToolUse, true)
  assert.equal(policy.enabled, true)
})
