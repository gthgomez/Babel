import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorktreeSafetyController } from '../services/worktreeSafety.js';
import { resolveLiveSessionAuthority } from './liveSessionBridge.js';
import { governedStrReplace } from './governedMutations.js';
import { executeActionWithPolicy, type ToolExecutor } from './toolExecutor.js';
import type { ToolContext } from '../localTools.js';
import {
  designatedWitnessProtectedInputs,
  type ProtectedInputFs,
} from './taskAcceptanceProtectedInputs.js';
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js';
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js';

const WITNESS_TASK = [
  'Fix the parser regression in src/parser.ts: the request drops the governed header. Preserve Accept and the existing safe transport, diagnostics and authorization behavior. The default-transport regression tests are already present. Make the smallest production fix and run both tests using: npm run test:parser. Do not modify regression tests or unrelated code.',
  'Acceptance criteria:',
  '- `npm run test:parser` must pass.',
].join('\n');

const PLAIN_TASK = 'Fix the parser bug in src/parser.ts.';

function boundMeaning(task: string) {
  return bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(task),
    trustedVerifierCommands: ['npm run test:parser'],
    defaultWorkingDirectory: '.',
  });
}

test('ordinary tasks keep the default protected-path set', () => {
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    task: PLAIN_TASK,
    projectRoot: '/tmp/project',
  });
  assert.deepEqual(authority.taskContract.protected_paths, ['.env', '.git']);
});

test('a designated regression witness protects its script surface at freeze', () => {
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    task: WITNESS_TASK,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser'],
  });
  assert.ok(authority.taskContract.protected_paths.includes('package.json'));
  // The witness criterion itself is bound, not meaning-bound.
  const preserved = authority.taskContract.acceptance.find(item =>
    item.description.startsWith('Fix the parser regression'),
  );
  assert.ok(preserved && !preserved.verification.verifier_id.startsWith('meaning:'));
});

test('protected inputs include test files the designated script statically names', () => {
  const fs: ProtectedInputFs = {
    readFile: (path) => path.endsWith('package.json')
      ? JSON.stringify({ scripts: { 'test:parser': 'node test/parser.regression.test.mjs' } })
      : null,
    exists: (path) => path.replaceAll('\\', '/').endsWith('test/parser.regression.test.mjs'),
  };
  const inputs = designatedWitnessProtectedInputs('/tmp/project', boundMeaning(WITNESS_TASK), fs);
  assert.deepEqual(inputs, ['package.json', 'test/parser.regression.test.mjs']);
});

test('unresolvable discovery stays explicit: only the script surface is protected', () => {
  const missing: ProtectedInputFs = { readFile: () => null, exists: () => false };
  assert.deepEqual(
    designatedWitnessProtectedInputs('/tmp/project', boundMeaning(WITNESS_TASK), missing),
    ['package.json'],
  );
  // A witness whose command is not an npm script has no script surface to resolve.
  const fs: ProtectedInputFs = {
    readFile: () => JSON.stringify({ scripts: { 'test:parser': 'vitest run' } }),
    exists: () => false,
  };
  assert.deepEqual(
    designatedWitnessProtectedInputs('/tmp/project', boundMeaning(WITNESS_TASK), fs),
    ['package.json'],
  );
});

test('ordinary meanings derive no protected inputs', () => {
  const missing: ProtectedInputFs = { readFile: () => null, exists: () => false };
  assert.deepEqual(
    designatedWitnessProtectedInputs('/tmp/project', boundMeaning(PLAIN_TASK), missing),
    [],
  );
});

const mockExecutor: ToolExecutor = {
  mapAction: () => [],
  execute: async action => ({
    action,
    terminal: false,
    results: [{ exit_code: 0, stdout: '', stderr: '' }],
  }),
};

function policyCtx(runId: string, projectRoot: string): ToolContext {
  return {
    agentId: 'witness-protected-inputs',
    runId,
    babelRoot: projectRoot,
    projectRoot,
  };
}

test('admitted execution matrix: witness freeze denies mutating protected script and test paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-protected-input-exec-'));
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'test:parser': 'node test/parser.regression.test.mjs' } }),
  );
  writeFileSync(join(root, 'test', 'parser.regression.test.mjs'), 'export {}\n');
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    task: WITNESS_TASK,
    projectRoot: root,
    projectTestCommands: ['npm run test:parser'],
  });
  const protectedPaths = authority.taskContract.protected_paths;
  assert.ok(protectedPaths.includes('package.json'));
  assert.ok(protectedPaths.includes('test/parser.regression.test.mjs'));

  for (const path of ['package.json', 'test/parser.regression.test.mjs'] as const) {
    const result = await executeActionWithPolicy(
      { type: 'write_file', path, content: 'tamper\n' },
      'workspace_write',
      policyCtx(`witness-protected-${path}`, root),
      { executor: mockExecutor, mode: 'chat', protectedPaths },
    );
    assert.equal(result.policyBlocked, true, path);
    assert.ok(String(result.results[0]?.stderr).includes('protected_path'), path);
  }

  const allowed = await executeActionWithPolicy(
    { type: 'write_file', path: 'src/parser.ts', content: 'fix\n' },
    'workspace_write',
    policyCtx('witness-allowed-src', root),
    { executor: mockExecutor, mode: 'chat', protectedPaths },
  );
  assert.equal(allowed.policyBlocked, false);

  const governed = await governedStrReplace(
    { file_path: 'package.json', old_str: 'test:parser', new_str: 'test:evil' },
    {
      projectRoot: root,
      context: policyCtx('witness-protected-str-replace', root),
      protectedPaths,
      executor: mockExecutor,
    },
  );
  assert.equal(governed.policyBlocked, true);
  assert.ok(governed.observation.includes('protected_path'));
});

test('admitted execution matrix: worktree safety refuses protected witness paths before snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-protected-input-worktree-'));
  writeFileSync(join(root, 'package.json'), '{"scripts":{}}\n');
  const protectedPaths = ['.env', '.git', 'package.json', 'test/parser.regression.test.mjs'];
  const safety = createWorktreeSafetyController({
    projectRoot: root,
    runDir: join(root, '.run'),
    protectedPaths,
  });
  for (const path of ['package.json', 'test/parser.regression.test.mjs'] as const) {
    const result = safety.snapshotBeforeWrite(path, 1);
    assert.equal(result.ok, false, path);
    assert.match(result.reason ?? '', /protected path/i, path);
  }
  assert.deepEqual(safety.buildSummary().protected_path_conflicts.sort(), [
    'package.json',
    'test/parser.regression.test.mjs',
  ]);
});

test('admitted completion matrix: protected-path conflicts are recorded; content-hash tamper is out of scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-protected-input-completion-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/parser.ts'), 'before\n');
  const protectedPaths = ['.env', '.git', 'package.json'];
  const safety = createWorktreeSafetyController({
    projectRoot: root,
    runDir: join(root, '.run'),
    protectedPaths,
  });
  assert.equal(safety.snapshotBeforeWrite('src/parser.ts', 1).ok, true);
  writeFileSync(join(root, 'src/parser.ts'), 'after\n');
  const summary = safety.buildSummary();
  assert.deepEqual(summary.protected_path_conflicts, []);
  assert.ok(summary.touched_files.includes('src/parser.ts'));
});
