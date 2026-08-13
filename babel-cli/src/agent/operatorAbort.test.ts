import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isOperatorAbortError } from './operatorAbort.js';

describe('isOperatorAbortError', () => {
  it('treats AbortError and "operation was aborted" as operator abort', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    assert.equal(isOperatorAbortError(abort), true);
    assert.equal(isOperatorAbortError(new Error('The operation was aborted.')), true);
    assert.equal(isOperatorAbortError('This operation was aborted'), true);
  });

  it('treats the live DeepSeek cancel wrap as operator abort', () => {
    assert.equal(
      isOperatorAbortError(new Error('[deepSeekApi] request cancelled (deepseek-v4-flash)')),
      true,
    );
  });

  it('does not treat remapped request timeouts or ordinary errors as abort', () => {
    const timeout = new Error('[deepSeekApi] request timeout after 120000ms (deepseek-v4-flash)');
    timeout.name = 'Error';
    assert.equal(isOperatorAbortError(timeout), false);
    assert.equal(
      isOperatorAbortError(new Error('[deepSeekApi] provider stream idle after 600000ms')),
      false,
    );
    assert.equal(isOperatorAbortError(new Error('upstream error')), false);
    assert.equal(isOperatorAbortError(null), false);
  });
});
