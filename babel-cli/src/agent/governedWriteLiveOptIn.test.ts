/**
 * Regression: a mutation that passes every governed gate must not be silently
 * swallowed by the DEFAULT dry-run state (G01 write-drop), and the resulting
 * live decision must be INVOCATION-SCOPED: no process-wide environment side
 * effect, isolation between concurrent dispatches, and explicit operator
 * dry-run choices always win.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeActionWithPolicy, resetCircuitBreaker } from './toolExecutor.js';
import { executeTool, refreshDryRunState } from '../localTools.js';
import type { ToolContext } from '../localTools.js';
import { ChatEngine } from './chatEngine.js';
import { computeTerminalOutcome } from './chatEngineObservability.js';

const REQUESTED = 'updated fixture\n';
const MANAGED_ENV = ['BABEL_LIVE', 'BABEL_DRY_RUN', 'BABEL_SHADOW_ROOT', 'BABEL_CONFIG_DIR', 'BABEL_DRY_RUN_SOURCE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_EXECUTION_PROFILE'];

function ctx(runId: string, projectRoot: string): ToolContext {
  return {
    runId,
    agentId: 'test-agent',
    projectRoot,
    babelRoot: projectRoot,
  } as unknown as ToolContext;
}

function executorThat(behavior: 'write' | 'silent-no-op'): unknown {
  return {
    mapAction: () => [],
    async execute(action: { type: string; path?: string; content?: string }) {
      if (behavior === 'write' && action.type === 'write_file') {
        writeFileSync(action.path!, action.content!, 'utf8');
      }
      return { action, terminal: false, results: [{ exit_code: 0, stdout: 'ok', stderr: '' }] };
    },
  };
}

describe('governed mutations carry an invocation-scoped live decision', { concurrency: false }, () => {
  let snapshot: Record<string, string | undefined>;
  let root: string;
  let configDir: string;

  beforeEach(() => {
    resetCircuitBreaker();
    snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
    for (const key of MANAGED_ENV) delete process.env[key];
    root = mkdtempSync(join(tmpdir(), 'babel-live-optin-'));
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
      { type: 'write_file', path: target, content: REQUESTED },
      'workspace_write',
      ctx('live-optin-1', root),
      { mutationRoot: root, mode: 'chat' },
    );
    assert.equal(result.results[0]?.exit_code, 0);
    assert.equal(
      readFileSync(target, 'utf8'),
      REQUESTED,
      'a governed write must produce real bytes, not a silent dry-run no-op',
    );
  });

  test('an explicit operator dry-run is respected: the write does not land', async () => {
    process.env['BABEL_DRY_RUN'] = 'true';
    refreshDryRunState();
    const target = join(root, 'fixture.txt');
    writeFileSync(target, 'initial fixture\n', 'utf8');
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: target, content: REQUESTED },
      'workspace_write',
      ctx('live-optin-2', root),
      { mutationRoot: root, mode: 'chat' },
    );
    assert.equal(readFileSync(target, 'utf8'), 'initial fixture' + '\n');
    assert.equal(process.env['BABEL_LIVE'], snapshot['BABEL_LIVE'], 'explicit dry-run must not be overridden');
  });

  test('a downstream refusal leaves no process-wide live state behind', async () => {
    const target = join(root, 'refused.txt');
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: target, content: REQUESTED },
      'workspace_write',
      ctx('live-optin-3', root),
      { executor: executorThat('silent-no-op') as never, mutationRoot: root, mode: 'chat' },
    );
    assert.equal(result.results[0]?.exit_code, 1, 'the silent no-op is refused by post-image verification');
    assert.equal(
      process.env['BABEL_LIVE'],
      snapshot['BABEL_LIVE'],
      'a refused dispatch must not leave the process live',
    );
    await executeTool(
      { tool: 'file_write', path: join(root, 'after.txt'), content: 'direct' },
      ctx('live-optin-3b', root) as unknown as Parameters<typeof executeTool>[1],
    );
    assert.equal(existsSync(join(root, 'after.txt')), false, 'default dry-run still applies to later work');
  });

  test('concurrent dispatches with different execution decisions never observe each other', async () => {
    const governedTarget = join(root, 'governed.txt');
    const dryTarget = join(root, 'dry.txt');
    const governed = executeActionWithPolicy(
      { type: 'write_file', path: governedTarget, content: REQUESTED },
      'workspace_write',
      ctx('live-optin-4', root),
      { mutationRoot: root, mode: 'chat' },
    );
    const ungoverned = executeTool(
      { tool: 'file_write', path: dryTarget, content: 'dry' },
      ctx('live-optin-4b', root) as unknown as Parameters<typeof executeTool>[1],
    );
    const [g] = await Promise.all([governed, ungoverned]);
    assert.equal(g.results[0]?.exit_code, 0);
    assert.equal(readFileSync(governedTarget, 'utf8'), REQUESTED, 'governed write lands');
    assert.equal(existsSync(dryTarget), false, 'ungoverned concurrent write stays dry');
    assert.equal(process.env['BABEL_LIVE'], snapshot['BABEL_LIVE'], 'no process-wide residue');
  });

  test('a failing verifier after an authorized write runs and cannot certify completion', async () => {
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    refreshDryRunState();
    const marker = join(root, 'ran.txt');
    writeFileSync(join(root, 'fixture.txt'), 'initial fixture\n', 'utf8');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, scripts: { test: 'node prove-fail.mjs' } }),
      'utf8',
    );
    writeFileSync(
      join(root, 'prove-fail.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(1);\n`,
      'utf8',
    );
    const engine = new ChatEngine({ task: 'update the fixture and verify it', projectRoot: root });
    const context = { ...ctx('live-optin-verifier', root), runDir: root };
    await (engine as unknown as {
      executeOneAction: (...args: unknown[]) => Promise<{ observation: string }>;
    }).executeOneAction(
      { type: 'write_file', path: join(root, 'fixture.txt'), content: REQUESTED },
      context,
      {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.equal(readFileSync(join(root, 'fixture.txt'), 'utf8'), REQUESTED);
    const verified = await (engine as unknown as {
      executeOneAction: (...args: unknown[]) => Promise<{ observation: string }>;
    }).executeOneAction(
      { type: 'run_command', command: 'npm test' },
      context,
      {},
      { index: 1, ownerGeneration: 0 },
    );
    assert.equal(existsSync(marker), true, `verifier process did not run: ${verified.observation}`);
    const receipt = (engine as unknown as { lastVerifierReceipt: { exit_code: number } | null }).lastVerifierReceipt;
    const outcome = computeTerminalOutcome({
      finalStatus: 'completed',
      budgetExceeded: false,
      hasAnyWrites: true,
      lastVerifierReceipt: receipt,
    });
    assert.notEqual(receipt?.exit_code, 0, 'a failing verifier must not be recorded as success');
    assert.notEqual(outcome, 'VERIFIED_COMPLETE');
    assert.equal(process.env['BABEL_LIVE'], snapshot['BABEL_LIVE']);
  });

  test('explicit dry-run stays simulated and cannot certify the workspace', async () => {
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    refreshDryRunState();
    const marker = join(root, 'ran.txt');
    writeFileSync(join(root, 'fixture.txt'), 'initial fixture\n', 'utf8');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, scripts: { test: 'node prove-fail.mjs' } }),
      'utf8',
    );
    writeFileSync(
      join(root, 'prove-fail.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(1);\n`,
      'utf8',
    );
    const engine = new ChatEngine({ task: 'update the fixture and verify it', projectRoot: root });
    const context = { ...ctx('live-optin-dry-verifier', root), runDir: root };
    const call = (engine as unknown as {
      executeOneAction: (...args: unknown[]) => Promise<{ observation: string }>;
    }).executeOneAction.bind(engine);
    await call(
      { type: 'write_file', path: join(root, 'fixture.txt'), content: REQUESTED },
      context,
      {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.equal(readFileSync(join(root, 'fixture.txt'), 'utf8'), REQUESTED);
    process.env['BABEL_DRY_RUN'] = 'true';
    refreshDryRunState();
    const verified = await call(
      { type: 'run_command', command: 'npm test' },
      context,
      {},
      { index: 1, ownerGeneration: 0 },
    );
    assert.equal(existsSync(marker), false, 'explicit dry-run must not start the verifier');
    assert.match(verified.observation, /\[DRY RUN\]/);
    const receipt = (engine as unknown as { lastVerifierReceipt: { exit_code: number } | null }).lastVerifierReceipt;
    const attempts = ((engine as unknown as {
      parity: { sessionEvents: { events: Array<{ kind?: string; authoritative?: boolean }> } };
    }).parity.sessionEvents.events).filter((event) => event.kind === 'verifier_attempt' && event.authoritative === true);
    const outcome = computeTerminalOutcome({
      finalStatus: 'completed',
      budgetExceeded: false,
      hasAnyWrites: true,
      lastVerifierReceipt: receipt,
    });
    assert.equal(attempts.length, 0, 'a simulated verifier must not be recorded as authoritative');
    assert.notEqual(receipt?.exit_code, 0);
    assert.notEqual(outcome, 'VERIFIED_COMPLETE');
    assert.equal(process.env['BABEL_LIVE'], snapshot['BABEL_LIVE']);
  });
});
