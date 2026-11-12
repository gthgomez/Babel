import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { setDockerAvailableForTest, resetDockerAvailabilityCache } from './config/benchmarkContainer.js';
import { resolveExecutionPolicyChoice, withExecutionPolicyChoice } from './config/executionPolicySelection.js';
import { SafeExecutor } from './sandbox.js';

test('isolated host command executions do not inherit either provider credential', async () => {
  const projectRoots = [mkdtempSync(join(tmpdir(), 'babel-host-native-a-')), mkdtempSync(join(tmpdir(), 'babel-host-native-b-'))];
  const names = [
    'BABEL_EXECUTION_PROFILE',
    'BABEL_ALLOW_HOST_FALLBACK',
    'BABEL_DOCKER_DISABLE',
    'BABEL_BENCHMARK_DOCKER_IMAGE',
  ] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  try {
    for (const projectRoot of projectRoots) writeFileSync(join(projectRoot, 'check-env.mjs'), `
const keys = ['OPENROUTER_API_KEY', 'COMMAND_CODE_API_KEY'];
const canaries = ['synthetic-provider-canary', 'synthetic-second-provider-canary'];
const leaked = keys.some((key) => Object.hasOwn(process.env, key)) || process.argv.some((arg) => canaries.some((value) => arg.includes(value)));
process.stdout.write(leaked ? 'present' : 'absent');
`);
    process.env['BABEL_EXECUTION_PROFILE'] = 'host_native';
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    delete process.env['BABEL_DOCKER_DISABLE'];
    delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    setDockerAvailableForTest(false);
    const sessions = [
      { name: 'OPENROUTER_API_KEY', canary: 'synthetic-provider-canary' },
      { name: 'COMMAND_CODE_API_KEY', canary: 'synthetic-second-provider-canary' },
    ];
    for (const [index, session] of sessions.entries()) {
      delete process.env['OPENROUTER_API_KEY'];
      delete process.env['COMMAND_CODE_API_KEY'];
      process.env[session.name] = session.canary;
      const result = await new SafeExecutor(projectRoots[index]!).shellExecAsync('node check-env.mjs', '.', 10_000);
      assert.equal(result.exit_code, 0);
      assert.equal(result.process_started, true);
      assert.equal(result.stdout, 'absent');
      for (const { canary } of sessions) assert.equal(JSON.stringify(result).includes(canary), false);
    }
  } finally {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['COMMAND_CODE_API_KEY'];
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetDockerAvailabilityCache();
    for (const projectRoot of projectRoots) rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a resumed Docker session cannot execute a host command when process settings disagree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-policy-'));
  const previous = process.env['BABEL_EXECUTION_PROFILE'];
  try {
    writeFileSync(join(root, 'should-not-run.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('ran', 'yes');");
    const choice = resolveExecutionPolicyChoice({ resume: true, persisted: {
      version: 1, profile: 'safe_repo', source: 'explicit', effectiveBoundary: 'docker',
    } });
    process.env['BABEL_EXECUTION_PROFILE'] = 'host_native';
    setDockerAvailableForTest(false);
    const result=await withExecutionPolicyChoice(choice, () =>
      new SafeExecutor(root).shellExecAsync('node should-not-run.mjs', '.', 10_000));
    assert.notEqual(result.exit_code,0);
    assert.notEqual(result.process_started,true);
    assert.equal(existsSync(join(root, 'ran')), false);
  } finally {
    if (previous === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previous;
    resetDockerAvailabilityCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid ambient profile cannot be hidden by a scoped session choice', async () => {
  const root=mkdtempSync(join(tmpdir(),'babel-invalid-scoped-policy-'));
  const previous=process.env['BABEL_EXECUTION_PROFILE'];
  try{
    process.env['BABEL_EXECUTION_PROFILE']='safe_reop';
    const choice={profile:'host_native',source:'persisted',expectedBoundary:'host'} as const;
    await assert.rejects(()=>withExecutionPolicyChoice(choice,()=>new SafeExecutor(root).shellExecAsync('node anything.mjs','.',10000)),/invalid execution profile/i);
  }finally{
    if(previous===undefined)delete process.env['BABEL_EXECUTION_PROFILE'];else process.env['BABEL_EXECUTION_PROFILE']=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test('an explicitly migrated host session executes its own boundary when the ambient profile is Docker', async () => {
  const root=mkdtempSync(join(tmpdir(),'babel-session-host-policy-'));
  const previous=process.env['BABEL_EXECUTION_PROFILE'];
  try{
    writeFileSync(join(root,'marker.mjs'),"process.stdout.write('host-fixture');");
    process.env['BABEL_EXECUTION_PROFILE']='safe_repo';
    setDockerAvailableForTest(false);
    const choice={profile:'host_native',source:'persisted',expectedBoundary:'host'} as const;
    const result=await withExecutionPolicyChoice(choice,()=>new SafeExecutor(root).shellExecAsync('node marker.mjs','.',10000));
    assert.equal(result.exit_code,0);
    assert.equal(result.stdout,'host-fixture');
  }finally{
    if(previous===undefined)delete process.env['BABEL_EXECUTION_PROFILE'];else process.env['BABEL_EXECUTION_PROFILE']=previous;
    resetDockerAvailabilityCache();rmSync(root,{recursive:true,force:true});
  }
});

test('named Docker and restricted host profiles do not silently run project code', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-profile-boundary-'));
  const names = [
    'BABEL_EXECUTION_PROFILE',
    'BABEL_ALLOW_HOST_FALLBACK',
    'BABEL_DOCKER_DISABLE',
    'BABEL_BENCHMARK_DOCKER_IMAGE',
  ] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  try {
    writeFileSync(join(projectRoot, 'should-not-run.mjs'), 'process.exitCode = 0;');
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    delete process.env['BABEL_DOCKER_DISABLE'];
    delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    setDockerAvailableForTest(false);
    for (const profile of ['safe_repo', 'dev_local']) {
      process.env['BABEL_EXECUTION_PROFILE'] = profile;
      const result = await new SafeExecutor(projectRoot).shellExecAsync('node should-not-run.mjs', '.', 10_000);
      assert.notEqual(result.exit_code, 0, profile);
      assert.notEqual(result.process_started, true, profile);
      assert.match(result.stderr, /isolation/i, profile);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetDockerAvailabilityCache();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
