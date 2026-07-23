import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgString } from './cliArgParser.js';

describe('parseCliArgString', () => {
  it('parses basic space-separated args', () => {
    assert.deepEqual(parseCliArgString('--print --compact'), ['--print', '--compact']);
  });

  it('parses quoted arguments with spaces', () => {
    assert.deepEqual(parseCliArgString('--message "hello world" --name "Jane Doe"'), [
      '--message',
      'hello world',
      '--name',
      'Jane Doe',
    ]);
  });

  it('preserves empty quoted values', () => {
    assert.deepEqual(parseCliArgString('--label "" --mode "manual"'), [
      '--label',
      '',
      '--mode',
      'manual',
    ]);
  });

  it('parses escaped spaces outside quotes', () => {
    assert.deepEqual(parseCliArgString('--path C\\ Program\\ Files'), [
      '--path',
      'C Program Files',
    ]);
  });

  it('handles mixed single and double quotes', () => {
    assert.deepEqual(parseCliArgString(`--label 'single quoted' --path "double quoted"`), [
      '--label',
      'single quoted',
      '--path',
      'double quoted',
    ]);
  });

  it('supports escaped characters inside double quotes', () => {
    assert.deepEqual(parseCliArgString(`--message "value with \\"quotes\\""`), [
      '--message',
      'value with "quotes"',
    ]);
  });
});
