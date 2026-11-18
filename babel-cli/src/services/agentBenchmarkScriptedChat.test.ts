import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadAgentBenchmarkManifest, runAgentBenchmarkTask } from './agentBenchmark.js';

test('mock chat benchmark exercises the real ChatEngine tool protocol without a provider', async () => {
  const manifest = loadAgentBenchmarkManifest();
  const task = manifest.tasks.find((entry) => entry.task_id === 'PAR-A01');
  assert.ok(task);
  const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-scripted-benchmark-'));
  try {
    const result = await runAgentBenchmarkTask(task, {
      provider: 'mock',
      evidenceDir,
    });
    assert.equal(result.execution_path, 'scripted_chat_engine');
    assert.equal(result.scripted_provider, true);
    assert.equal(result.model_performance_claim, false);
    assert.equal(result.score_class, 'scripted_protocol_control');
    assert.equal(result.status, 'success', result.notes.join('\n'));
    assert.equal(result.verifier, 'pass');
    assert.ok(result.changed_files.includes('src/math.js'));

    const notes = result.notes.join('\n');
    assert.doesNotMatch(notes, /EXECUTOR_HALTED|SETUP_REQUIRED/);
    const toolCalls = Number(notes.match(/scripted_tool_calls=(\d+)/)?.[1] ?? 0);
    assert.ok(toolCalls >= 3, `expected read/write/verify tool calls, got ${toolCalls}`);

    const evidence = JSON.parse(
      readFileSync(join(evidenceDir, 'PAR-A01-scripted.json'), 'utf8'),
    ) as { scripted_provider: boolean; model_performance_claim: boolean; tool_calls: unknown[] };
    assert.equal(evidence.scripted_provider, true);
    assert.equal(evidence.model_performance_claim, false);
    assert.ok(Array.isArray(evidence.tool_calls) && evidence.tool_calls.length >= 3);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});
