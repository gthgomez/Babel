/**
 * Coding-loop repair: admission, verifier identity, currency, and task contract.
 * Fixtures use benign markers. No credential files are read for their contents
 * by the production helpers under test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { admitProjectContentRead, filterChatToolNamesForTask } from './chatReadOnly.js';
import { compileChatStack } from './chatStackCompile.js';
import { hashContent } from './chatEngineVerifierSession.js';
import {
  captureChatVerifierReceipt,
  shouldReuseCachedVerifierReceipt,
} from './chatEngineVerifierAdapter.js';
import { beginUserSubmission } from './turnRuntime.js';
import { resolveTaskShape } from '../config/chatTaskClass.js';
import {
  buildMcpToolCallParams,
  mcpAutoDispatchDenied,
} from '../tools/mcpTransport.js';
import {
  evaluateExecuteCompletionHonesty,
  isAuthoritativeVerifierCommand,
} from './completionGatePolicy.js';
import {
  satisfiesVerifierRequirement,
} from '../services/verifierIdentity.js';
import { buildExecutorTask } from '../stages/executorHelpers.js';
import { buildSweTask } from '../pipeline/sweTask.js';
import { ChatEngine } from './chatEngine.js';
import { buildChatTurnPrompt } from './chatToolDefinitions.js';
import { mapProviderMessagesToWire } from '../runners/providerMessages.js';
import { buildDelegatedChildEnvelope } from './chatEngineChildExecution.js';

const readOnly = { readOnlyHint: true, destructiveHint: false };

test('content admission refuses credential and outside paths before use', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-admit-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-admit-out-'));
  try {
    writeFileSync(join(root, 'ok.txt'), 'visible-marker');
    writeFileSync(join(root, '.env'), 'BENIGN_MARKER_NOT_A_SECRET');
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_MARKER');
    const allowed = admitProjectContentRead(root, 'ok.txt');
    assert.equal(allowed.ok, true);
    const credential = admitProjectContentRead(root, '.env');
    assert.equal(credential.ok, false);
    if (!credential.ok) assert.equal(credential.code, 'AUTONOMY_DENIED:CLASS_D');
    const escaped = admitProjectContentRead(root, join(outside, 'secret.txt'));
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.equal(escaped.code, 'READ_OUTSIDE_PROJECT_DENIED');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));
      const linked = admitProjectContentRead(root, 'linked.txt');
      assert.equal(linked.ok, false);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EINVAL') throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('explicit edit denial wins and ordinary edit verbs stay mutable', () => {
  for (const text of [
    'Review this patch; do not edit anything',
    'Explain the fix without changing files',
  ]) {
    assert.equal(resolveTaskShape(text, 'AUTO').operation, 'READ_ONLY');
    assert.equal(resolveTaskShape(text, 'CHANGE').operation, 'READ_ONLY');
  }
  for (const text of ['Optimize the parser', 'Bump the version', 'Convert the parser', 'Migrate the config']) {
    assert.notEqual(resolveTaskShape(text, 'AUTO').operation, 'READ_ONLY');
  }
  assert.notEqual(resolveTaskShape('Investigate the bug then fix it', 'AUTO').operation, 'READ_ONLY');
});

test('automatic instruction symlink outside the intake root is not loaded', () => {
  const repo = mkdtempSync(join(tmpdir(), 'babel-agents-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-agents-out-'));
  const prev = process.env['BABEL_USER_CONTEXT'];
  try {
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO_RULE_MARKER');
    const pkg = join(repo, 'packages', 'frontend');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(outside, 'AGENTS.md'), 'OUTSIDE_RULE_MARKER');
    process.env['BABEL_USER_CONTEXT'] = join(outside, 'user.md');
    writeFileSync(join(outside, 'user.md'), 'USER_CONTEXT_MARKER');
    const nested = compileChatStack({ projectRoot: pkg, includeDomainSkill: false });
    assert.match(nested.system_context, /REPO_RULE_MARKER/);
    try {
      symlinkSync(join(outside, 'AGENTS.md'), join(pkg, 'AGENTS.md'));
      const refused = compileChatStack({ projectRoot: pkg, includeDomainSkill: false });
      assert.match(refused.system_context, /REPO_RULE_MARKER/);
      assert.doesNotMatch(refused.system_context, /OUTSIDE_RULE_MARKER/);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EINVAL') throw error;
    }
    const selected = compileChatStack({ projectRoot: repo, includeDomainSkill: false });
    assert.match(selected.system_context, /USER_CONTEXT_MARKER/);
  } finally {
    if (prev === undefined) delete process.env['BABEL_USER_CONTEXT'];
    else process.env['BABEL_USER_CONTEXT'] = prev;
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('mcp read selection fails closed on destructive, missing, and expired approval', () => {
  assert.deepEqual(buildMcpToolCallParams([
    { name: 'delete_documents', inputSchema: { properties: { query: {} } }, annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'search', inputSchema: { properties: { query: {} } }, annotations: readOnly },
  ], 'docs'), { name: 'search', arguments: { query: 'docs' } });
  assert.equal(buildMcpToolCallParams([
    { name: 'delete_documents', inputSchema: { properties: { query: {} } }, annotations: { readOnlyHint: true, destructiveHint: false } },
  ], 'docs'), null);
  assert.equal(buildMcpToolCallParams([
    { name: 'search', inputSchema: { properties: { query: {} } } },
  ], 'docs'), null);
  const prevAsk = process.env['BABEL_ASK'];
  const prevExp = process.env['BABEL_MCP_APPROVAL_EXPIRES'];
  try {
    process.env['BABEL_ASK'] = 'true';
    delete process.env['BABEL_MCP_APPROVAL_EXPIRES'];
    assert.match(mcpAutoDispatchDenied() ?? '', /missing or expired/);
    process.env['BABEL_MCP_APPROVAL_EXPIRES'] = new Date(Date.now() - 1000).toISOString();
    assert.match(mcpAutoDispatchDenied() ?? '', /missing or expired/);
    process.env['BABEL_MCP_APPROVAL_EXPIRES'] = new Date(Date.now() + 60_000).toISOString();
    assert.equal(mcpAutoDispatchDenied(), null);
  } finally {
    if (prevAsk === undefined) delete process.env['BABEL_ASK'];
    else process.env['BABEL_ASK'] = prevAsk;
    if (prevExp === undefined) delete process.env['BABEL_MCP_APPROVAL_EXPIRES'];
    else process.env['BABEL_MCP_APPROVAL_EXPIRES'] = prevExp;
  }
});

test('verifier identity rejects non-executing, unknown aliasing, and dropped coverage', () => {
  assert.equal(isAuthoritativeVerifierCommand('npm test --help'), false);
  assert.equal(isAuthoritativeVerifierCommand('npm test --dry-run'), false);
  assert.equal(isAuthoritativeVerifierCommand('npm run typecheck'), true);
  assert.equal(isAuthoritativeVerifierCommand('pnpm test'), true);
  assert.equal(isAuthoritativeVerifierCommand('yarn test'), true);
  assert.equal(isAuthoritativeVerifierCommand('node --test'), true);
  assert.equal(satisfiesVerifierRequirement('make test', 'ctest'), false);
  assert.equal(satisfiesVerifierRequirement('make test', 'make test'), true);
  assert.equal(satisfiesVerifierRequirement('npm test -- --coverage', 'npm test'), false);
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test -- --coverage'), true);
  assert.equal(satisfiesVerifierRequirement('pytest', 'pytest -m fast'), false);
  assert.equal(satisfiesVerifierRequirement('npm test src/a.test.ts', 'npm test src/a.test.ts -- -k one'), false);
  assert.equal(satisfiesVerifierRequirement('npm test -- --unknown-flag', 'npm test'), false);
});

test('same-length interior edits do not share a read digest', () => {
  const left = hashContent('aaaa-MARKER-aaaa');
  const right = hashContent('aaaa-OTHER!-aaaa');
  assert.equal(left.length, right.length);
  assert.notEqual(left, right);
  assert.equal(left, createHash('sha256').update('aaaa-MARKER-aaaa', 'utf8').digest('hex'));
});

test('a real node test reaches strict completion and help does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verify-'));
  const passFile = join(root, 'pass.test.mjs');
  const failFile = join(root, 'fail.test.mjs');
  try {
    writeFileSync(passFile, "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok', () => { assert.equal(1, 1); });\n");
    writeFileSync(failFile, "import test from 'node:test'; import assert from 'node:assert/strict'; test('no', () => { assert.equal(1, 2); });\n");
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD') delete childEnv[key];
    }
    const pass = spawnSync(process.execPath, ['--test', passFile], { cwd: root, encoding: 'utf8', env: childEnv });
    const fail = spawnSync(process.execPath, ['--test', failFile], { cwd: root, encoding: 'utf8', env: childEnv });
    const help = spawnSync(process.execPath, ['--help'], { cwd: root, encoding: 'utf8', env: childEnv });
    assert.equal(pass.status, 0);
    assert.notEqual(fail.status, 0);
    assert.equal(help.status, 0);
    const passCommand = `node --test ${passFile}`;
    const receipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: passCommand,
      exitCode: pass.status ?? 1,
      summary: 'pass',
      stdout: pass.stdout,
      stderr: pass.stderr,
      mutationPaths: ['pass.test.mjs'],
    });
    assert.ok(receipt);
    assert.equal(receipt?.scope, 'targeted');
    assert.equal(typeof receipt?.tests_total, 'number');
    assert.ok((receipt?.tests_total ?? 0) > 0);
    assert.ok((receipt?.tests_skipped ?? 0) < (receipt?.tests_total ?? 0));
    const helpReceipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'node --help',
      exitCode: help.status ?? 0,
      summary: 'help',
      mutationPaths: ['pass.test.mjs'],
    });
    assert.equal(helpReceipt, null);
    const decision = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      toolCallLog: [],
      requiredVerifierCommands: [passCommand],
      executedVerifierLedger: receipt ? [receipt] : [],
    });
    assert.equal(decision.allow, true);
    const helpDecision = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      toolCallLog: [],
      requiredVerifierCommands: [],
      lastVerifierReceipt: {
        command: 'node --help',
        exit_code: 0,
        summary: 'help',
        authority: true,
      },
    });
    assert.equal(helpDecision.allow, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated and gitignored inputs invalidate verifier reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-closure-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'gen.js'), 'export const generated = 1;\n');
    writeFileSync(join(root, 'a.txt'), 'bound');
    const generated = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: ['a.txt'],
    });
    assert.ok(generated);
    assert.equal(generated?.inputClosure?.mode, 'bound');
    assert.equal(shouldReuseCachedVerifierReceipt(root, generated!), true);
    writeFileSync(join(root, 'dist', 'gen.js'), 'export const generated = 2;\n');
    assert.equal(shouldReuseCachedVerifierReceipt(root, generated!), false);

    const ignoredRoot = mkdtempSync(join(tmpdir(), 'babel-ignored-'));
    try {
      writeFileSync(join(ignoredRoot, '.gitignore'), 'ignored.txt\n');
      writeFileSync(join(ignoredRoot, 'ignored.txt'), 'before\n');
      writeFileSync(join(ignoredRoot, 'keep.txt'), 'keep\n');
      const git = (args: string[]) => spawnSync('git', args, { cwd: ignoredRoot, encoding: 'utf8' });
      for (const args of [
        ['init', '--quiet'],
        ['config', 'user.email', 'fixture@example.test'],
        ['config', 'user.name', 'fixture'],
        ['add', '-A'],
        ['commit', '--quiet', '-m', 'baseline'],
      ]) {
        const result = git(args);
        assert.equal(result.status, 0, result.stderr);
      }
      const ignored = await captureChatVerifierReceipt({
        projectRoot: ignoredRoot,
        command: 'npm test',
        exitCode: 0,
        summary: 'ok',
        mutationPaths: [],
        allowRepositoryScopeForGreenNoChange: true,
      });
      assert.ok(ignored);
      assert.equal(ignored?.inputClosure?.mode, 'bound');
      if (ignored?.inputClosure?.mode === 'bound') {
        assert.equal(ignored.inputClosure.paths.includes('ignored.txt'), true);
      }
      assert.equal(shouldReuseCachedVerifierReceipt(ignoredRoot, ignored!), true);
      writeFileSync(join(ignoredRoot, 'ignored.txt'), 'after\n');
      assert.equal(shouldReuseCachedVerifierReceipt(ignoredRoot, ignored!), false);
    } finally {
      rmSync(ignoredRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict completion rejects a missing, zero, or fully skipped test count', async () => {
  const absent = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    toolCallLog: [],
    lastVerifierReceipt: { command: 'npm test', exit_code: 0, summary: 'ok', authority: true },
  });
  assert.equal(absent.allow, false);
  const zero = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    toolCallLog: [],
    requiredVerifierCommands: ['npm test'],
    lastVerifierReceipt: { command: 'npm test', exit_code: 0, summary: 'ok', authority: true, tests_total: 0, tests_skipped: 0 },
  });
  assert.equal(zero.allow, false);
  const skipped = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    toolCallLog: [],
    requiredVerifierCommands: ['npm test'],
    lastVerifierReceipt: { command: 'npm test', exit_code: 0, summary: 'ok', authority: true, tests_total: 2, tests_skipped: 2 },
  });
  assert.equal(skipped.allow, false);

  const root = mkdtempSync(join(tmpdir(), 'babel-zero-tests-'));
  try {
    const skip = join(root, 'skip.test.mjs');
    writeFileSync(skip, "import test from 'node:test'; test.skip('later', () => {});\n");
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD') delete childEnv[key];
    }
    const skipRun = spawnSync(process.execPath, ['--test', skip], { cwd: root, encoding: 'utf8', env: childEnv });
    assert.equal(skipRun.status, 0);
    const skipReceipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: `node --test ${skip}`,
      exitCode: 0,
      summary: 'skipped',
      stdout: skipRun.stdout,
      stderr: skipRun.stderr,
      mutationPaths: ['skip.test.mjs'],
    });
    assert.ok(skipReceipt);
    assert.equal(skipReceipt?.tests_skipped, skipReceipt?.tests_total);
    assert.ok((skipReceipt?.tests_total ?? 0) > 0);
    const decision = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      toolCallLog: [],
      requiredVerifierCommands: [skipReceipt!.command],
      executedVerifierLedger: [skipReceipt!],
    });
    assert.equal(decision.allow, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unbound relevant input invalidates verifier reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-currency-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'bound');
    writeFileSync(join(root, 'b.txt'), 'consumed');
    const receipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: ['a.txt'],
    });
    assert.ok(receipt);
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt!), true);
    writeFileSync(join(root, 'b.txt'), 'changed-outside');
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt!), false);
    writeFileSync(join(root, 'b.txt'), 'consumed');
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt!), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('continuation keeps the objective and an amendment applies in order', () => {
  const first = beginUserSubmission({
    userInput: 'Fix the parser. Do not edit secrets.',
    projectRoot: 'p',
    classifyIntent: () => 'execute',
  });
  const continued = beginUserSubmission({
    userInput: 'continue',
    projectRoot: 'p',
    previous: first,
    classifyIntent: () => 'execute',
  });
  assert.match(continued.taskText, /Fix the parser/);
  assert.equal(continued.effectiveOperation, first.effectiveOperation);
  const amended = beginUserSubmission({
    userInput: 'also do not edit anything',
    projectRoot: 'p',
    previous: first,
    classifyIntent: () => 'execute',
  });
  assert.match(amended.taskText, /Fix the parser/);
  assert.match(amended.taskText, /do not edit anything/);
  assert.equal(amended.effectiveOperation, 'READ_ONLY');
});

test('executor task keeps a constraint the plan omitted', () => {
  const task = buildExecutorTask(
    { steps: [] } as never,
    'Add a comment. Do not modify src/locked.ts',
    [],
  );
  assert.match(task, /Do not modify src\/locked\.ts/);
  assert.match(task, /authoritative/);
});

test('read-only research can search unless offline, and writes stay denied', () => {
  const names = ['web_search', 'web_fetch', 'write_file', 'read_file'];
  const prev = process.env['BABEL_OFFLINE'];
  try {
    delete process.env['BABEL_OFFLINE'];
    const online = filterChatToolNamesForTask(names, 'READ_ONLY', []);
    assert.ok(online.includes('web_search'));
    assert.ok(online.includes('read_file'));
    assert.equal(online.includes('write_file'), false);
    process.env['BABEL_OFFLINE'] = '1';
    const offline = filterChatToolNamesForTask(names, 'READ_ONLY', []);
    assert.equal(offline.includes('web_search'), false);
    assert.equal(offline.includes('web_fetch'), false);
    assert.ok(offline.includes('read_file'));
  } finally {
    if (prev === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = prev;
  }
});

test('python fixture does not activate gradle bootstrap', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-py-'));
  try {
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
    writeFileSync(join(root, 'parser.py'), 'print(1)\n');
    const prompt = buildSweTask({
      target_project: 'fixture',
      target_project_path: root,
      handoff_payload: { user_request: 'Explain parser.py' },
    } as never, 'Explain parser.py', [], undefined);
    assert.match(prompt, /parser.py|top-level|pyproject/i);
    assert.doesNotMatch(prompt, /Wrapper bootstrap mode is ACTIVE/);
    assert.doesNotMatch(prompt, /Deterministic Gradle bootstrap lane is ACTIVE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serialized native, text, and legacy requests replace policy A with policy B', () => {
  const repo = mkdtempSync(join(tmpdir(), 'babel-policy-'));
  const prev = process.env['BABEL_USER_CONTEXT'];
  try {
    mkdirSync(join(repo, '.git'));
    process.env['BABEL_USER_CONTEXT'] = join(repo, 'missing-user-context.md');
    writeFileSync(join(repo, 'AGENTS.md'), 'POLICY_A_OBSOLETE\n');
    const task = 'Explain the fix without changing files';
    const engine = new ChatEngine({ task, projectRoot: repo });
    const serialized = (mode: 'native' | 'text' | 'legacy'): string => {
      const host = engine as unknown as {
        getOrBuildSystemPrompt: (kind: 'native' | 'text' | 'legacy') => string;
        conversation: Array<{ role: string; name?: string; content: string }>;
        options: { task: string };
      };
      const system = host.getOrBuildSystemPrompt(mode);
      const conversation = host.conversation.map((message) => ({ ...message }));
      const installed = conversation[0];
      if (installed?.role === 'system' && installed.name !== 'compaction_capsule') {
        installed.content = system;
      }
      const prompt = buildChatTurnPrompt({
        conversation: conversation as never,
        task: host.options.task,
        nativeTools: mode === 'native',
        textTools: mode === 'text',
      });
      const wire = mapProviderMessagesToWire(
        [
          { role: 'system', content: system },
          { role: 'user', content: host.options.task },
        ],
        system,
      );
      return JSON.stringify({ system, prompt, wire });
    };
    for (const mode of ['native', 'text', 'legacy'] as const) {
      const first = serialized(mode);
      assert.equal(first.includes('POLICY_A_OBSOLETE'), true, mode);
    }
    writeFileSync(join(repo, 'AGENTS.md'), 'POLICY_B_CURRENT\n');
    engine.applyTurnPreparation({ task });
    for (const mode of ['native', 'text', 'legacy'] as const) {
      const next = serialized(mode);
      assert.equal(next.includes('POLICY_B_CURRENT'), true, mode);
      assert.equal(next.includes('POLICY_A_OBSOLETE'), false, mode);
    }

    const pkg = join(repo, 'packages', 'frontend');
    mkdirSync(pkg, { recursive: true });
    const delegated = buildDelegatedChildEnvelope({
      task,
      projectRoot: pkg,
      parentReadOnly: true,
      requestedMutation: true,
      requestedWriteScope: ['src/app.ts', '..', join(repo, 'outside.txt')],
      instructions: 'keep the original no-edit constraint',
      parentModel: null,
    });
    assert.match(delegated.envelope, /POLICY_B_CURRENT/);
    assert.match(delegated.envelope, /Explain the fix without changing files/);
    assert.match(delegated.envelope, /keep the original no-edit constraint/);
    assert.equal(delegated.mutationEnabled, false);
    assert.deepEqual(delegated.writeScope, []);
    assert.match(delegated.envelope, /Write scope: \(none\)/);
    assert.doesNotMatch(delegated.envelope, /outside\.txt/);
    const mutating = buildDelegatedChildEnvelope({
      task,
      projectRoot: pkg,
      parentReadOnly: false,
      requestedMutation: true,
      requestedWriteScope: ['src/app.ts', '..', join(repo, 'outside.txt')],
      instructions: null,
      parentModel: null,
    });
    assert.deepEqual(mutating.writeScope, ['src/app.ts']);
    assert.match(mutating.envelope, /Write scope: src\/app.ts/);
    assert.equal(mutating.envelope.includes('outside.txt'), false);
  } finally {
    if (prev === undefined) delete process.env['BABEL_USER_CONTEXT'];
    else process.env['BABEL_USER_CONTEXT'] = prev;
    rmSync(repo, { recursive: true, force: true });
  }
});
