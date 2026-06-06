import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  formatEnvFileInactiveMessage,
  getEnvFileKeysNotActiveInProcess,
  isStrictEnvMode,
  loadBabelCliEnv,
  parseEnvFileKeys,
  wasBabelCliEnvFileLoaded,
} from './envBootstrap.js';

const babelCliRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distIndex = join(babelCliRoot, 'dist/index.js');

test('parseEnvFileKeys ignores comments and empty values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-env-bootstrap-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, [
    '# comment',
    'BABEL_ROOT=/tmp/babel',
    'EMPTY=',
    'BABEL_ENV=test',
  ].join('\n'), 'utf8');

  try {
    assert.deepEqual(parseEnvFileKeys(envPath).sort(), ['BABEL_ENV', 'BABEL_ROOT']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBabelCliEnv applies file values without overriding existing env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-env-bootstrap-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'BABEL_ENV=from_file\nBABEL_ROOT=/from/file\n', 'utf8');

  const env: NodeJS.ProcessEnv = {
    BABEL_ENV: 'preset',
  };

  try {
    const { loaded } = loadBabelCliEnv(env, envPath);
    assert.equal(loaded, true);
    assert.equal(env['BABEL_ENV'], 'preset');
    assert.equal(env['BABEL_ROOT'], '/from/file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getEnvFileKeysNotActiveInProcess reports keys missing from process env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-env-bootstrap-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'BABEL_ROOT=/tmp/babel\nDEEPINFRA_API_KEY=secret\n', 'utf8');

  try {
    const missing = getEnvFileKeysNotActiveInProcess({ BABEL_ENV: 'test' }, envPath);
    assert.deepEqual(missing.sort(), ['BABEL_ROOT', 'DEEPINFRA_API_KEY']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isStrictEnvMode honors argv and CI env', () => {
  assert.equal(isStrictEnvMode(['node', 'babel', 'run', '--strict-env', 'task']), true);
  assert.equal(isStrictEnvMode(['node', 'babel', 'run', 'task']), false);
  assert.equal(
    isStrictEnvMode(['node', 'babel', 'run', 'task']),
    false,
  );
  const previousCi = process.env['CI'];
  process.env['CI'] = 'true';
  try {
    assert.equal(isStrictEnvMode(['node', 'babel', 'run', 'task']), true);
  } finally {
    if (previousCi === undefined) {
      delete process.env['CI'];
    } else {
      process.env['CI'] = previousCi;
    }
  }
});

test('formatEnvFileInactiveMessage includes canonical invocation hints', () => {
  const message = formatEnvFileInactiveMessage(['BABEL_ROOT'], '/tmp/.env');
  assert.match(message, /node --env-file=\.\/babel-cli\/\.env/);
  assert.match(message, /--strict-env/);
});

test('babel-cli entry auto-loads package .env when present', () => {
  const envPath = join(babelCliRoot, '.env');
  if (!wasBabelCliEnvFileLoaded()) {
    return;
  }

  const keys = parseEnvFileKeys(envPath);
  if (keys.length === 0) {
    return;
  }

  const missing = getEnvFileKeysNotActiveInProcess();
  assert.equal(missing.length, 0, `expected auto-loaded keys to be active: ${missing.join(', ')}`);
});

test('spawned CLI auto-loads babel-cli/.env without node --env-file', (t) => {
  const envPath = join(babelCliRoot, '.env');
  if (!wasBabelCliEnvFileLoaded()) {
    t.skip('babel-cli/.env is not present; skipping spawn auto-load test');
    return;
  }

  const keys = parseEnvFileKeys(envPath).filter((key) => key.startsWith('BABEL_'));
  if (keys.length === 0) {
    t.skip('babel-cli/.env has no BABEL_* keys; skipping spawn auto-load test');
    return;
  }

  const sampleKey = keys[0]!;
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('BABEL_') || key === 'DEEPINFRA_API_KEY') {
      delete cleanEnv[key];
    }
  }

  const result = spawnSync(
    process.execPath,
    [distIndex, 'doctor', '--scope', 'env', '--json'],
    {
      cwd: babelCliRoot,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(cleanEnv[sampleKey], undefined);
  const payload = JSON.parse(result.stdout) as { status?: string };
  assert.equal(payload.status, 'pass');
});

test('spawned CLI exits non-zero with --strict-env when .env keys stay inactive', (t) => {
  const envPath = join(babelCliRoot, '.env');
  if (!wasBabelCliEnvFileLoaded()) {
    t.skip('babel-cli/.env is not present; skipping strict-env spawn test');
    return;
  }

  const keys = parseEnvFileKeys(envPath);
  if (keys.length === 0) {
    t.skip('babel-cli/.env has no active keys; skipping strict-env spawn test');
    return;
  }

  const blockedKey = keys[0]!;
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('BABEL_') || key === 'DEEPINFRA_API_KEY') {
      delete cleanEnv[key];
    }
  }
  cleanEnv[blockedKey] = '';

  const result = spawnSync(
    process.execPath,
    [distIndex, 'run', '--strict-env', '--json', 'env bootstrap strict probe'],
    {
      cwd: babelCliRoot,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /not active in this process|missing_env_keys/i);
});
