/**
 * Verifier cache identity and reuse currency (chat-reliability-20261004, P2).
 *
 * The R8 dedupe cache was keyed by command string and guarded only by
 * writeCount. Some shell actions mark verifier receipts stale without
 * bumping writeCount, the working directory was not part of the identity at
 * all, and relevant workspace bytes could move without the counter moving —
 * all three authorized a stale rerun-skip.
 *
 * Contract under test:
 *  - identical commands in different directories get different cache slots;
 *  - an unknown environment fingerprint never reuses an existing slot;
 *  - reuse requires the receipt's bound workspace revision to still match
 *    the live bytes (relevant edit with no writeCount movement ⇒ execute);
 *  - a receipt conservatively flagged stale but bound to provably unchanged
 *    bytes keeps its legitimate same-state reuse;
 *  - a receipt with no evaluable bound revision fails closed to execution.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveVerifierCacheIdentity,
  shouldReuseCachedVerifierReceipt,
  upsertVerifierReceipt,
  verifierEnvironmentKey,
} from './chatEngineVerifierAdapter.js';
import {
  classifyVerifierScope,
  verifierExecutionFingerprint,
} from '../services/verifierIdentity.js';
import { bindChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import { ChatEngine } from './chatEngine.js';
import { resetCircuitBreaker } from './toolExecutor.js';
import { refreshDryRunState } from '../localTools.js';

describe('verifier cache identity', () => {
  const projectRoot = '/repo/root';

  test('same command in different directories yields different cache slots', () => {
    const a = resolveVerifierCacheIdentity({ projectRoot, command: 'npm test', cwd: 'packages/a' });
    const b = resolveVerifierCacheIdentity({ projectRoot, command: 'npm test', cwd: 'packages/b' });
    assert.notEqual(a.key, b.key);
    assert.notEqual(a.cwd, b.cwd);
    // Same directory and environment is the same slot.
    const again = resolveVerifierCacheIdentity({ projectRoot, command: 'npm test', cwd: 'packages/a' });
    assert.equal(again.key, a.key);
  });

  test('default identity resolves cwd to the physical project root', () => {
    const identity = resolveVerifierCacheIdentity({ projectRoot, command: 'npm test' });
    assert.equal(identity.cwd, path.resolve(projectRoot));
  });

  test('environment fingerprint changes with relevant variables', () => {
    const base = verifierEnvironmentKey({ PATH: '/usr/bin', NODE_ENV: 'test' });
    assert.equal(verifierEnvironmentKey({ PATH: '/usr/bin', NODE_ENV: 'test' }), base);
    assert.notEqual(verifierEnvironmentKey({ PATH: '/other', NODE_ENV: 'test' }), base);
    assert.notEqual(
      verifierEnvironmentKey({ PATH: '/usr/bin', NODE_ENV: 'test', BABEL_EXECUTION_PROFILE: 'deep' }),
      base,
    );
    // Unrelated variables do not change the fingerprint.
    assert.equal(verifierEnvironmentKey({ PATH: '/usr/bin', NODE_ENV: 'test', UNRELATED: 'x' }), base);
  });
});

describe('cached verifier receipt reuse currency', () => {
  let root = '';
  let rel = 'src/mod.ts';

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'babel-verifier-cache-'));
    await mkdir(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, rel), 'v1');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function greenReceipt(): Promise<
    Awaited<ReturnType<typeof bindChatVerifierReceipt>>
  > {
    return bindChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exit_code: 0,
      summary: 'ok',
      mutationPaths: [rel],
      structured: {
        verifierId: 'npm-test',
        authoritySource: 'built_in_runner',
        executable: 'npm',
        args: ['test'],
      },
    });
  }

  test('provably unchanged bytes allow same-state reuse', async () => {
    const receipt = await greenReceipt();
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt), true);
  });

  test('relevant edit without writeCount movement forces actual execution', async () => {
    const receipt = await greenReceipt();
    writeFileSync(join(root, rel), 'v2');
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt), false);
  });

  test('a conservatively stale flag on unchanged bytes keeps legitimate reuse', async () => {
    // Benign unproven tool actions set the one-way stale flag; when the bound
    // bytes are provably unchanged, reuse is still legitimate.
    const receipt = await greenReceipt();
    receipt.stale = true;
    receipt.staleReason = 'workspace state changed after verifier receipt';
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt), true);
  });

  test('a receipt without an evaluable bound revision fails closed', () => {
    assert.equal(
      shouldReuseCachedVerifierReceipt(root, {
        command: 'npm test',
        exit_code: 0,
        exitCode: 0,
        summary: 'ok',
        stale: false,
        receiptId: 'receipt-x',
      }),
      false,
    );
  });
});

describe('verifier execution identity preserves argument semantics', () => {
  const projectRoot = '/repo/root';

  test('distinct arguments are distinct executions (separate cache slots)', () => {
    const slots = new Set<string>();
    for (const command of [
      'pytest -m slow',
      'pytest -m fast',
      'npm test',
      'npm test -- --coverage',
    ]) {
      slots.add(resolveVerifierCacheIdentity({ projectRoot, command }).key);
    }
    assert.equal(slots.size, 4, 'each distinct execution gets its own slot');
  });

  test('argument order and quoting are preserved, not normalized away', () => {
    const identity = resolveVerifierCacheIdentity({ projectRoot, command: 'node --test' });
    assert.notEqual(
      identity.key,
      resolveVerifierCacheIdentity({ projectRoot, command: 'node --test a b' }).key,
    );
    assert.notEqual(
      resolveVerifierCacheIdentity({ projectRoot, command: 'vitest -t "slow path"' }).key,
      resolveVerifierCacheIdentity({ projectRoot, command: 'vitest -t slow path' }).key,
    );
    // Identical commands still share the slot.
    assert.equal(
      resolveVerifierCacheIdentity({ projectRoot, command: 'pytest -m slow' }).key,
      resolveVerifierCacheIdentity({ projectRoot, command: 'pytest -m slow' }).key,
    );
  });

  test('the execution ledger keeps distinct-argument receipts separately', () => {
    const ledger: Array<{ command: string } & Record<string, unknown>> = [];
    upsertVerifierReceipt(ledger as never, { command: 'pytest -m slow' } as never);
    upsertVerifierReceipt(ledger as never, { command: 'pytest -m fast' } as never);
    upsertVerifierReceipt(ledger as never, { command: 'npm test' } as never);
    upsertVerifierReceipt(ledger as never, { command: 'npm test -- --coverage' } as never);
    assert.equal(ledger.length, 4, 'distinct executions are not collapsed in the ledger');
    // Re-running the SAME execution updates its own entry.
    upsertVerifierReceipt(ledger as never, { command: 'pytest -m slow' } as never);
    assert.equal(ledger.length, 4);
  });

  test('coverage classification stays separate from execution identity', () => {
    // Coverage/requirement matching intentionally collapses these; execution
    // identity must not — and neither view may leak into the other.
    assert.equal(classifyVerifierScope('npm test'), 'full');
    assert.equal(classifyVerifierScope('npm test -- --coverage'), 'full');
    assert.notEqual(
      verifierExecutionFingerprint('npm test'),
      verifierExecutionFingerprint('npm test -- --coverage'),
    );
  });

  test('quoted spacing and empty arguments stay distinct executions', () => {
    const oneSpace = 'npm test -- "a b"';
    const twoSpaces = 'npm test -- "a  b"';
    const emptyArg = 'npm test -- ""';
    const absentArg = 'npm test --';
    assert.equal(classifyVerifierScope(oneSpace), classifyVerifierScope(twoSpaces));
    assert.notEqual(verifierExecutionFingerprint(oneSpace), verifierExecutionFingerprint(twoSpaces));
    assert.notEqual(verifierExecutionFingerprint(emptyArg), verifierExecutionFingerprint(absentArg));
    assert.notEqual(
      resolveVerifierCacheIdentity({ projectRoot, command: oneSpace }).key,
      resolveVerifierCacheIdentity({ projectRoot, command: twoSpaces }).key,
    );
    assert.notEqual(
      resolveVerifierCacheIdentity({ projectRoot, command: emptyArg }).key,
      resolveVerifierCacheIdentity({ projectRoot, command: absentArg }).key,
    );
    assert.equal(
      verifierExecutionFingerprint(oneSpace),
      verifierExecutionFingerprint(oneSpace),
    );
  });
});

describe('verifier cache executions follow argv identity', { concurrency: false }, () => {
  const managed = ['BABEL_LIVE', 'BABEL_DRY_RUN', 'BABEL_SHADOW_ROOT', 'BABEL_CONFIG_DIR', 'BABEL_DRY_RUN_SOURCE', 'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK'];
  let snapshot: Record<string, string | undefined>;
  let root: string;
  let configDir: string;

  beforeEach(() => {
    resetCircuitBreaker();
    snapshot = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
    for (const key of managed) delete process.env[key];
    root = mkdtempSync(join(tmpdir(), 'babel-verifier-argv-'));
    configDir = mkdtempSync(join(tmpdir(), 'babel-verifier-argv-cfg-'));
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    refreshDryRunState();
    const log = join(tmpdir(), `babel-verifier-argv-log-${root.split(/[\\/]/).at(-1)}`);
    writeFileSync(join(root, 'fixture.txt'), 'initial\n', 'utf8');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, scripts: { test: 'node record-argv.mjs' } }),
      'utf8',
    );
    writeFileSync(
      join(root, 'record-argv.mjs'),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      'utf8',
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    refreshDryRunState();
    rmSync(join(tmpdir(), `babel-verifier-argv-log-${root.split(/[\\/]/).at(-1)}`), { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('distinct quoted commands execute separately and an identical command is reused', async () => {
    const log = join(tmpdir(), `babel-verifier-argv-log-${root.split(/[\\/]/).at(-1)}`);
    const lines = (): string[] => existsSync(log)
      ? readFileSync(log, 'utf8').trim().split(/\r?\n/).filter((line) => line.length > 0)
      : [];
    const engine = new ChatEngine({ task: 'verify the fixture', projectRoot: root });
    const context = {
      runId: 'verifier-argv',
      agentId: 'test-agent',
      projectRoot: root,
      babelRoot: root,
      runDir: configDir,
    };
    const call = (engine as unknown as {
      executeOneAction: (...args: unknown[]) => Promise<{ observation: string }>;
    }).executeOneAction.bind(engine);
    await call(
      { type: 'write_file', path: join(root, 'fixture.txt'), content: 'updated\n' },
      context,
      {},
      { index: 0, ownerGeneration: 0 },
    );
    const run = (command: string, index: number) => call(
      { type: 'run_command', command },
      context,
      {},
      { index, ownerGeneration: 0 },
    );
    const oneSpace = 'npm test -- "a b"';
    const twoSpaces = 'npm test -- "a  b"';
    const emptyArg = 'npm test -- ""';
    const absentArg = 'npm test --';
    const first = await run(oneSpace, 1);
    const second = await run(twoSpaces, 2);
    const empty = await run(emptyArg, 3);
    const absent = await run(absentArg, 4);
    assert.equal(lines().length, 4, `expected four executions, got ${lines().join(' | ')} after ${first.observation}`);
    assert.notEqual(lines()[0], lines()[1], 'one-space and two-space patterns must reach the process');
    assert.notEqual(lines()[2], lines()[3], 'empty and absent arguments must reach the process');
    assert.doesNotMatch(second.observation, /Verifier result unchanged/);
    assert.doesNotMatch(empty.observation, /Verifier result unchanged/);
    assert.doesNotMatch(absent.observation, /Verifier result unchanged/);
    const repeated = await run(oneSpace, 5);
    assert.equal(lines().length, 4, 'an identical command reuses the current receipt');
    assert.match(repeated.observation, /Verifier result unchanged/);
  });
});
