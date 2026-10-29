import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCommandArgv } from '../utils/commandArgv.js';
import { decodeCommand, isPythonTestCommand } from './commandDecoder.js';
import { actionRequestFromAction } from './actionRequest.js';
import { decideWithLease } from './wire.js';
import { createToolExecutor, executeActionWithPolicy } from '../agent/toolExecutor.js';

const testCommand = 'node --import ./src/testinfra/register-no-ambient-inference.mjs --import tsx --test --test-concurrency=1 src/agent/harnessParityLivePath.test.ts';

test('Node test classification accepts module preloads before the exact test flag', () => {
  for (const command of [
    testCommand,
    'node --import=tsx --test sample.test.ts',
    'node --import "./setup with spaces.mjs" --import=tsx --test sample.test.ts',
    'node --test --import tsx sample.test.ts',
    'node --import tsx --test --test-concurrency 1 --test-reporter=tap sample.test.ts',
    'node --test --test-only --test-name-pattern "a b" sample.test.ts',
    'node --import tsx --test -- sample.test.ts',
    'node --test',
  ]) {
    const decoded = decodeCommand(command);
    assert.equal(decoded.capability, 'run_tests', command);
    assert.equal(decoded.semantic, 'test_local', command);
    assert.equal(decoded.requiresIsolation, true, command);
  }
});

test('Python standard-library test modules use the isolated run_tests capability', () => {
  for (const command of [
    'python -m doctest solution.py',
    'python3 -m doctest solution.py -v',
    'python3.11 -m doctest solution.py',
    'python3.12 -m unittest test_solution -v',
    'python.exe -m unittest test_solution -v',
    'py -3.11 -m unittest test_solution -v',
    'python -m pytest tests/',
    'PYTHON3.11 -m doctest solution.py',
    'python -m doctest "file&with;chars.py"',
    "python -m doctest 'file with spaces.py'",
    String.raw`python -m doctest C:\temp\solution.py`,
  ]) {
    const decoded = decodeCommand(command);
    assert.equal(decoded.capability, 'run_tests', command);
    assert.equal(decoded.semantic, 'test_local', command);
    assert.equal(decoded.requiresIsolation, true, command);
    assert.equal(actionRequestFromAction({ type: 'test_run', command })?.capability, 'run_tests', command);
    const action = { type: 'test_run' as const, command };
    assert.equal(decideWithLease(action, 'workspace_write', { lease: null }).decision, 'deny', command);
    assert.equal(decideWithLease(action, 'workspace_write', { lease: null, isolationAvailable: true }).decision, 'allow', command);
  }
});

test('Python eval and unrelated modules remain arbitrary code', () => {
  for (const command of [
    'python -c "print(1)"',
    'python3.11 -c "import os; print(os.getcwd())"',
    'python -m http.server',
    'python3.11 -m pip install package',
    'python -m doctestx solution.py',
    'python3.11 -m unittest_extra test_solution',
    'python -m pytest_extra tests/',
    'python -m Unittest test_solution',
    'python -m Doctest solution.py',
    'python -m Pytest tests/',
    'pytest_extra tests/',
    'pytest\npython -c "print(1)"',
    'python -m unittest\npython -c "print(1)"',
    'python -m unittest \npython -c "print(1)"',
    'python -m unittest $(git push origin main)',
    'python -m unittest "$(git push origin main)"',
    String.raw`python -m unittest "\$(git push origin main)"`,
    'python -m unittest `git push origin main`',
    'python -m unittest & git push origin main',
    'python -m unittest | git push origin main',
    String.raw`python -m unittest \& git push origin main`,
    'python -m unittest %X%',
    'python -m unittest "%X%"',
    'python -m doctest !X!',
    "python -m unittest 'file & git push origin main'",
    String.raw`python -m unittest 'foo " bar' "baz & git push origin main"`,
    String.raw`python -m unittest ^"foo & git push origin main"`,
    'python -m doctest solution.py && python -c "import os; print(os.getcwd())"',
    String.raw`C:\Python311\python.exe -m doctest solution.py`,
  ]) {
    const decoded = decodeCommand(command);
    assert.notEqual(decoded.capability, 'run_tests', command);
    assert.notEqual(actionRequestFromAction({ type: 'test_run', command })?.capability, 'run_tests', command);
  }
});

test('absolute Windows interpreter paths stay outside the Python test fast path', () => {
  const command = String.raw`C:\Python311\python.exe -m doctest solution.py`;
  assert.equal(parseCommandArgv(command, 'win32')[0], String.raw`C:\Python311\python.exe`);
  assert.equal(isPythonTestCommand(command, 'win32'), false);
});

test('Node test classification refuses wrapper quote loss, escaped quotes and mode overrides', () => {
  for (const command of [
    "env node --import './preload --test .mjs' sample.js",
    'env node --import tsx --test sample.test.ts',
    String.raw`node --import "./preload\" --test .mjs" sample.js`,
    'node --import "./preload --test .mjs" sample.js',
    'node --import tsx --test --no-test sample.js',
    'node --import tsx --test --no_test sample.js',
    'node --test --no-test sample.js',
    'node --import tsx --test --run arbitrary',
    'node --test --run arbitrary',
    'node --import tsx --test --unknown sample.js',
    'node --import "" --test sample.test.ts',
    'node --import "unterminated --test sample.test.ts',
    "node --import ./setup.mjs --test $(printf '%s' '--no-test') plain.mjs",
    'node --import ./setup.mjs --test `echo --no-test` plain.mjs',
    'node --import ./setup.mjs --test $MODE plain.mjs',
    'node --import ./setup.mjs --test %MODE% plain.mjs',
    'node --import ./setup.mjs --test plain.mjs\nnode plain.mjs',
  ]) {
    assert.notEqual(decodeCommand(command).capability, 'run_tests', command);
    assert.equal(decideWithLease({ type: 'test_run', command }, 'workspace_write', { lease: null, hostFallbackAllowed: true }).decision, 'deny', command);
  }
});

test('Node script arguments, preload values and malformed test flags do not grant test capability', () => {
  for (const command of [
    'node sample.js --test',
    'node --import tsx sample.js --test',
    'node -- --test',
    'node --import tsx -- --test',
    'node --import --test sample.js',
    'node --import=--test sample.js',
    'node --import= --test',
    'node --testfoo',
    'node --test-only sample.js',
    'node --test-name-pattern --test sample.js',
    'node --unknown --test sample.js',
    'node --version',
    'node --import tsx -e "console.log(1)" --test',
    'node --test -e "console.log(1)"',
  ]) {
    assert.equal(decodeCommand(command).capability, 'run_arbitrary_code', command);
  }
});

test('Node preload tests preserve isolation and permission preset requirements', () => {
  const action = { type: 'test_run' as const, command: testCommand };
  const withoutIsolation = decideWithLease(action, 'workspace_write', { lease: null });
  assert.equal(withoutIsolation.decision, 'deny');
  assert.equal(withoutIsolation.reasonCode, 'DENY_CAPABILITY_CONSTRAINT');
  assert.equal(decideWithLease(action, 'workspace_write', { lease: null, isolationAvailable: true }).decision, 'allow');
  assert.equal(decideWithLease(action, 'workspace_write', { lease: null, hostFallbackAllowed: true }).decision, 'allow');
  assert.equal(decideWithLease(action, 'read_only', { lease: null, hostFallbackAllowed: true }).decision, 'deny');
  assert.equal(decideWithLease({ type: 'run_command', command: 'node sample.js --test' }, 'workspace_write', { lease: null, hostFallbackAllowed: true }).decision, 'deny');
});

test('the policy executor dispatches a real preloaded Node test and still blocks script arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-node-preload-'));
  try {
    writeFileSync(join(root, 'setup.mjs'), 'globalThis.babelPreloaded = true;\n');
    writeFileSync(join(root, 'sample.test.mjs'), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("preloaded", () => assert.equal(globalThis.babelPreloaded, true));\n');
    writeFileSync(join(root, 'plain.mjs'), 'console.log("plain-script-executed");\n');
    const command = 'node --import ./setup.mjs --test sample.test.mjs';
    let executions = 0;
    const executor = createToolExecutor({ executeTool: async (request) => {
      assert.equal(request.tool, 'test_run');
      assert.equal(request.command, command);
      executions++;
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--import', './setup.mjs', '--test', '--test-reporter=tap', 'sample.test.mjs'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      assert.ifError(child.error);
      return { exit_code: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
    } });
    const context = { agentId: 'node-preload', runId: 'node-preload', babelRoot: root };
    const deps = { executor, lease: null, hostFallbackAllowed: true };
    const result = await executeActionWithPolicy({ type: 'test_run', command }, 'workspace_write', context, deps);
    assert.equal(result.policyBlocked, false);
    assert.equal(result.results[0]?.exit_code, 0);
    assert.match(result.results[0]?.stdout ?? '', /# pass 1/);
    const denied = await executeActionWithPolicy({ type: 'test_run', command: 'node sample.test.mjs --test' }, 'workspace_write', context, deps);
    assert.equal(denied.policyBlocked, true);
    assert.equal(denied.reasonCode, 'DENY_MISSING_AUTHORITY');
    const negatedCommand = 'node --import ./setup.mjs --test --no-test plain.mjs';
    const negated = spawnSync(process.execPath, ['--import', './setup.mjs', '--test', '--no-test', 'plain.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.ifError(negated.error);
    assert.equal(negated.status, 0);
    assert.equal(negated.stdout.trim(), 'plain-script-executed');
    const negatedDenied = await executeActionWithPolicy({ type: 'test_run', command: negatedCommand }, 'workspace_write', context, deps);
    assert.equal(negatedDenied.policyBlocked, true);
    assert.equal(negatedDenied.reasonCode, 'DENY_MISSING_AUTHORITY');
    assert.equal(executions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
