import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLiveSessionAuthority } from './liveSessionBridge.js';
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
