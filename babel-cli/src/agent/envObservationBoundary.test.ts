import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolEnvBlockedSignal, resolveImplementorHarnessFields } from './implementorPolicy.js';
import { resolveChatRangePath } from './chatReadOnly.js';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('environment classification requires failed execution, not source or successful output', () => {
  const text = 'ENV_BLOCKED: pytest command not found; ImportError while loading conftest';
  for (const tool of ['read_file', 'read_range', 'grep', 'list_dir']) {
    assert.equal(extractToolEnvBlockedSignal({ tool, detail: text, error: text, exit_code: 1 }), null);
  }
  assert.equal(extractToolEnvBlockedSignal({ tool: 'run_command', stdout: text, exit_code: 0 }), null);
  assert.ok(extractToolEnvBlockedSignal({ tool: 'test_run', stderr: text, exit_code: 1 }));
  assert.equal(resolveImplementorHarnessFields({ answer: `The parser misclassifies ${text}`, readOnly: true, hasAnyWrites: false, emptyPatch: true, legacyAnswerStatus: 'ANSWER_READY' }).env_blocked, false);
});

test('range path cannot escape through relative, absolute or directory junction paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-range-boundary-'));
  const source = join(root, 'source'); mkdirSync(source);
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(source, 'ok'), 'ok'); writeFileSync(join(outside, 'private'), 'private');
  assert.ok(resolveChatRangePath(source, 'ok').endsWith('ok'));
  assert.throws(() => resolveChatRangePath(source, '../outside/private'), /DENIED/);
  assert.throws(() => resolveChatRangePath(source, join(outside, 'private')), /DENIED/);
  symlinkSync(outside, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveChatRangePath(source, 'escape/private'), /DENIED/);
});
