import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { SessionDescriptor } from '../executor/contracts.js';
import { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';

const PEER = fileURLToPath(new URL('../../test/fixtures/opencode-acp-peer.mjs', import.meta.url));
const VERSION_FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/opencode-version.mjs', import.meta.url),
);

function verifiedInstallProbe() {
  return Promise.resolve({
    state: 'verified' as const,
    executable: VERSION_FIXTURE,
    version: '1.0.0',
  });
}

function openCodeDescriptor(threadId: string, projectRoot: string, nativeId: string): SessionDescriptor {
  return {
    schemaVersion: 1,
    threadId,
    projectRoot,
    mode: 'chat',
    provider: 'default',
    model: 'default',
    policyProfile: 'safe_repo',
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    harness_adapter_id: 'opencode',
    harness_native_session_id: nativeId,
  };
}

async function collectUnhandledRejections(
  run: () => Promise<void>,
): Promise<{ rejections: unknown[] }> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return { rejections };
}

describe('openCodeAcpRuntime ensureSession init', () => {
  let tmp = '';
  let prevRuns: string | undefined;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-oc-init-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
  });

  after(() => {
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does not leave unhandledRejection when initialization fails', async () => {
    const registry = new OpenCodeAcpRuntimeRegistry({
      testLaunch: { command: process.execPath, args: [PEER] },
      installProbe: async () => ({
        state: 'verified',
        executable: VERSION_FIXTURE,
        version: '1.0.0',
      }),
    });
    const { rejections } = await collectUnhandledRejections(async () => {
      const descriptor = {
        threadId: 'thread-unsupported',
        projectRoot: tmp,
        harness_adapter_id: 'babel-native',
      } as SessionDescriptor;
      await assert.rejects(() => registry.ensureSession(descriptor), /OPENCODE_SESSION_ADAPTER_MISMATCH/);
    });
    assert.equal(rejections.length, 0);
  });

  it('recovers after session/load rejection without unhandledRejection', async () => {
    const nativeId = 'sess_fixture_load_reject';
    const descriptor = openCodeDescriptor('thread-load-reject', tmp, nativeId);
    const failing = new OpenCodeAcpRuntimeRegistry({
      installProbe: verifiedInstallProbe,
      testLaunch: {
        command: process.execPath,
        args: [PEER],
        env: { BABEL_OPENCODE_FIXTURE_LOAD_FAIL: '1' },
      },
    });
    const { rejections: failRejections } = await collectUnhandledRejections(async () => {
      await assert.rejects(
        () => failing.ensureSession(descriptor),
        /OPENCODE_FIXTURE_LOAD_FAILED|OPENCODE_ACP|COMMAND_CODE_ACP/,
      );
    });
    assert.equal(failRejections.length, 0);
    await failing.closeAll();

    const recovering = new OpenCodeAcpRuntimeRegistry({
      installProbe: verifiedInstallProbe,
      testLaunch: { command: process.execPath, args: [PEER] },
    });
    const { rejections: okRejections } = await collectUnhandledRejections(async () => {
      const session = await recovering.ensureSession(descriptor);
      assert.equal(session.initializationComplete, true);
      assert.equal(session.replayCapture, false);
      assert.equal(session.nativeSessionId, nativeId);
    });
    assert.equal(okRejections.length, 0);
    await recovering.closeAll();
  });

  it('rejects unsupported profile without unhandledRejection', async () => {
    const registry = new OpenCodeAcpRuntimeRegistry({
      installProbe: verifiedInstallProbe,
      testLaunch: { command: process.execPath, args: [PEER] },
    });
    const descriptor = openCodeDescriptor('thread-bad-profile', tmp, 'sess_fixture_profile');
    descriptor.harness_model_profile = 'nonexistent-model-profile';
    const { rejections } = await collectUnhandledRejections(async () => {
      await assert.rejects(
        () => registry.ensureSession(descriptor),
        /OPENCODE_PROFILE_SELECTION_UNSUPPORTED/,
      );
    });
    assert.equal(rejections.length, 0);
    const retryDescriptor = openCodeDescriptor('thread-bad-profile-retry', tmp, 'sess_fixture_profile_ok');
    const session = await registry.ensureSession(retryDescriptor);
    assert.equal(session.initializationComplete, true);
    await registry.closeAll();
  });
});
