import assert from 'node:assert/strict';
import test from 'node:test';
import { babelReviewChildEnv } from './babelReviewChild.js';

test('review child strips publication credentials, preload hooks and ambient overrides', () => {
  const env = babelReviewChildEnv({ source: '/source', trustedRoot: '/trusted', output: '/state/out', runs: '/state/runs', model: 'mimo-v2.5' }, {
    PATH: '/bin', GH_TOKEN: 'synthetic', GITHUB_TOKEN: 'synthetic', NODE_OPTIONS: '--require malicious',
    OPENAI_API_KEY: 'synthetic', BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_ALLOWED_TOOLS: '["shell_exec"]',
  });
  assert.equal(env['GH_TOKEN'], undefined); assert.equal(env['GITHUB_TOKEN'], undefined);
  assert.equal(env['OPENAI_API_KEY'], undefined); assert.equal(env['NODE_OPTIONS'], undefined);
  assert.equal(env['BABEL_CHAT_MAX_COST'], 'unlimited');
  assert.equal(env['BABEL_EXECUTION_PROFILE'], 'read_only_audit');
  assert.ok(!env['BABEL_ALLOWED_TOOLS']!.includes('shell_exec'));
  assert.ok(!env['BABEL_ALLOWED_TOOLS']!.includes('semantic_search'));
  assert.equal(env['BABEL_READ_ONLY_NO_INDEX_WRITE'], '1');
});
