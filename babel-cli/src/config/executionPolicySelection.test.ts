import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertExecutionBoundary, getScopedExecutionProfile, loadExecutionPolicyRecord, persistExecutionPolicyRecord, resolveExecutionPolicyChoice, scopeExecutionPolicyGenerator } from './executionPolicySelection.js';

test('new sessions resolve explicit selection, environment, then the proposed default', () => {
  const options = { defaultProfile: 'host_native' } as const;
  assert.deepEqual(resolveExecutionPolicyChoice(options), { profile: 'host_native', source: 'default' });
  assert.deepEqual(resolveExecutionPolicyChoice({ ...options, environmentProfile: 'safe_repo' }), { profile: 'safe_repo', source: 'environment' });
  assert.deepEqual(resolveExecutionPolicyChoice({ ...options, environmentProfile: 'safe_repo', explicitProfile: 'host_native' }), { profile: 'host_native', source: 'explicit' });
  assert.throws(() => resolveExecutionPolicyChoice({ ...options, explicitProfile: 'safe_reop' }), /invalid execution profile/i);
  assert.throws(() => resolveExecutionPolicyChoice({ ...options, explicitProfile: 'host_native', environmentProfile: 'safe_reop' }), /invalid execution profile/i);
});

test('durable policy metadata is versioned and corrupt records fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-policy-record-'));
  try {
    assert.equal(loadExecutionPolicyRecord(root), null);
    const choice = resolveExecutionPolicyChoice({ explicitProfile: 'safe_repo' });
    persistExecutionPolicyRecord(root, choice, { kind: 'docker' });
    const saved = loadExecutionPolicyRecord(root);
    assert.deepEqual(saved, { version: 1, profile: 'safe_repo', source: 'explicit', effectiveBoundary: 'docker' });
    assert.equal(resolveExecutionPolicyChoice({ resume: true, persisted: saved }).expectedBoundary, 'docker');
    const hostChoice = resolveExecutionPolicyChoice({ explicitProfile: 'host_native' });
    assert.throws(() => persistExecutionPolicyRecord(root, hostChoice, { kind: 'host_profile', profile: 'host_native' }), /already exists/i);
    assert.deepEqual(loadExecutionPolicyRecord(root), saved);
    writeFileSync(join(root, '.execution-policy-interrupted.tmp'), '{partial');
    assert.deepEqual(loadExecutionPolicyRecord(root), saved);
    const migration = resolveExecutionPolicyChoice({ resume: true, explicitProfile: 'host_native', persisted: saved });
    persistExecutionPolicyRecord(root, migration, { kind: 'host_profile', profile: 'host_native' });
    assert.deepEqual(loadExecutionPolicyRecord(root), { version: 1, profile: 'host_native', source: 'migration', effectiveBoundary: 'host' });
    writeFileSync(join(root, 'execution-policy.json'), '{broken');
    assert.throws(() => loadExecutionPolicyRecord(root), /invalid.*policy/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume preserves the recorded boundary and requires an explicit choice when it is unknown', () => {
  const saved = { version: 1, profile: 'safe_repo', source: 'default', effectiveBoundary: 'docker' } as const;
  const choice = resolveExecutionPolicyChoice({ resume: true, persisted: saved, environmentProfile: 'safe_repo', defaultProfile: 'host_native' });
  assert.deepEqual(choice, { profile: 'safe_repo', source: 'persisted', expectedBoundary: 'docker' });
  // A different ambient profile must not silently replace the recorded
  // boundary, even when the ambient profile is less restrictive.
  assert.throws(() => resolveExecutionPolicyChoice({ resume: true, persisted: saved, environmentProfile: 'host_native' }), /differs from the saved/i);
  assert.throws(() => resolveExecutionPolicyChoice({ resume: true, environmentProfile: 'host_native' }), /explicit execution profile/i);
  assert.throws(() => resolveExecutionPolicyChoice({ resume: true, persisted: { ...saved, profile: 'safe_reop' } }), /invalid.*policy/i);
  assert.throws(() => resolveExecutionPolicyChoice({ resume: true, explicitProfile:'host_native', persisted:{ ...saved, profile:'safe_reop' } }), /invalid.*policy/i);
  assert.deepEqual(resolveExecutionPolicyChoice({ resume: true, explicitProfile: 'host_native' }), { profile: 'host_native', source: 'migration' });
  assert.doesNotThrow(() => assertExecutionBoundary(choice, { kind: 'docker' }));
  assert.throws(() => assertExecutionBoundary(choice, { kind: 'host_escalated', profile: 'safe_repo', reason: 'fixture' }), /boundary/i);
  assert.throws(() => assertExecutionBoundary(choice, { kind: 'fail_closed', profile: 'safe_repo', reason: 'fixture' }), /boundary/i);
  assert.throws(() => assertExecutionBoundary({ profile: 'host_native', source: 'explicit' }, { kind: 'docker' }), /boundary/i);
  assert.throws(() => assertExecutionBoundary({ profile: 'safe_repo', source: 'explicit' }, { kind: 'host_profile', profile: 'safe_repo' }), /boundary/i);
});

test('interleaved generator steps retain their own session policies without leaking to the caller',async()=>{
  const make=(expected:'host_native'|'safe_repo')=>scopeExecutionPolicyGenerator(
    {profile:expected,source:'persisted',expectedBoundary:expected==='host_native'?'host':'docker'},
    (async function*(){yield getScopedExecutionProfile('safe_repo');await Promise.resolve();yield getScopedExecutionProfile('safe_repo');})(),
  );
  const host=make('host_native'),docker=make('safe_repo');
  assert.equal((await host.next()).value,'host_native');
  assert.equal((await docker.next()).value,'safe_repo');
  assert.equal((await host.next()).value,'host_native');
  assert.equal((await docker.next()).value,'safe_repo');
  assert.equal(getScopedExecutionProfile('safe_repo'),'safe_repo');
  await host.return();await docker.return();
});
