import assert from 'node:assert/strict';
import test from 'node:test';

import { createExactInvariantsVerifier } from './verifierContract.js';

test('exact invariants verifier rejects echo spoof of npm test', async () => {
  const verifier = createExactInvariantsVerifier();
  const task = 'Fix the bug and run npm test before finishing.';
  const result = await verifier.verify({
    task,
    verb: 'fix',
    projectRoot: '/tmp/project',
    runDir: '/tmp/project/runs/test',
    toolCallLog: [
      {
        tool: 'shell_exec',
        input: { command: 'echo npm test' },
      },
    ],
  });

  const missing = result.checks.find((c) => c.id.startsWith('verifier_not_run_'));
  assert.ok(missing, 'expected warn when only a spoof command ran');
  assert.match(missing!.message, /npm test/);
});

test('exact invariants verifier accepts exact argv match', async () => {
  const verifier = createExactInvariantsVerifier();
  const result = await verifier.verify({
    task: 'Fix the bug and run npm test before finishing.',
    verb: 'fix',
    projectRoot: '/tmp/project',
    runDir: '/tmp/project/runs/test',
    toolCallLog: [
      {
        tool: 'shell_exec',
        input: { command: 'npm test' },
      },
    ],
  });

  const missing = result.checks.find((c) => c.id.startsWith('verifier_not_run_'));
  assert.equal(missing, undefined);
});
