import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  formatEnvFileInactiveMessage,
  getEnvFileKeysNotActiveInProcess,
  isStrictEnvMode,
  loadBabelCliEnv,
  parseEnvFileKeys,
} from './envBootstrap.js';

test('parseEnvFileKeys ignores comments and empty values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-env-bootstrap-'));
  const envPath = join(dir, '.env');
  writeFileSync(
    envPath,
    ['# comment', 'BABEL_ROOT=/tmp/babel', 'EMPTY=', 'BABEL_ENV=test'].join('\n'),
    'utf8',
  );

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
  assert.equal(isStrictEnvMode(['node', 'babel', 'run', '--strict-env', 'task'], {}), true);
  assert.equal(isStrictEnvMode(['node', 'babel', 'run', 'task'], {}), false);
  assert.equal(isStrictEnvMode(['node', 'babel', 'run', 'task'], { CI: 'true' }), true);
  assert.equal(isStrictEnvMode(['node', 'babel', 'run', 'task'], { BABEL_STRICT_ENV: '1' }), true);
});

test('formatEnvFileInactiveMessage includes canonical invocation hints', () => {
  const message = formatEnvFileInactiveMessage(['BABEL_ROOT'], '/tmp/.env');
  assert.match(message, /node --env-file=\.\/babel-cli\/\.env/);
  assert.match(message, /--strict-env/);
});
