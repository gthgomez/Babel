import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELIABILITY_REPAIR_PROOF_MARKER,
  buildStructuredOutputRetryPrompt,
  buildReliabilityRepairProofExecutorResponse,
  isStructuredOutputFailure,
} from './execute.js';

const executorPrompt = [
  `Reliability repair proof marker: ${RELIABILITY_REPAIR_PROOF_MARKER}`,
  'Approved SWE Plan targets src/math.js.',
  'Run node --test before completing.',
  '### EXECUTION HISTORY SO FAR:',
  '(No steps executed yet - this is the first turn.)',
].join('\n');

test('deterministic repair proof provider requires explicit env and task marker', () => {
  const previous = process.env['BABEL_RELIABILITY_REPAIR_PROOF'];
  delete process.env['BABEL_RELIABILITY_REPAIR_PROOF'];
  try {
    assert.equal(
      buildReliabilityRepairProofExecutorResponse(executorPrompt, { stage: 'executor' }),
      null,
    );

    process.env['BABEL_RELIABILITY_REPAIR_PROOF'] = 'true';
    assert.equal(
      buildReliabilityRepairProofExecutorResponse(
        executorPrompt.replace(RELIABILITY_REPAIR_PROOF_MARKER, 'ordinary task'),
        { stage: 'executor' },
      ),
      null,
    );

    const response = buildReliabilityRepairProofExecutorResponse(executorPrompt, {
      stage: 'executor',
    });
    assert.deepEqual(response, {
      type: 'tool_call',
      thinking:
        'Deterministic reliability proof model-boundary response: honor the approved preflight read before editing.',
      tool: 'file_read',
      path: 'src/math.js',
    });
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_RELIABILITY_REPAIR_PROOF'];
    } else {
      process.env['BABEL_RELIABILITY_REPAIR_PROOF'] = previous;
    }
  }
});

test('structured output failures get a schema-focused retry prompt', () => {
  const err = new Error('[deepInfraApi] Zod validation failed: minimal_action_set expected array');
  assert.equal(isStructuredOutputFailure(err), true);
  assert.equal(isStructuredOutputFailure(new Error('rate limit: 429')), false);

  const retryPrompt = buildStructuredOutputRetryPrompt('Return the plan JSON.', err);
  assert.match(retryPrompt, /BABEL STRUCTURED OUTPUT RETRY/);
  assert.match(retryPrompt, /Do not omit required arrays/);
  assert.match(retryPrompt, /minimal_action_set expected array/);
});
