import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preferTrustedHostToolPathForTests } from './prefer-trusted-host-tool-path.mjs';

test('test bootstrap prefers trusted host tool PATH over exec-daemon shadow', () => {
  if (process.platform === 'win32') return;
  const previous = process.env.PATH;
  const previousOpt = process.env.BABEL_TEST_TRUSTED_HOST_TOOL_PATH;
  try {
    process.env.PATH = '/exec-daemon:/usr/bin:/bin';
    delete process.env.BABEL_TEST_TRUSTED_HOST_TOOL_PATH;
    preferTrustedHostToolPathForTests();
    assert.ok(process.env.PATH?.startsWith('/usr/bin:'), process.env.PATH);
    assert.equal(process.env.PATH?.includes('/exec-daemon'), false);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    if (previousOpt === undefined) delete process.env.BABEL_TEST_TRUSTED_HOST_TOOL_PATH;
    else process.env.BABEL_TEST_TRUSTED_HOST_TOOL_PATH = previousOpt;
  }
});
