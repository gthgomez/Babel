import assert from 'node:assert/strict';
import test from 'node:test';
import { getEncoding } from 'js-tiktoken';

import { TOKENIZER_ENCODING, countPromptManifestTokens, countTextTokens } from './tokenCounter.js';

test('tokenCounter uses deterministic o200k_base text counts', () => {
  const sample = 'Babel token accounting is deterministic.';
  const first = countTextTokens(sample);
  const second = countTextTokens(sample);

  assert.equal(TOKENIZER_ENCODING, 'o200k_base');
  assert.equal(first, second);
  assert.equal(first > 0, true);
  assert.equal(countTextTokens(`${sample} Extra words.`) > first, true);
});

test('lazy tokenization preserves the reference encoding for text and special tokens', () => {
  const reference = getEncoding('o200k_base');
  for (const text of ['', 'Hello, world!', '日本語 café 🙂', 'const n = 42;\r\n', 'abc '.repeat(1000)]) {
    assert.equal(countTextTokens(text), reference.encode(text).length);
    assert.equal(countTextTokens(text), reference.encode(text).length);
  }
  assert.throws(() => countTextTokens('<|endoftext|>'));
  assert.throws(() => reference.encode('<|endoftext|>'));
});

test('countPromptManifestTokens reports unavailable counts with warnings for missing paths', () => {
  const measurement = countPromptManifestTokens(
    ['Z:\\definitely\\missing\\babel-token-counter.md'],
    'runtime',
  );

  assert.equal(measurement.actualPromptTokens, null);
  assert.equal(measurement.tokenCountSource, 'unavailable');
  assert.deepEqual(measurement.actualTokenByEntry, {});
  assert.equal(measurement.warnings.length > 0, true);
});
