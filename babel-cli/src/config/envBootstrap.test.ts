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
  // Private credential files must be owner-only; the loader rejects group/world-readable ones.
  writeFileSync(envPath, 'BABEL_ENV=from_file\nBABEL_ROOT=/from/file\n', { encoding: 'utf8', mode: 0o600 });

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
  assert.match(message, /Babel normally loads the private profile/);
  assert.match(message, /--strict-env/);
});

test('source CLI defaults to a private user configuration path', () => {
  const home = join(tmpdir(), 'env-home-fixture');
  assert.equal(resolvePrivateCredentialEnvPath({ HOME: home }), join(home, '.babel', 'config', '.env'));
  assert.equal(resolvePrivateCredentialEnvPath({ BABEL_CONFIG_DIR: join(home, 'profile') }), join(home, 'profile', '.env'));
});

test('private profile keys load without automatically reading selected project files', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-fixture-'));
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

test('conversation bootstrap ignores opted-in project and legacy package credentials',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-conversation-bootstrap-'));
  const configDir=join(root,'private');mkdirSync(configDir);
  writeFileSync(join(configDir,'.env'),'BABEL_ENV=test\n',{mode:0o600});
  const env:NodeJS.ProcessEnv={BABEL_CONFIG_DIR:configDir,BABEL_PROJECT_CREDENTIALS_DIR:join(root,'must-not-inspect'),BABEL_LEGACY_CLI_ENV:'1'};
  try{
    const result=loadBabelCliEnv(env,undefined,{executionScope:'conversation'});
    assert.equal(result.loaded,true);
    assert.equal(env['BABEL_ENV'],'test');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('native-resolved Desktop credentials never reload private, project or legacy dotenv state',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-resolved-credentials-'));
  const configDir=join(root,'private');mkdirSync(configDir);
  const file=join(configDir,'.env');
  writeFileSync(file,'OPENROUTER_API_KEY=syntheticRemovedCredential\nDEEPSEEK_API_KEY=syntheticOtherProvider\nBABEL_ROOT=untrusted-legacy-value\n',{mode:0o600});
  try{
    for(const executionScope of ['project','conversation'] as const){
      const env:NodeJS.ProcessEnv={BABEL_CONFIG_DIR:configDir,BABEL_DESKTOP_IPC:'1',BABEL_DESKTOP_CREDENTIALS_RESOLVED:'1',BABEL_PROJECT_CREDENTIALS_DIR:join(root,'must-not-inspect'),BABEL_LEGACY_CLI_ENV:'1'};
      const result=loadBabelCliEnv(env,undefined,{executionScope});
      assert.equal(result.loaded,false,'DESKTOP_CREDENTIAL_DOTENV_RELOADED');
      assert.equal(result.envFileExists,null,'skipped legacy file presence is unknown');
      assert.equal(result.skipped,'desktop_resolved_credentials');
      assert.equal(env['OPENROUTER_API_KEY']===undefined,true,'removed native key must remain absent');
      assert.equal(env['DEEPSEEK_API_KEY']===undefined,true,'unselected provider must remain absent');
      assert.equal(env['BABEL_ROOT']===undefined,true,'legacy policy values must remain absent');
      assert.deepEqual(getEnvFileKeysNotActiveInProcess(env,file),[],'resolved credentials must not trigger legacy-file probes');
      assert.equal(loadOptedInProjectCredentials(env),false,'native resolution must not reopen project credentials');
      assert.equal(loadBabelCliEnv(env,file).loaded,false,'explicit file callers cannot resurrect a removed key');
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('native credential resolution requires both exact host markers and preserves its selected value',()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-resolved-marker-'));
  const file=join(root,'.env');writeFileSync(file,'BABEL_ENV=fixture-file\n',{mode:0o600});
  try{
    for(const markers of [{},{BABEL_DESKTOP_IPC:'1'},{BABEL_DESKTOP_CREDENTIALS_RESOLVED:'1'},{BABEL_DESKTOP_IPC:'1',BABEL_DESKTOP_CREDENTIALS_RESOLVED:'true'},{BABEL_DESKTOP_IPC:'true',BABEL_DESKTOP_CREDENTIALS_RESOLVED:'1'}]){
      const env:NodeJS.ProcessEnv={...markers};
      assert.equal(loadBabelCliEnv(env,file).loaded,true);
      assert.equal(env['BABEL_ENV']==='fixture-file',true);
    }
    const env:NodeJS.ProcessEnv={BABEL_DESKTOP_IPC:'1',BABEL_DESKTOP_CREDENTIALS_RESOLVED:'1',OPENROUTER_API_KEY:'fixture-native'};
    assert.equal(loadBabelCliEnv(env,file).loaded,false,'DESKTOP_CREDENTIAL_DOTENV_RELOADED');
    assert.equal(env['OPENROUTER_API_KEY']==='fixture-native',true,'native selected value must remain intact');
  }finally{rmSync(root,{recursive:true,force:true});}
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
