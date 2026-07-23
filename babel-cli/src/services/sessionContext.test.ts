import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EvidenceBundle } from '../evidence.js';
import {
  getSessionContextPath,
  readExecutorSessionContext,
  summarizeExecutorSessionContext,
  writeExecutorSessionContext,
} from './sessionContext.js';

test('executor session context persists model prompt, history, cache, and approval state', async () => {
  const base = mkdtempSync(join(tmpdir(), 'babel-session-context-'));
  const runDir = join(base, 'runs', '20260424_120000_session-context');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '03_qa_verdict_v1.json'),
    JSON.stringify({ verdict: 'PASS' }),
    'utf-8',
  );

  try {
    const evidence = EvidenceBundle.fromExistingRun(runDir);
    const cache = new Map([['src/example.txt', 'file body\n']]);
    const snapshot = await writeExecutorSessionContext({
      evidence,
      status: 'ready_for_next_turn',
      baseContext: 'base context',
      executionHistory: '[Step 1] file_read',
      nextTurnPrompt: 'next prompt',
      fileReadCache: cache,
      toolCallLog: [
        {
          step: 1,
          tool: 'file_read',
          target: 'src/example.txt',
          exit_code: 0,
          stdout: 'file body\n',
          stderr: '',
          verified: true,
        },
      ],
    });

    assert.equal(snapshot.approval_state.executor_gate, 'PASS');
    assert.equal(snapshot.model_context.file_read_cache[0]?.content, 'file body\n');
    assert.equal(snapshot.model_context.next_turn_prompt, 'next prompt');

    const restored = readExecutorSessionContext(runDir);
    assert.ok(restored);
    assert.equal(restored.model_context.execution_history, '[Step 1] file_read');

    const summary = summarizeExecutorSessionContext(restored);
    assert.equal(summary.available, true);
    assert.equal(summary.path, getSessionContextPath(runDir));
    assert.equal(summary.steps_complete, 1);
    assert.equal(summary.approval_state?.qa_verdict, 'PASS');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
