/**
 * Effective execution boundary truth table (SC-01/SC-09).
 *
 * The claim under test is the one a user sees *before* a command runs: which
 * OS-enforced boundary applies, and who holds filesystem/network authority.
 * Synthetic image names only; no Docker daemon is required.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDockerAvailabilityCache, setDockerAvailableForTest } from './benchmarkContainer.js';
import {
  hasHostIsolationEscalation,
  ORDINARY_CHAT_EXECUTION_PROFILE,
  resolveEffectiveExecutionBoundary,
} from './effectiveExecutionBoundary.js';

const IMAGE = 'synthetic.invalid/w08-boundary:test';

function withDocker(available: boolean): void {
  setDockerAvailableForTest(available);
}

test('ordinary chat default is host-native and never claims an OS sandbox', () => {
  withDocker(true);
  try {
    const boundary = resolveEffectiveExecutionBoundary({ env: {} });
    assert.equal(boundary.profile, ORDINARY_CHAT_EXECUTION_PROFILE);
    assert.equal(boundary.boundary, 'host_native');
    assert.equal(boundary.authority, 'host_os_user');
    assert.equal(boundary.requiredBoundary, 'host');
    assert.equal(boundary.escalation, false);
    assert.equal(boundary.failClosed, false);
    assert.match(boundary.disclosure, /host-native/);
    assert.match(boundary.disclosure, /OS user/);
    assert.match(boundary.disclosure, /not an OS sandbox/);
    assert.match(boundary.disclosure, /credential/);
    assert.doesNotMatch(boundary.disclosure, /safe_repo uses Docker|default safe_repo/i);
  } finally {
    resetDockerAvailabilityCache();
  }
});

test('a container profile reports Docker only when the boundary is actually available', () => {
  withDocker(true);
  try {
    const docker = resolveEffectiveExecutionBoundary({ profile: 'safe_repo', env: { BABEL_BENCHMARK_DOCKER_IMAGE: IMAGE } });
    assert.equal(docker.boundary, 'docker');
    assert.equal(docker.authority, 'container');
    assert.equal(docker.requiredBoundary, 'docker');
    assert.equal(docker.failClosed, false);
    assert.match(docker.disclosure, /container \(Docker\)/);
  } finally {
    resetDockerAvailabilityCache();
  }

  withDocker(false);
  try {
    const unavailable = resolveEffectiveExecutionBoundary({ profile: 'safe_repo', env: { BABEL_BENCHMARK_DOCKER_IMAGE: IMAGE } });
    assert.equal(unavailable.boundary, 'unavailable');
    assert.equal(unavailable.failClosed, true);
    assert.match(unavailable.disclosure, /fail closed/);
    assert.match(unavailable.disclosure, /do not fall back/);
  } finally {
    resetDockerAvailabilityCache();
  }
});

test('host fallback and Docker-disable switches are disclosed as explicit escalation', () => {
  withDocker(false);
  try {
    for (const env of [
      { BABEL_ALLOW_HOST_FALLBACK: '1', BABEL_BENCHMARK_DOCKER_IMAGE: IMAGE },
      { BABEL_ALLOW_HOST_FALLBACK: 'true', BABEL_BENCHMARK_DOCKER_IMAGE: IMAGE },
      { BABEL_DOCKER_DISABLE: 'true', BABEL_BENCHMARK_DOCKER_IMAGE: IMAGE },
    ]) {
      const boundary = resolveEffectiveExecutionBoundary({ profile: 'safe_repo', env });
      assert.equal(boundary.boundary, 'host_escalated', JSON.stringify(env));
      assert.equal(boundary.escalation, true);
      assert.equal(boundary.authority, 'host_os_user');
      assert.match(boundary.disclosure, /explicitly waived/);
      assert.match(boundary.disclosure, /OS user/);
      assert.match(boundary.disclosure, /not an OS sandbox/);
    }
    assert.equal(hasHostIsolationEscalation({ BABEL_ALLOW_HOST_FALLBACK: '1' }), true);
    assert.equal(hasHostIsolationEscalation({ BABEL_ALLOW_HOST_FALLBACK: '0' }), false);
  } finally {
    resetDockerAvailabilityCache();
  }
});

test('non-container host profiles disclose their policy-limited host boundary', () => {
  const boundary = resolveEffectiveExecutionBoundary({ profile: 'dev_local', env: {} });
  assert.equal(boundary.boundary, 'host_profile');
  assert.equal(boundary.authority, 'host_os_user');
  assert.match(boundary.disclosure, /host-local/);
  assert.match(boundary.disclosure, /command policy/);
});

test('the boundary resolver rejects unknown profiles instead of guessing a host boundary', () => {
  assert.throws(
    () => resolveEffectiveExecutionBoundary({ profile: 'safe_reop', env: {} }),
    /invalid execution profile/i,
  );
});
