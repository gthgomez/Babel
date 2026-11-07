import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiteArtifactRun } from './artifacts.js';

test('Plan honors private state and run overrides without creating target files', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'babel-private-plan-'));
  const previousState = process.env['BABEL_STATE_DIR'];
  const previousRuns = process.env['BABEL_RUNS_DIR'];
  try {
    const state = join(fixture, 'state');
    const target = join(fixture, 'target');
    process.env['BABEL_STATE_DIR'] = state;
    delete process.env['BABEL_RUNS_DIR'];
    const defaultRun = createLiteArtifactRun({ command: 'plan', repoPath: target });
    assert.equal(defaultRun.runDir.startsWith(join(state, 'runs', 'babel-lite')), true);
    assert.equal(existsSync(target), false);
    process.env['BABEL_RUNS_DIR'] = join(fixture, 'explicit-runs');
    const explicitRun = createLiteArtifactRun({ command: 'plan', repoPath: target });
    assert.equal(explicitRun.runDir.startsWith(join(fixture, 'explicit-runs', 'babel-lite')), true);
    assert.equal(existsSync(target), false);
    assert.throws(() => createLiteArtifactRun({ command: 'plan', repoPath: target,
      artifactRoot: join(fixture, 'unconfigured-root') }), /ARTIFACT|artifacts/);
    const legacy = createLiteArtifactRun({ command: 'plan', repoPath: target,
      artifactRoot: join(target, 'runs', 'babel-lite') });
    assert.equal(legacy.runDir.startsWith(join(target, 'runs', 'babel-lite')), true);
    assert.deepEqual(readdirSync(target), ['runs']);
  } finally {
    if (previousState === undefined) delete process.env['BABEL_STATE_DIR'];
    else process.env['BABEL_STATE_DIR'] = previousState;
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previousRuns;
    rmSync(fixture, { recursive: true, force: true });
  }
});
