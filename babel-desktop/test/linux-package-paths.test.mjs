import test from 'node:test';
import assert from 'node:assert/strict';
import {containsPersonalBuildPath} from '../scripts/lib/linux-package-paths.mjs';

const hostedHome = ['', 'home', 'runner'].join('/');
const repo = [hostedHome, 'work', 'Babel', 'Babel'].join('/');
const output = [hostedHome, 'work', '_temp', 'linux-desktop-out'].join('/');

test('hosted runner home inside an upstream package is not this build path', () => {
  const vendor = Buffer.from([hostedHome, 'work', 'claude-cli-internal', 'pkg'].join('/'));
  const claude = 'resources/babel-runtime/cli/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
  assert.equal(containsPersonalBuildPath(claude, vendor, {home: hostedHome, repo, output}), false);
  assert.equal(containsPersonalBuildPath(claude, Buffer.concat([vendor, Buffer.from(repo)]), {home: hostedHome, repo, output}), true);
  assert.equal(containsPersonalBuildPath('resources/app/native/main.mjs', Buffer.from(output + '/leak'), {home: hostedHome, repo, output}), true);
});

test('a developer home path is still rejected', () => {
  const home = ['', 'srv', 'builder'].join('/');
  assert.equal(containsPersonalBuildPath('resources/app/native/main.mjs', Buffer.from(home + '/.ssh'), {home, repo: home + '/src'}), true);
  assert.equal(containsPersonalBuildPath('resources/app/native/main.mjs', Buffer.from('no paths here'), {home, repo: home + '/src'}), false);
});
