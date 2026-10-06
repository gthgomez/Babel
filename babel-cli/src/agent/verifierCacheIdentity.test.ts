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
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveVerifierCacheIdentity,
  shouldReuseCachedVerifierReceipt,
  verifierEnvironmentKey,
} from './chatEngineVerifierAdapter.js';
import { bindChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';

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
