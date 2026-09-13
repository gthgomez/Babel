import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_REVIEWER_OPT_IN_ENV,
  ExternalReviewerNotAllowedError,
  assertReviewerScopeAllowed,
  createLiveIndependentReviewProvider,
} from './independentReviewProvider.js';

const DEFAULT_MODEL = 'configured-independent-reviewer';
const DEFAULT_PROVIDER = 'babel-primary-readonly-review';

test('default legacy reviewer scope is allowed without opt-in', () => {
  assert.doesNotThrow(() => assertReviewerScopeAllowed(DEFAULT_MODEL, DEFAULT_PROVIDER, {}));
  assert.doesNotThrow(() => createLiveIndependentReviewProvider({ projectRoot: '/tmp' }));
});

test('claude/anthropic reviewer model or provider requires explicit opt-in', () => {
  for (const [model, provider] of [
    ['claude-opus', DEFAULT_PROVIDER],
    ['claude-sonnet', DEFAULT_PROVIDER],
    ['anthropic/claude', DEFAULT_PROVIDER],
    [DEFAULT_MODEL, 'claude-bridge'],
    [DEFAULT_MODEL, 'anthropic-readonly-review'],
  ] as const) {
    assert.throws(
      () => assertReviewerScopeAllowed(model, provider, {}),
      (error: unknown) => error instanceof ExternalReviewerNotAllowedError && error.message.includes(EXTERNAL_REVIEWER_OPT_IN_ENV),
      `${model} / ${provider} must be refused`,
    );
  }
});

test('factory refuses an external reviewer unless explicitly opted in', () => {
  const previous = process.env[EXTERNAL_REVIEWER_OPT_IN_ENV];
  try {
    delete process.env[EXTERNAL_REVIEWER_OPT_IN_ENV];
    assert.throws(
      () => createLiveIndependentReviewProvider({ projectRoot: '/tmp', reviewerModel: 'claude-opus' }),
      ExternalReviewerNotAllowedError,
    );
    process.env[EXTERNAL_REVIEWER_OPT_IN_ENV] = '1';
    assert.doesNotThrow(() => createLiveIndependentReviewProvider({ projectRoot: '/tmp', reviewerModel: 'claude-opus' }));
  } finally {
    if (previous === undefined) delete process.env[EXTERNAL_REVIEWER_OPT_IN_ENV];
    else process.env[EXTERNAL_REVIEWER_OPT_IN_ENV] = previous;
  }
});
