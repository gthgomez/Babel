import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_QUALIFIED_COMMAND_CODE_BINARY_M_CONTEXT,
  CAMPAIGN_QUALIFIED_COMMAND_CODE_DECIMAL_M_CONTEXT,
  CAMPAIGN_QUALIFIED_COMMAND_CODE_MAX_INPUT_CONTEXT_TOKENS,
  CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS,
  campaignQualifiedMaxInputContextTokens,
} from './campaign-qualified-context.js'
import {
  CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
} from './campaign-qualified-routes.js'

test('openrouter qualified route pins exact 1_048_576 input context', () => {
  assert.equal(CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS, 1_048_576)
  assert.equal(
    campaignQualifiedMaxInputContextTokens('openrouter', CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID),
    1_048_576,
  )
})

test('command code qualified route covers decimal and binary 1M readings conservatively', () => {
  assert.equal(CAMPAIGN_QUALIFIED_COMMAND_CODE_DECIMAL_M_CONTEXT, 1_000_000)
  assert.equal(CAMPAIGN_QUALIFIED_COMMAND_CODE_BINARY_M_CONTEXT, 1_048_576)
  assert.equal(
    CAMPAIGN_QUALIFIED_COMMAND_CODE_MAX_INPUT_CONTEXT_TOKENS,
    CAMPAIGN_QUALIFIED_COMMAND_CODE_BINARY_M_CONTEXT,
  )
  assert.equal(
    campaignQualifiedMaxInputContextTokens('command-code', CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID),
    1_048_576,
  )
})
