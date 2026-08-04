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
