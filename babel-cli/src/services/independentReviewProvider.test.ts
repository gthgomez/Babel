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

type ReviewerEnvKey = 'BABEL_REVIEWER_MODEL' | typeof EXTERNAL_REVIEWER_OPT_IN_ENV;
const REVIEWER_ENV_KEYS: readonly ReviewerEnvKey[] = ['BABEL_REVIEWER_MODEL', EXTERNAL_REVIEWER_OPT_IN_ENV];

/**
 * Isolate assertions from ambient reviewer configuration: both vars are cleared
 * (then optionally overridden) and restored so the result cannot depend on the
 * shell the test happens to run in.
 */
function withCleanReviewerEnv(
  run: () => void,
  overrides: Partial<Record<ReviewerEnvKey, string>> = {},
): void {
  const previous = new Map<ReviewerEnvKey, string | undefined>();
  for (const key of REVIEWER_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    run();
  } finally {
    for (const key of REVIEWER_ENV_KEYS) {
      const prev = previous.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

test('default legacy reviewer scope is allowed without opt-in', () => {
  assert.doesNotThrow(() => assertReviewerScopeAllowed(DEFAULT_MODEL, DEFAULT_PROVIDER, {}));
  withCleanReviewerEnv(() => {
    assert.doesNotThrow(() => createLiveIndependentReviewProvider({ projectRoot: '/tmp' }));
  });
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
  withCleanReviewerEnv(() => {
    assert.throws(
      () => createLiveIndependentReviewProvider({ projectRoot: '/tmp', reviewerModel: 'claude-opus' }),
      ExternalReviewerNotAllowedError,
    );
  });
  withCleanReviewerEnv(
    () => {
      assert.doesNotThrow(() => createLiveIndependentReviewProvider({ projectRoot: '/tmp', reviewerModel: 'claude-opus' }));
    },
    { [EXTERNAL_REVIEWER_OPT_IN_ENV]: '1' },
  );
});
