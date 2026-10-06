/**
 * Regression: a mutation that passes every governed gate must not be silently
 * swallowed by the DEFAULT dry-run state (G01 write-drop — fresh environments
 * default to dry-run, so write_file reported success while no bytes landed).
 * The governed gate promotes the documented live opt-in (BABEL_LIVE) for the
 * process; an operator's explicit dry-run choice is always respected.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeActionWithPolicy, resetCircuitBreaker } from './toolExecutor.js';
import { refreshDryRunState } from '../localTools.js';
import type { ToolContext } from '../localTools.js';

const MANAGED_ENV = ['BABEL_LIVE', 'BABEL_DRY_RUN', 'BABEL_SHADOW_ROOT', 'BABEL_CONFIG_DIR', 'BABEL_DRY_RUN_SOURCE'];

function ctx(runId: string, projectRoot: string): ToolContext {
  return {
    runId,
    agentId: 'test-agent',
    projectRoot,
    cwd: projectRoot,
    babelRoot: projectRoot,
  } as unknown as ToolContext;
}

describe('governed mutations opt out of the default dry-run', { concurrency: false }, () => {
  let snapshot: Record<string, string | undefined>;
  let root: string;
  let configDir: string;

  beforeEach(() => {
    resetCircuitBreaker();
    snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
    for (const key of MANAGED_ENV) delete process.env[key];
    root = mkdtempSync(join(tmpdir(), 'babel-live-optin-'));
    // Empty config dir: no persisted runtime-flags.json → dry-run source is
    // the DEFAULT, which is the state fresh environments run in.
    configDir = mkdtempSync(join(tmpdir(), 'babel-live-optin-cfg-'));
    process.env['BABEL_CONFIG_DIR'] = configDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    refreshDryRunState();
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('an authorized write_file really lands when only the default dry-run is active', async () => {
    const target = join(root, 'fixture.txt');
    writeFileSync(target, 'initial fixture\n', 'utf8');
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: target, content: 'updated fixture\n' },
      'workspace_write',
      ctx('live-optin-1', root),
      { mutationRoot: root, mode: 'chat' },
    );
    assert.equal(result.results[0]?.exit_code, 0);
    assert.equal(
      readFileSync(target, 'utf8'),
      'updated fixture\n',
      'a governed write must produce real bytes, not a silent dry-run no-op',
    );
  });

  test('an explicit operator dry-run is respected: the write does not land', async () => {
    process.env['BABEL_DRY_RUN'] = 'true';
    refreshDryRunState();
    const target = join(root, 'fixture.txt');
    writeFileSync(target, 'initial fixture\n', 'utf8');
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: target, content: 'updated fixture\n' },
      'workspace_write',
      ctx('live-optin-2', root),
      { mutationRoot: root, mode: 'chat' },
    );
    assert.equal(readFileSync(target, 'utf8'), 'initial fixture\n');
    assert.equal(process.env['BABEL_LIVE'], snapshot['BABEL_LIVE'], 'explicit dry-run must not be overridden');
  });
});
