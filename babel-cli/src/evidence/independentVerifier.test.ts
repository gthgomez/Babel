import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveExecutionProfile } from '../config/executionProfiles.js';
import {
  IndependentVerifier,
  INDEPENDENT_VERIFIER_ENV,
  independentVerifierProofErrors,
  isIndependentVerifierOptIn,
} from './independentVerifier.js';

const HIGH_ASSURANCE = [
  'benchmark_container',
  'babel_research',
  'opencalw_manager',
] as const;

const EVERYDAY_OFF = [
  'safe_repo',
  'dev_local',
  'bench_local',
  'read_only_audit',
  'scaffold',
] as const;

test('isIndependentVerifierOptIn defaults false without env or high-assurance profile', () => {
  assert.equal(isIndependentVerifierOptIn({}), false);
  assert.equal(isIndependentVerifierOptIn({}, 'safe_repo'), false);
  assert.equal(isIndependentVerifierOptIn({}, 'dev_local'), false);
});

test('isIndependentVerifierOptIn env explicit OFF always wins', () => {
  for (const off of ['0', 'false', 'no', 'off', 'FALSE', 'OFF']) {
    for (const profile of [...HIGH_ASSURANCE, ...EVERYDAY_OFF]) {
      assert.equal(
        isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: off }, profile),
        false,
        `env=${off} profile=${profile}`,
      );
    }
  }
});

test('isIndependentVerifierOptIn env explicit ON always wins', () => {
  for (const on of ['1', 'true', 'yes', 'on', 'YES', 'TRUE']) {
    for (const profile of [...HIGH_ASSURANCE, ...EVERYDAY_OFF]) {
      assert.equal(
        isIndependentVerifierOptIn({ [INDEPENDENT_VERIFIER_ENV]: on }, profile),
        true,
        `env=${on} profile=${profile}`,
      );
    }
  }
});

test('isIndependentVerifierOptIn high-assurance profile default enables when env unset', () => {
  for (const profile of HIGH_ASSURANCE) {
    assert.equal(
      isIndependentVerifierOptIn({}, profile),
      true,
      `profile name ${profile}`,
    );
    assert.equal(
      isIndependentVerifierOptIn({}, resolveExecutionProfile(profile)),
      true,
      `profile object ${profile}`,
    );
  }
});

test('isIndependentVerifierOptIn everyday profiles stay off when env unset', () => {
  for (const profile of EVERYDAY_OFF) {
    assert.equal(
      isIndependentVerifierOptIn({}, profile),
      false,
      `profile ${profile}`,
    );
  }
});

test('isIndependentVerifierOptIn resolves BABEL_EXECUTION_PROFILE when profile arg omitted', () => {
  assert.equal(
    isIndependentVerifierOptIn({ BABEL_EXECUTION_PROFILE: 'benchmark_container' }),
    true,
  );
  assert.equal(
    isIndependentVerifierOptIn({ BABEL_EXECUTION_PROFILE: 'safe_repo' }),
    false,
  );
  assert.equal(
    isIndependentVerifierOptIn({
      BABEL_EXECUTION_PROFILE: 'babel_research',
      [INDEPENDENT_VERIFIER_ENV]: '0',
    }),
    false,
  );
  assert.equal(
    isIndependentVerifierOptIn({
      BABEL_EXECUTION_PROFILE: 'safe_repo',
      [INDEPENDENT_VERIFIER_ENV]: '1',
    }),
    true,
  );
});

test('isIndependentVerifierOptIn explicit profile arg beats BABEL_EXECUTION_PROFILE', () => {
  assert.equal(
    isIndependentVerifierOptIn(
      { BABEL_EXECUTION_PROFILE: 'benchmark_container' },
      'safe_repo',
    ),
    false,
  );
  assert.equal(
    isIndependentVerifierOptIn(
      { BABEL_EXECUTION_PROFILE: 'safe_repo' },
      'opencalw_manager',
    ),
    true,
  );
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

test('independentVerifierProofErrors empty when profile defaults off even if green', () => {
  const errors = independentVerifierProofErrors({
    projectRoot: process.cwd(),
    command: 'npm test',
    exitCode: 0,
    mutationPaths: [],
    env: {},
    profile: 'safe_repo',
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

test('independentVerifierProofErrors profile default enables clean-room path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-iv-profile-'));
  try {
    await fs.writeFile(path.join(tempDir, 'keep.txt'), 'ok');
    // env unset for IV flag; high-assurance profile should still opt in
    const failErrors = independentVerifierProofErrors({
      projectRoot: tempDir,
      command: 'node -e "process.exit(1)"',
      exitCode: 0,
      mutationPaths: ['keep.txt'],
      env: {},
      profile: 'benchmark_container',
    });
    assert.ok(failErrors.length >= 1);
    assert.match(failErrors[0] ?? '', /independent clean-room verifier failed/);

    const passErrors = independentVerifierProofErrors({
      projectRoot: tempDir,
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      mutationPaths: ['keep.txt'],
      env: {},
      profile: 'babel_research',
    });
    assert.deepEqual(passErrors, []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('independentVerifierProofErrors env OFF disables even high-assurance profile', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-iv-off-'));
  try {
    await fs.writeFile(path.join(tempDir, 'keep.txt'), 'ok');
    const errors = independentVerifierProofErrors({
      projectRoot: tempDir,
      command: 'node -e "process.exit(1)"',
      exitCode: 0,
      mutationPaths: ['keep.txt'],
      env: { [INDEPENDENT_VERIFIER_ENV]: 'off' },
      profile: 'benchmark_container',
    });
    // disabled → no clean-room run, no errors
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
