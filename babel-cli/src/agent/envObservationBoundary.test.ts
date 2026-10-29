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

test('Docker startup disk exhaustion is a permanent verifier environment block after an edit', () => {
  const text = 'docker: Error response from daemon: no space left on device';
  assert.ok(extractToolEnvBlockedSignal({ tool: 'test_run', stderr: text, exit_code: 125 }, { hasAnyWrites: true }));
  assert.equal(extractToolEnvBlockedSignal({ tool: 'read_file', error: text, exit_code: 1 }, { hasAnyWrites: true }), null);
  assert.equal(extractToolEnvBlockedSignal({ tool: 'test_run', stdout: text, exit_code: 0 }, { hasAnyWrites: true }), null);
  assert.equal(extractToolEnvBlockedSignal({ tool: 'test_run', stderr: 'AssertionError: expected "no space left on device"', exit_code: 1 }, { hasAnyWrites: true }), null);
});

test('Node package-resolution failures do not prove the Node executable is absent', () => {
  const text = "node:internal/modules/package_json_reader:314\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /app/\n    at packageResolve (node:internal/modules/esm/resolve:767:81)";
  assert.equal(extractToolEnvBlockedSignal({ tool: 'test_run', stderr: text, exit_code: 1 }, { hasAnyWrites: true }), null);
  for (const missing of ['sh: 1: node: not found', 'bash: line 1: node: command not found', '/bin/bash: line 1: npm: command not found', "'npm' is not recognized as an internal or external command", 'spawn python3 ENOENT', 'spawn C:\\Program Files\\nodejs\\node.exe ENOENT']) {
    assert.ok(extractToolEnvBlockedSignal({ tool: 'test_run', stderr: missing, exit_code: 127 }, { hasAnyWrites: true }), missing);
  }
  for (const quoted of ["AssertionError: expected 'node: not found'", 'README says node: command not found', 'Error: expected spawn node ENOENT']) {
    assert.equal(extractToolEnvBlockedSignal({ tool: 'test_run', stderr: quoted, exit_code: 1 }, { hasAnyWrites: true }), null);
  }
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
