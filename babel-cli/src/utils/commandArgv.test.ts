import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommandArgvParseError,
  parseCommandArgv,
  quoteWindowsCommandArg,
} from './commandArgv.js';

test('parseCommandArgv preserves quoted whitespace and empty arguments', () => {
  assert.deepEqual(parseCommandArgv('node "path with spaces/app.js" \'\''), [
    'node',
    'path with spaces/app.js',
    '',
  ]);
});

test('parseCommandArgv preserves Windows backslashes', () => {
  assert.deepEqual(parseCommandArgv('node "C:\\work tree\\app.js"', 'win32'), [
    'node',
    'C:\\work tree\\app.js',
  ]);
});

test('parseCommandArgv rejects unterminated quotes', () => {
  assert.throws(
    () => parseCommandArgv('node "missing-close'),
    (error: unknown) => error instanceof CommandArgvParseError,
  );
});

test('quoteWindowsCommandArg quotes values needed by cmd.exe', () => {
  assert.equal(quoteWindowsCommandArg('path with spaces.txt'), '"path with spaces.txt"');
  assert.equal(quoteWindowsCommandArg('plain.txt'), 'plain.txt');
});
