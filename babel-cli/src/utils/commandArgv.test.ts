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

test('parseCommandArgv preserves quoted Windows UNC prefixes', () => {
  const command = String.raw`type "\\server\share\file.txt"`;
  assert.deepEqual(parseCommandArgv(command, 'win32'), [
    'type',
    String.raw`\\server\share\file.txt`,
  ]);
});

test('parseCommandArgv preserves empty Windows arguments', () => {
  assert.deepEqual(parseCommandArgv('node ""', 'win32'), ['node', '']);
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
  assert.equal(quoteWindowsCommandArg(''), '""');
});

test('Windows quoting round-trips trailing backslashes and embedded quotes', () => {
  const values = ['C:\\work tree\\', 'a"b', 'C:\\work tree\\"quoted"'];
  for (const value of values) {
    const command = `node ${quoteWindowsCommandArg(value)}`;
    assert.deepEqual(parseCommandArgv(command, 'win32'), ['node', value], value);
  }
});
