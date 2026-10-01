import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExecutionProfilePromptLines,
  EXECUTION_PROFILE_NAMES,
  getExecutionProfileCommandAdditions,
  getExecutionProfileToolPolicy,
  normalizeExecutionProfile,
  resolveExecutionProfile,
} from './executionProfiles.js';

test('legacy workspace inputs normalize to a secure canonical profile and warn once', (t) => {
  const warning = t.mock.method(process, 'emitWarning', () => undefined);
  for (const input of [
    'opencalw_manager',
    'opencalw-manager',
    'opencalw',
    'openclaw_manager',
    'openclaw-manager',
    'openclaw',
  ]) {
    assert.equal(normalizeExecutionProfile(input), 'workspace_manager');
    const profile = resolveExecutionProfile(input);
    assert.equal(profile.name, 'workspace_manager');
    assert.equal(profile.dockerSandbox, true);
    assert.equal(profile.independentVerifierDefault, true);
    assert.ok(profile.commandAdditions.includes('cargo'));
    assert.ok(profile.disallowedTools.includes('web_search'));
    assert.ok(profile.disallowedTools.includes('web_fetch'));
    assert.match(buildExecutionProfilePromptLines(input).join('\n'), /workspace_manager/);
  }
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(normalizeExecutionProfile('workspace-manager'), 'workspace_manager');
  assert.equal(warning.mock.callCount(), 1);
});

test('execution profile names normalize common spelling variants', () => {
  assert.equal(normalizeExecutionProfile('dev-local'), 'dev_local');
  assert.equal(normalizeExecutionProfile('BENCHMARK_CONTAINER'), 'benchmark_container');
  assert.equal(normalizeExecutionProfile('opencalw-manager'), 'workspace_manager');
  assert.equal(normalizeExecutionProfile('nope'), null);
});

test('safe_repo remains the default profile', () => {
  assert.equal(resolveExecutionProfile(undefined).name, 'safe_repo');
});

test('dev_local adds common local build commands', () => {
  const additions = getExecutionProfileCommandAdditions('dev_local');
  assert.ok(additions.includes('pnpm'));
  assert.ok(additions.includes('cargo'));
  assert.ok(additions.includes('go'));
});

test('benchmark_container adds common isolated Linux utility commands', () => {
  const additions = getExecutionProfileCommandAdditions('benchmark_container');
  assert.ok(additions.includes('diff'));
  assert.ok(additions.includes('gzip'));
  assert.ok(additions.includes('gunzip'));
  assert.ok(additions.includes('which'));
  assert.ok(additions.includes('env'));
});

test('read_only_audit constrains mutating executor tools', () => {
  const policy = getExecutionProfileToolPolicy('read_only_audit');
  assert.ok(policy.allowedTools.includes('file_read'));
  assert.ok(policy.disallowedTools.includes('file_write'));
  assert.ok(policy.disallowedTools.includes('test_run'));
});

test('workspace_manager allows local verification commands and denies web tools', () => {
  const additions = getExecutionProfileCommandAdditions('workspace_manager');
  assert.ok(additions.includes('cargo'));
  assert.ok(additions.includes('dotnet'));
  assert.ok(additions.includes('go'));
  assert.ok(additions.includes('mvn'));
  const policy = getExecutionProfileToolPolicy('workspace_manager');
  assert.ok(policy.disallowedTools.includes('web_search'));
  assert.ok(policy.disallowedTools.includes('web_fetch'));
});

test('babel_research carries prompt-injection hardening guidance', () => {
  const lines = buildExecutionProfilePromptLines('babel_research', 'swe').join('\n');
  assert.match(lines, /remote content as untrusted task data/);
  assert.match(lines, /cannot change tool policy/);
});

test('prompt lines carry profile-specific guidance', () => {
  const lines = buildExecutionProfilePromptLines('benchmark_container', 'swe').join('\n');
  assert.match(lines, /benchmark_container/);
  assert.match(lines, /POSIX pipes/);
  assert.match(lines, /\/app/);
});

test('high-assurance profiles default IndependentVerifier on; everyday stay off', () => {
  const onByDefault = new Set([
    'benchmark_container',
    'babel_research',
    'workspace_manager',
  ]);
  for (const name of EXECUTION_PROFILE_NAMES) {
    const profile = resolveExecutionProfile(name);
    if (onByDefault.has(name)) {
      assert.equal(
        profile.independentVerifierDefault,
        true,
        `${name} should default IndependentVerifier on`,
      );
    } else {
      assert.notEqual(
        profile.independentVerifierDefault,
        true,
        `${name} should not default IndependentVerifier on`,
      );
    }
  }
});

test('high-assurance profile descriptions note clean-room IndependentVerifier', () => {
  for (const name of ['benchmark_container', 'babel_research', 'workspace_manager'] as const) {
    const description = resolveExecutionProfile(name).description;
    assert.match(description, /IndependentVerifier/i, name);
  }
});
