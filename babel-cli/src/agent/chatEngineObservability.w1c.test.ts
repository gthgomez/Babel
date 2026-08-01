/**
 * W1 C: collect fail after production patch → AGENT_FAILURE (failed-with-evidence).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computeTerminalOutcome,
  isVerifierCollectErrorText,
} from './chatEngineObservability.js';

describe('W1 C terminal outcome collect after patch', () => {
  test('isVerifierCollectErrorText detects conftest import failures', () => {
    assert.equal(
      isVerifierCollectErrorText(
        "ImportError while loading conftest\nModuleNotFoundError: No module named 'web'",
      ),
      true,
    );
    assert.equal(isVerifierCollectErrorText('AssertionError: expected 1'), false);
  });

  test('hasAnyWrites + collect ImportError → AGENT_FAILURE not BLOCKED_EXTERNAL', () => {
    const out = computeTerminalOutcome({
      finalStatus: 'blocked',
      budgetExceeded: false,
      hasAnyWrites: true,
      blockedReport: {
        reason: "ImportError while loading conftest: No module named 'web'",
      },
      lastVerifierReceipt: {
        command:
          'python -m pytest openlibrary/tests/core/test_wikidata.py::test_get_statement_values -v -x',
        exit_code: 4,
        summary: "ModuleNotFoundError: No module named 'web'",
      },
    });
    assert.equal(out, 'AGENT_FAILURE');
  });

  test('no writes + same ImportError remains BLOCKED_EXTERNAL', () => {
    const out = computeTerminalOutcome({
      finalStatus: 'blocked',
      budgetExceeded: false,
      hasAnyWrites: false,
      blockedReport: {
        reason: "ImportError while loading conftest: No module named 'web'",
      },
    });
    assert.equal(out, 'BLOCKED_EXTERNAL');
  });
});
