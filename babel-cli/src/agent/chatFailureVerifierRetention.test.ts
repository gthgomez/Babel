/** TF-14 — a later provider failure must not erase a known red verifier. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { consumeChatStream } from '../interactive/execution/chatCore.js';
import { failureExplanationWithKnownVerifierState } from './chatEngineTerminalRuntime.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { loadThreadEventLogFromDir } from './threadEventLog.js';
import type { ToolStreamEvent } from '../runners/base.js';
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';

const redReceipt: BoundChatVerifierReceipt = {
  command: 'npm test',
  exit_code: 1,
  summary: '1 failing test',
  stale: false,
  authority: true,
} as BoundChatVerifierReceipt;

function installRunner(
  engine: ChatEngine,
  stream: () => AsyncGenerator<ToolStreamEvent, void, undefined>,
): void {
  const target = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  const runner = {
    executeWithToolsStream: stream,
    execute: async () => ({ type: 'completion', answer: 'x' }),
    getLastInvocationMetadata: () => null,
  };
  target.deliberationRunner = runner;
  target.synthesisRunner = runner;
  target.shouldUseNativeTools = () => true;
}

describe('TF-14 known red verifier retention', () => {
  test('failure explanation retains the earlier red check', () => {
    const text = failureExplanationWithKnownVerifierState('ECONNRESET: socket hang up', redReceipt);
    assert.match(text, /ECONNRESET/);
    assert.match(text, /npm test/);
    assert.match(text, /exited 1/);
    assert.match(text, /does not turn it green/);
  });

  test('already-mentioned red check is not duplicated', () => {
    const once = failureExplanationWithKnownVerifierState('provider down', redReceipt);
    assert.equal(failureExplanationWithKnownVerifierState(once, redReceipt), once);
  });

  test('positive controls: green, stale and absent receipts add nothing', () => {
    for (const receipt of [
      null,
      { ...redReceipt, exit_code: 0 },
      { ...redReceipt, stale: true },
    ]) {
      assert.equal(
        failureExplanationWithKnownVerifierState('provider down', receipt as never),
        'provider down',
      );
    }
  });

  test('durable failed turn keeps red test evidence after a provider error', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-tf14-'));
    writeFileSync(join(projectRoot, 'source.js'), 'export const value = 1;\n');
    const engine = new ChatEngine({
      task: 'fix the failing test',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 2,
    });
    installRunner(engine, async function* () {
      // A verifier already ran red in this turn; the provider fails afterwards.
      (engine as unknown as { lastVerifierReceipt: unknown }).lastVerifierReceipt = redReceipt;
      yield { type: 'error', message: '[deepSeekApi] ECONNRESET: socket hang up' };
    });
    try {
      const result = await consumeChatStream(engine.submitMessageStream('continue'), null);
      assert.equal(result.outcome, 'INFRA_FAILURE');
      assert.equal(result.reason_code, 'provider_failure');
      assert.match(result.answer, /npm test/);
      assert.match(result.answer, /exited 1/);

      const loaded = loadThreadEventLogFromDir(chatSessionDir(engine.getEngineRunId()));
      const ended = loaded?.events.filter((event) => event.kind === 'turn_ended').at(-1);
      assert.equal(ended?.outcome, 'INFRA_FAILURE');
      assert.equal(ended?.response?.kind, 'error');
      assert.match(ended?.response?.content ?? '', /npm test/);
      assert.match(ended?.response?.content ?? '', /ECONNRESET/);
    } finally {
      engine.closeAdmissionStore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
