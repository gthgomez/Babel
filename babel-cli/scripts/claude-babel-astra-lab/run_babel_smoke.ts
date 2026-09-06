import { resolve } from 'node:path';
import { createFixture, resetFixture } from '../../src/fixtures/claude-babel-astra-lab/fixtures.js';
import { runBabelLiveCase } from '../../src/claude-babel-astra-lab/babelHarness.js';

const fixture = createFixture('T1');
const outputRoot = resolve(process.cwd(), '..', 'benchmarks', 'claude-babel-astra-lab', 'smoke');
try {
  const result = await runBabelLiveCase({
    experimentId: 'claude-babel-astra-lab',
    pairId: 'smoke-mimo-t1',
    taskId: 'T1',
    profile: 'benchmark-mimo',
    model: 'mimo-v2.5',
    fixture,
    outputRoot,
    timeoutMs: 85_000,
  });
  const receipt = result.receipt;
  process.stdout.write(`${JSON.stringify({
    harness: receipt.HARNESS,
    provider: receipt.PROVIDER,
    requested_model: receipt.REQUESTED_MODEL,
    observed_model: receipt.OBSERVED_MODEL,
    base_sha: receipt.BASE_SHA,
    head_sha: receipt.HEAD_SHA,
    verifier: receipt.VERIFIER_RESULT,
    terminal: receipt.TERMINAL_CLAIM,
    raw_trajectory: receipt.RAW_TRAJECTORY_PATH,
    normalized_trajectory: receipt.NORMALIZED_TRAJECTORY_PATH,
    receipt: `${receipt.RECEIPT_HASH.slice(0, 12)}...`,
  })}\n`);
  if (receipt.PROVIDER !== 'opencode-go' || receipt.REQUESTED_MODEL !== 'mimo-v2.5' || receipt.OBSERVED_MODEL !== 'mimo-v2.5' || receipt.VERIFIER_RESULT !== 'PASS') process.exitCode = 1;
} finally {
  resetFixture(fixture);
}
