import test from 'node:test';
import assert from 'node:assert/strict';
import {containsPersonalBuildPath} from '../scripts/lib/linux-package-paths.mjs';

const scope = {home: '/home/runner', repo: '/home/runner/work/Babel/Babel'};
const claude = 'resources/babel-runtime/cli/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';

test('upstream Claude CI path is not this build machine path', () => {
  const bytes = Buffer.from('prefix /home/runner/work/claude-cli-internal/claude-cli-internal/node_modules suffix');
  assert.equal(containsPersonalBuildPath(claude, bytes, scope), false);
  assert.equal(containsPersonalBuildPath(claude, Buffer.concat([bytes, Buffer.from('/home/runner/work/Babel/Babel')]), scope), true);
  assert.equal(containsPersonalBuildPath('resources/app/native/main.mjs', Buffer.from('/home/runner/.ssh'), scope), true);
  assert.equal(containsPersonalBuildPath('resources/app/native/main.mjs', Buffer.from('no paths here'), scope), false);
});
