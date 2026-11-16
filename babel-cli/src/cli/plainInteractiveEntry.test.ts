import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlainInteractiveLaunch } from '../cliEntryDispatch.js';

test('only bare interactive invocations use the reduced registration path', () => {
  for (const tail of [[], ['interactive'], ['app']]) {
    assert.equal(isPlainInteractiveLaunch(['node', 'C:\\bin\\babel.js', ...tail]), true);
  }
  for (const tail of [
    ['--help'], ['--offline'], ['--connection', 'account'],
    ['interactive', '--mode', 'plan'], ['interactive', '--resume'],
    ['work', 'inspect'], ['provider', 'status'],
  ]) {
    assert.equal(isPlainInteractiveLaunch(['node', '/bin/babel.js', ...tail]), false, tail.join(' '));
  }
  for (const executable of ['bl', '/bin/bl.js', 'BABEL-LITE', 'C:\\bin\\babel-lite.js']) {
    assert.equal(isPlainInteractiveLaunch(['node', executable]), false, executable);
  }
  assert.equal(isPlainInteractiveLaunch(['node']), false);
});
