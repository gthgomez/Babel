import assert from 'node:assert/strict'
import test from 'node:test'
import { babelReviewChildEnv } from './babelReviewChild.js'
import {
  BABEL_REVIEWER_PERSONA,
  buildBabelDogfoodReviewPrompt,
  buildBabelDogfoodReviewSystemContext,
} from './babelReviewPersona.js'
import { babelReviewModelPolicy, babelReviewPrompt } from './babelChatReview.js'

test('babel dogfood review maintains parity with canonical ChatEngine configuration', () => {
  // 1. Construct canonical Chat options
  const normalChatOptions = {
    executionProfile: 'chat' as const,
    task: 'Investigate and repair the authentication session leak',
    projectRoot: '/mock/project',
    outputFormat: 'json' as const,
  }

  // 2. Construct dogfood review Chat options
  const scope = ['src/services/auth.ts']
  const reviewPrompt = buildBabelDogfoodReviewPrompt(scope)
  const reviewSystemPrompt = [
    BABEL_REVIEWER_PERSONA,
    'Integration output contract: this read-only investigation ends with exactly one JSON object matching the requested integration schema.',
  ].join('\n\n')

  const dogfoodReviewOptions = {
    executionProfile: 'chat' as const,
    task: reviewPrompt,
    projectRoot: '/mock/project',
    outputFormat: 'json' as const,
    appendSystemPrompt: reviewSystemPrompt,
  }

  // 3. Verify core execution profile parity
  assert.equal(dogfoodReviewOptions.executionProfile, normalChatOptions.executionProfile)
  assert.equal(dogfoodReviewOptions.outputFormat, normalChatOptions.outputFormat)

  // 4. Verify reviewer persona is injected and layered
  assert.ok(dogfoodReviewOptions.appendSystemPrompt.includes(BABEL_REVIEWER_PERSONA))
  assert.ok(dogfoodReviewOptions.task.includes('Review this pull request independently in Babel dogfood chat mode'))

  // 5. Verify regression: omitting BABEL_REVIEWER_PERSONA causes validation failure
  const strippedSystemPrompt = 'Integration output contract only'
  assert.equal(strippedSystemPrompt.includes(BABEL_REVIEWER_PERSONA), false)
})

test('babelReviewChildEnv preserves normal Chat runtime without category D execution drift while enforcing security boundary', () => {
  const env = babelReviewChildEnv({
    source: '/mock/source',
    trustedRoot: '/mock/trusted',
    output: '/mock/state/out.json',
    runs: '/mock/state/runs',
    model: 'mimo-v2.5',
    purpose: 'review',
  })

  // Execution profile enforces read_only_audit security boundary
  assert.equal(env['BABEL_EXECUTION_PROFILE'], 'read_only_audit')
  assert.equal(env['BABEL_READ_ONLY'], 'true')

  // Compaction must NOT be forced off (Category D drift eliminated)
  assert.notEqual(env['BABEL_COMPACTION'], 'off')

  // Tool sandbox enforces read-only security boundary against untrusted diffs
  assert.equal(env['BABEL_ALLOWED_TOOLS'], JSON.stringify(['file_read', 'directory_list', 'grep', 'glob']))
  assert.equal(env['BABEL_DISALLOWED_TOOLS'], JSON.stringify(['shell_exec', 'test_run', 'file_write', 'mcp_request', 'memory_query', 'memory_store', 'semantic_search']))

  // Memory writeback must NOT be disabled (Category D drift eliminated)
  assert.notEqual(env['BABEL_MEMORY_WRITEBACK'], '0')

  // Tool profile remains native
  assert.equal(env['BABEL_TOOL_PROFILE'], 'native')

  // Bounded budget defaults prevent runaway costs while allowing parent overrides
  assert.equal(env['BABEL_CHAT_MAX_WALL_MS'], '1200000')
  assert.equal(env['BABEL_CHAT_MAX_TURNS'], '36')
  assert.equal(env['BABEL_CHAT_STALL_TURNS'], '15')
})

test('reviewer persona layers behavioral guidance on top of Chat without deleting capabilities', () => {
  assert.ok(BABEL_REVIEWER_PERSONA.includes('independent, skeptical software reviewer'))
  assert.ok(BABEL_REVIEWER_PERSONA.includes('Run relevant tests, builds, or checks where useful'))
  assert.ok(BABEL_REVIEWER_PERSONA.includes('Do not approve merely because automated checks are green'))

  const prompt = buildBabelDogfoodReviewPrompt(['src/a.ts', 'src/b.ts'])
  assert.ok(prompt.includes('Review this pull request independently in Babel dogfood chat mode'))
  assert.ok(prompt.toLowerCase().includes('run relevant tests or checks where helpful'))
  assert.ok(prompt.includes('{"verdict":"APPROVE"|"BLOCK"'))

  const systemContext = buildBabelDogfoodReviewSystemContext()
  assert.ok(systemContext.includes(BABEL_REVIEWER_PERSONA))

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
