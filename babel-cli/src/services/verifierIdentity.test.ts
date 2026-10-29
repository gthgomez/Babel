import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeVerifierIdentity,
  classifyVerifierScope,
  sameVerifierIdentity,
  satisfiesVerifierRequirement,
} from './verifierIdentity.js';

test('classifies full-suite npm test', () => {
  assert.equal(classifyVerifierScope('npm test'), 'full');
  assert.equal(analyzeVerifierIdentity('npm test')?.family, 'npm-test');
});

test('Python test-module families retain meaningful full and targeted scope', () => {
  const pythonFull = analyzeVerifierIdentity('python -m unittest');
  assert.equal(pythonFull?.family, 'unittest');
  assert.equal(pythonFull?.scope, 'full');

  const versionedUnittest = analyzeVerifierIdentity('python3.11 -m unittest tests.test_math');
  assert.equal(versionedUnittest?.family, 'unittest');
  assert.equal(versionedUnittest?.scope, 'targeted');
  assert.deepEqual(versionedUnittest?.targetSelectors, ['tests.test_math']);

  const windowsLauncher = analyzeVerifierIdentity('py -3.11 -m unittest tests.test_math');
  assert.equal(windowsLauncher?.family, 'unittest');
  assert.equal(windowsLauncher?.scope, 'targeted');
  assert.deepEqual(windowsLauncher?.targetSelectors, ['tests.test_math']);

  const doctest = analyzeVerifierIdentity('python.exe -m doctest solution.py');
  assert.equal(doctest?.family, 'doctest');
  assert.equal(doctest?.scope, 'targeted');
  assert.deepEqual(doctest?.targetSelectors, ['solution.py']);

  assert.equal(analyzeVerifierIdentity('python3.11 -m unittest --version')?.scope, 'unknown');
});

test('classifies targeted npm test with path after --', () => {
  assert.equal(classifyVerifierScope('npm test -- src/add.test.ts'), 'targeted');
  assert.deepEqual(analyzeVerifierIdentity('npm test -- src/add.test.ts')?.targetSelectors, [
    'src/add.test.ts',
  ]);
});

test('classifies vitest targeted vs full', () => {
  assert.equal(classifyVerifierScope('vitest run'), 'full');
  assert.equal(classifyVerifierScope('npx vitest run src/add.test.ts'), 'targeted');
  assert.equal(analyzeVerifierIdentity('npx vitest run src/add.test.ts')?.family, 'vitest');
});

test('narrow actual does not satisfy full required (golden shape)', () => {
  assert.equal(
    satisfiesVerifierRequirement('npm test', 'npx vitest run src/add.test.ts'),
    false,
  );
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test -- src/add.test.ts'), false);
  assert.equal(satisfiesVerifierRequirement('vitest run', 'vitest run src/add.test.ts'), false);
});

test('directional coverage: full suite satisfies targeted requirement', () => {
  assert.equal(satisfiesVerifierRequirement('npm test -- src/add.test.ts', 'npm test'), true);
  assert.equal(
    satisfiesVerifierRequirement('vitest run src/add.test.ts', 'vitest run'),
    true,
  );
});

test('same-family path variants still match for full suite', () => {
  assert.equal(
    satisfiesVerifierRequirement('npm test', '"C:/Program Files/nodejs/npm" test'),
    true,
  );
  assert.equal(
    satisfiesVerifierRequirement('vitest run', '"C:/tmp/vitest" run'),
    true,
  );
  assert.equal(satisfiesVerifierRequirement('node --test', '"/usr/bin/node" --test'), true);
});

test('targeted requires matching selectors unless full covers', () => {
  assert.equal(
    satisfiesVerifierRequirement(
      'npm test -- src/a.test.ts',
      'npm test -- src/a.test.ts',
    ),
    true,
  );
  assert.equal(
    satisfiesVerifierRequirement(
      'npm test -- src/a.test.ts',
      'npm test -- src/b.test.ts',
    ),
    false,
  );
});

test('identity keys distinguish full from targeted for dedupe', () => {
  const full = analyzeVerifierIdentity('npm test');
  const narrow = analyzeVerifierIdentity('npm test -- src/a.test.ts');
  assert.ok(full && narrow);
  assert.notEqual(full.identityKey, narrow.identityKey);
  assert.equal(sameVerifierIdentity('npm test', 'npm test -- src/a.test.ts'), false);
});

test('npm run test is same family as npm test', () => {
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm run test'), true);
  assert.equal(analyzeVerifierIdentity('npm run test')?.family, 'npm-test');
});

test('classifies flag=value targeted filters correctly', () => {
  assert.equal(classifyVerifierScope('npm test -- -t=math'), 'targeted');
  assert.equal(classifyVerifierScope('pytest -k=math'), 'targeted');
  assert.equal(classifyVerifierScope('vitest run --test-name-pattern=math'), 'targeted');
  assert.equal(classifyVerifierScope('npm test -- --filter=math'), 'targeted');

  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test -- -t=math'), false);
  assert.equal(satisfiesVerifierRequirement('pytest', 'pytest -k=math'), false);
});

test('help and listing flags never satisfy a full-suite requirement', () => {
  // npm test --help prints npm's help for the test script and runs nothing;
  // the flag must not be dropped during scope analysis.
  assert.equal(classifyVerifierScope('npm test --help'), 'unknown');
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test --help'), false);
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test --version'), false);
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test -- -h'), false);
  // Listing-only pytest invocations are not executions either.
  assert.equal(classifyVerifierScope('pytest --collect-only'), 'unknown');
  assert.equal(satisfiesVerifierRequirement('pytest', 'pytest --collect-only'), false);
  assert.equal(satisfiesVerifierRequirement('vitest', 'vitest run --list'), false);
  // Two help invocations share an identity (still distinct from a real run).
  assert.equal(sameVerifierIdentity('npm test --help', 'npm test --help'), true);
  assert.equal(sameVerifierIdentity('npm test', 'npm test --help'), false);
});

test('legitimate runner flags still classify as executions', () => {
  assert.equal(classifyVerifierScope('npm test -- --coverage'), 'full');
  assert.equal(classifyVerifierScope('vitest run --reporter=verbose'), 'full');
  assert.equal(classifyVerifierScope('jest --runinband --silent'), 'full');
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm test -- --coverage'), true);
  assert.equal(satisfiesVerifierRequirement('npm test', 'npm run test --silent'), true);
});

test('selector arguments preserve case, Unicode and quoted whitespace', () => {
  for (const [required, actual] of [
    ['node --test --test-name-pattern=Alpha', 'node --test --test-name-pattern=alpha'],
    ['pytest -k "A  B"', 'pytest -k "A B"'],
    ['pytest -k "Étage"', 'pytest -k "étage"'],
    ['node --test Src/Value.test.js', 'node --test src/Value.test.js'],
    ['node --test "C:/Tests/Value.test.js"', 'node --test "C:/tests/Value.test.js"'],
    ['pytest -k "final."', 'pytest -k final'],
  ]) {
    assert.equal(satisfiesVerifierRequirement(required!, actual!), false, required);
    assert.equal(satisfiesVerifierRequirement(required!, required!), true, required);
  }
});

test('distinct argv token boundaries cannot alias structural selectors', () => {
  assert.notEqual(analyzeVerifierIdentity('pytest -k "a,b"')?.identityKey,
    analyzeVerifierIdentity('pytest -k a -m b')?.identityKey);
});

test('bare positional runner selectors are conservative and case-sensitive', () => {
  assert.equal(satisfiesVerifierRequirement('pytest Alpha', 'pytest alpha'), false);
  assert.equal(satisfiesVerifierRequirement('pytest', 'pytest Alpha'), false);
  assert.equal(satisfiesVerifierRequirement('pytest -k Alpha', 'pytest -m Alpha'), false);
});

test('runner-looking positional names remain targeted after the runner is stripped', () => {
  assert.equal(satisfiesVerifierRequirement('node --test', 'node --test test'), false);
  assert.equal(satisfiesVerifierRequirement('cargo test', 'cargo test run'), false);
});
