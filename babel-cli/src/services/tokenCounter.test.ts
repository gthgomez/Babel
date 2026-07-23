import assert from 'node:assert/strict';
import test from 'node:test';

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
