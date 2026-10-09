import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  formatEnvFileInactiveMessage,
  getEnvFileKeysNotActiveInProcess,
  isStrictEnvMode,
  loadBabelCliEnv,
  parseEnvFileKeys,
  resolvePrivateCredentialEnvPath,
  loadOptedInProjectCredentials,
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

test('source CLI defaults to a private user configuration path', () => {
  const home = join(tmpdir(), 'babel-private-example');
  assert.equal(resolvePrivateCredentialEnvPath({ HOME: home }), join(home, '.babel', 'config', '.env'));
  assert.equal(resolvePrivateCredentialEnvPath({ BABEL_CONFIG_DIR: join(home, 'profile') }), join(home, 'profile', '.env'));
});

test('private profile keys load without automatically reading selected project files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-private-env-'));
  const configDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(configDir);
  mkdirSync(project);
  writeFileSync(join(configDir, '.env'), 'OPENROUTER_API_KEY=syntheticPrivateValue123\n', {mode:0o600});
  writeFileSync(join(project, '.env'), 'BABEL_ROOT=untrusted\nDEEPSEEK_API_KEY=syntheticProjectValue123\n');
  const env: NodeJS.ProcessEnv = { BABEL_CONFIG_DIR: configDir };
  try {
    const report = loadBabelCliEnv(env);
    assert.equal(report.loaded, true);
    assert.equal(env['OPENROUTER_API_KEY'], 'syntheticPrivateValue123');
    assert.equal(env['DEEPSEEK_API_KEY'], undefined);
    assert.equal(env['BABEL_ROOT'], undefined);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('project credential opt-in only reads certified key names from Git-ignored .env', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root], {stdio:'ignore'});
    writeFileSync(join(root, '.gitignore'), '.env\n');
    writeFileSync(join(root, '.env'), 'BABEL_ROOT=untrusted\nNODE_OPTIONS=--inspect\nOPENROUTER_API_KEY=syntheticProjectKey123\n', {mode:0o600});
    const env: NodeJS.ProcessEnv = {BABEL_PROJECT_CREDENTIALS_DIR:root};
    assert.equal(loadOptedInProjectCredentials(env), true);
    assert.equal(env['OPENROUTER_API_KEY'], 'syntheticProjectKey123');
    assert.equal(env['BABEL_ROOT'], undefined);
    assert.equal(env['NODE_OPTIONS'], undefined);
    const envWithHigherPriority: NodeJS.ProcessEnv = {BABEL_PROJECT_CREDENTIALS_DIR:root, OPENROUTER_API_KEY:'from-environment'};
    loadOptedInProjectCredentials(envWithHigherPriority);
    assert.equal(envWithHigherPriority['OPENROUTER_API_KEY'], 'from-environment');
    execFileSync('git', ['-C', root, 'add', '-f', '.env'], {stdio:'ignore'});
    assert.throws(()=>loadOptedInProjectCredentials({BABEL_PROJECT_CREDENTIALS_DIR:root}), /not confirmed ignored and untracked/);
  } finally { rmSync(root, {recursive:true, force:true}); }
});
