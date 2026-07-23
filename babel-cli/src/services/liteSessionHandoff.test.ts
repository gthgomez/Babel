import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildLiteSessionHandoff } from './liteSessionHandoff.js';

test('buildLiteSessionHandoff summarizes prior tool_call_log from execution report', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-lite-handoff-'));
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, '04_execution_report.json'),
      JSON.stringify({
        status: 'PLAN_READY',
        tool_call_log: [
          { step: 1, tool: 'read_file', target: 'src/example.ts', exit_code: 0 },
          { step: 2, tool: 'grep', target: 'parser', exit_code: 0 },
        ],
      }),
      'utf-8',
    );

    const handoff = buildLiteSessionHandoff(runDir);
    assert.ok(handoff);
    assert.equal(handoff.sessionRunDir, runDir);
    assert.equal(handoff.toolCallCount, 2);
    assert.match(handoff.summary, /Prior tool calls \(2\)/);
    assert.match(handoff.summary, /read_file src\/example\.ts/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
