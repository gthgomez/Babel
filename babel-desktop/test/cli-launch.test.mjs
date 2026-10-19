import test from 'node:test';
import assert from 'node:assert/strict';
import { BABEL_NODE_WASM_ARGS, productionNodeCliArgv } from '../native/cli-launch.mjs';

test('productionNodeCliArgv prepends wasm bootstrap before the CLI entry', () => {
  const entry = '/abs/babel-cli/dist/index.js';
  assert.deepEqual(productionNodeCliArgv(entry, ['remote', 'host-run']), [
    ...BABEL_NODE_WASM_ARGS,
    entry,
    'remote',
    'host-run',
  ]);
});
