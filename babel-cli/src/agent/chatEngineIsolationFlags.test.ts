import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js';
import { resolveIsolationBrokerFlags } from './chatEngineIsolationFlags.js';

const keys = ['BABEL_EXECUTION_PROFILE', 'BABEL_REQUIRE_CLEAN_TREE', 'BABEL_DIRTY_TREE', 'BABEL_DOCKER_DISABLE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_BENCHMARK_DOCKER_IMAGE', 'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] as const;

function withGitProbe(t: TestContext, overrides: Record<string, string>, run: (probe: { calls: () => number; clean: () => void }) => void): void {
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let calls = 0;
  let dirty = true;
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_DOCKER_DISABLE: 'true' }, overrides);
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[]) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['status', '--porcelain']);
    calls++;
    const stdout = dirty ? ' M tracked.txt\n' : '';
    return { pid: 1, output: ['', stdout, ''], stdout, stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    run({ calls: () => calls, clean: () => { dirty = false; } });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetDockerAvailabilityCache();
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('host profile without clean-tree enforcement does not spawn an unused Git status', t => {
  withGitProbe(t, {}, probe => {
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(resolveIsolationBrokerFlags('/fixture'), { isolationRequired: false, isolationAvailable: false, hostFallbackAllowed: true, dirtyTree: false });
    }
    assert.equal(probe.calls(), 0);
  });
});

test('explicit clean-tree enforcement still observes changed working-tree state on every check', t => {
  withGitProbe(t, { BABEL_REQUIRE_CLEAN_TREE: '1' }, probe => {
    assert.equal(resolveIsolationBrokerFlags('/fixture').dirtyTree, true);
    probe.clean();
    assert.equal(resolveIsolationBrokerFlags('/fixture').dirtyTree, false);
    assert.equal(probe.calls(), 2);
  });
});

test('an isolation-requiring host escalation still checks the working tree', t => {
  withGitProbe(t, { BABEL_EXECUTION_PROFILE: 'safe_repo' }, probe => {
    const flags = resolveIsolationBrokerFlags('/fixture');
    assert.equal(flags.isolationRequired, true);
    assert.equal(flags.hostFallbackAllowed, true);
    assert.equal(flags.dirtyTree, true);
    assert.equal(probe.calls(), 1);
  });
});

test('a Docker isolation profile still checks the working tree', t => {
  withGitProbe(t, { BABEL_EXECUTION_PROFILE: 'safe_repo', BABEL_DOCKER_DISABLE: 'false', BABEL_BENCHMARK_DOCKER_IMAGE: 'fixture/image:test' }, probe => {
    setDockerAvailableForTest(true);
    assert.deepEqual(resolveIsolationBrokerFlags('/fixture'), { isolationRequired: true, isolationAvailable: true, hostFallbackAllowed: false, dirtyTree: true });
    assert.equal(probe.calls(), 1);
  });
});

test('explicit dirty-tree overrides preserve their existing precedence', t => {
  withGitProbe(t, {}, probe => {
    process.env.BABEL_DIRTY_TREE = '1';
    assert.equal(resolveIsolationBrokerFlags('/fixture').dirtyTree, true);
    process.env.BABEL_EXECUTION_PROFILE = 'safe_repo';
    process.env.BABEL_REQUIRE_CLEAN_TREE = '1';
    process.env.BABEL_DIRTY_TREE = '0';
    assert.equal(resolveIsolationBrokerFlags('/fixture').dirtyTree, false);
    assert.equal(probe.calls(), 0);
  });
});
