/**
 * Effect-level credential boundary (SC-03/SC-04/SC-14).
 *
 * Synthetic fixtures only: inert canary strings live in a temporary directory
 * and are never real credentials. The assertions are about effects (what a
 * tool may read), not about which command spellings look suspicious.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decodeCommand } from './commandDecoder.js';
import { isCredentialPathReference, isCredentialTargetPath } from './protectedPath.js';
import { SafeExecutor, isCredentialReadPath } from '../sandbox.js';
import { isCredentialExposureCommand } from './commandDecoder.js';

const CANARY = 'w08-synthetic-inert-canary-value';
const SECOND_CANARY = 'w08-second-synthetic-inert-canary';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-credential-boundary-'));
  writeFileSync(join(root, '.env'), `SYNTHETIC_TOKEN=${CANARY}\n`);
  writeFileSync(join(root, '.npmrc'), `//registry.invalid/:_authToken=${SECOND_CANARY}\n`);
  writeFileSync(join(root, '.env.example'), 'SYNTHETIC_TOKEN=your-value-here\n');
  writeFileSync(join(root, 'normal.txt'), 'ordinary fixture content\n');
  writeFileSync(join(root, 'id_ed25519'), 'synthetic-key-material\n');
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets', 'token.txt'), `${CANARY}\n`);
  mkdirSync(join(root, '.ssh'));
  writeFileSync(join(root, '.ssh', 'id_rsa'), 'synthetic-key-material\n');
  mkdirSync(join(root, '.aws'));
  writeFileSync(join(root, '.aws', 'credentials'), `aws_secret_access_key=${CANARY}\n`);
  return root;
}

function withoutCanary(result: unknown): boolean {
  const text = JSON.stringify(result);
  return !text.includes(CANARY) && !text.includes(SECOND_CANARY);
}

test('credential path classification is one registry shared by file effects and command decoding', () => {
  const paths = ['.env', '.npmrc', 'id_ed25519', '.ssh/id_rsa', '.aws/credentials', 'secrets/token.txt'];
  for (const path of paths) {
    assert.equal(isCredentialReadPath(path), true, path);
    assert.equal(isCredentialTargetPath(path), true, path);
    assert.equal(isCredentialReadPath(path), isCredentialTargetPath(path), path);
  }
  for (const path of ['.env.example', '.env.sample', 'normal.txt', 'src/index.ts']) {
    assert.equal(isCredentialReadPath(path), false, path);
    assert.equal(isCredentialTargetPath(path), false, path);
  }
  assert.equal(isCredentialPathReference('git show HEAD:.env'), true);
  assert.equal(isCredentialPathReference('rg TOKEN .npmrc'), true);
  assert.equal(isCredentialPathReference('npm test -- .env.test'), true, 'path classifier is conservative; command gate stays shape-aware');
});

test('file_read denies credential-class effects without returning canary bytes', () => {
  const root = fixture();
  const executor = new SafeExecutor(root);
  try {
    for (const path of ['.env', '.npmrc', 'id_ed25519', '.ssh/id_rsa', '.aws/credentials', 'secrets/token.txt']) {
      const result = executor.fileRead(path);
      assert.equal(result.exit_code, 1, path);
      assert.equal(result.denial?.reason_code, 'credential_read_denied', path);
      assert.equal(withoutCanary(result), true, `${path} leaked canary`);
    }
    const example = executor.fileRead('.env.example');
    assert.equal(example.exit_code, 0);
    assert.match(example.stdout, /your-value-here/);
    const ordinary = executor.fileRead('normal.txt');
    assert.equal(ordinary.exit_code, 0);
    assert.match(ordinary.stdout, /ordinary fixture content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shell execution denies credential-class effects before a process starts', async () => {
  const root = fixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'host_native';
  const executor = new SafeExecutor(root);
  try {
    for (const command of [
      'cat .env',
      'cat .npmrc',
      'cat .ssh/id_rsa',
      'cat .aws/credentials',
      'cat secrets/token.txt',
      'rg anything .npmrc',
    ]) {
      const result = await executor.shellExecAsync(command, root, 10_000);
      assert.equal(result.exit_code, 1, command);
      assert.equal(result.process_started, undefined, `${command} must not start a process`);
      assert.equal(result.denial?.reason_code, 'credential_read_denied', command);
      assert.equal(withoutCanary(result), true, `${command} leaked canary`);
    }

    // Positive controls: documentation template and ordinary files still run.
    const example = await executor.shellExecAsync('cat .env.example', root, 10_000);
    assert.equal(example.exit_code, 0);
    assert.equal(example.process_started, true);
    const ordinary = await executor.shellExecAsync('cat normal.txt', root, 10_000);
    assert.equal(ordinary.exit_code, 0);
    assert.match(ordinary.stdout, /ordinary fixture content/);

    // Not every path-looking test operand is a credential effect.
    const testOperand = await executor.shellExecAsync('node --test --test-name-pattern=fixture .env.test.mjs', root, 10_000);
    assert.notEqual(testOperand.denial?.reason_code, 'credential_read_denied');
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('decoded credential effects cover registry, transfer and Git inspection variants', () => {
  for (const command of [
    'cat .env',
    'cat .npmrc',
    'cp .env /tmp/out',
    'tar -czf out.tgz .env',
    'git show HEAD:.env',
    'rg TOKEN .npmrc',
  ]) {
    assert.equal(decodeCommand(command).capability, 'expose_credentials', command);
  }
  for (const command of ['cat .env.example', 'cat normal.txt', 'git commit -m "docs: describe .env handling"', 'npm test -- .env.test']) {
    assert.notEqual(decodeCommand(command).capability, 'expose_credentials', command);
  }
  assert.equal(isCredentialExposureCommand('cat .env'), true);
  assert.equal(isCredentialExposureCommand('git commit -m "refs .env.example"'), false);
});

test(
  'a symlinked credential target is denied when it resolves into a credential path',
  { skip: process.platform === 'win32' ? 'POSIX symlink fixture' : false },
  () => {
    const root = fixture();
    try {
      symlinkSync(join(root, '.env'), join(root, 'linked-config'));
      const executor = new SafeExecutor(root);
      // The raw argument is not credential-shaped, but the resolved target is.
      const result = executor.fileRead('linked-config');
      assert.equal(result.exit_code, 1);
      assert.equal(result.denial?.reason_code, 'credential_read_denied');
      assert.equal(withoutCanary(result), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
