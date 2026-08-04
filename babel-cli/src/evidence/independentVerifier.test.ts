import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IndependentVerifier,
  INDEPENDENT_VERIFIER_ENV,
  independentVerifierProofErrors,
  isIndependentVerifierOptIn,
} from './independentVerifier.js';

test('isIndependentVerifierOptIn defaults false', () => {
  assert.equal(isIndependentVerifierOptIn({}), false);
  assert.equal(isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: '0' }), false);
  assert.equal(isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: 'false' }), false);
});

test('isIndependentVerifierOptIn accepts 1/true/yes/on', () => {
  assert.equal(isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: '1' }), true);
  assert.equal(isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: 'true' }), true);
  assert.equal(isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: 'YES' }), true);
  assert.equal(isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: 'on' }), true);
});

test('independentVerifierProofErrors is empty when opt-in disabled', () => {
  const errors = independentVerifierProofErrors({
    projectRoot: process.cwd(),
    command: 'npm test',
    exitCode: 0,
    mutationPaths: [],
    env: {},
  });
  assert.deepEqual(errors, []);
});

test('independentVerifierProofErrors reports failure when clean-room exits non-zero', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-iv-'));
  try {
    await fs.writeFile(path.join(tempDir, 'keep.txt'), 'ok');
    const errors = independentVerifierProofErrors({
      projectRoot: tempDir,
      // exit 1 in the clean-room copy
      command: 'node -e "process.exit(1)"',
      exitCode: 0,
      mutationPaths: ['keep.txt'],
      env: { [INDEPENDENT_VERIFIER_ENV]: '1' },
    });
    assert.ok(errors.length >= 1);
    assert.match(errors[0] ?? '', /independent clean-room verifier failed/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('independentVerifierProofErrors empty when clean-room exits 0', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-iv-ok-'));
  try {
    await fs.writeFile(path.join(tempDir, 'keep.txt'), 'ok');
    const errors = independentVerifierProofErrors({
      projectRoot: tempDir,
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      mutationPaths: ['keep.txt'],
      env: { [INDEPENDENT_VERIFIER_ENV]: '1' },
    });
    assert.deepEqual(errors, []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('runIsolatedVerificationSync leaves primary workspace un-mutated', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-iv-sync-'));
  try {
    const filePath = path.join(tempDir, 'file.txt');
    await fs.writeFile(filePath, 'original');
    const receipt = IndependentVerifier.runIsolatedVerificationSync(
      tempDir,
      "node -e \"require('node:fs').writeFileSync('file.txt', 'mutated')\"",
      ['file.txt'],
    );
    const content = await fs.readFile(filePath, 'utf-8');
    assert.equal(content.trim(), 'original');
    assert.equal(receipt.exitCode, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
