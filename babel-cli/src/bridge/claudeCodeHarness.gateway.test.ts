import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { createClaudeCodeFakeSdkPort } from './claudeCodeFakeSdkPort.js';
import { createClaudeCodeHarnessEngine } from './claudeCodeHarnessEngine.js';
import { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';
import { buildHarnessAdapterCatalog } from './harnessAdapterRegistry.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import { RemoteApprovalBroker, runOnRemoteSurface } from './remoteApproval.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { evaluateClaudeCodeAdmission } from './claudeCodeAdmission.js';
import { resolveClaudeCodePolicyEvidence } from './claudeCodePolicyEvidence.js';

const TRUSTED_AUTH = {
  trusted_auth_host_env: 'BABEL_TEST_ANTHROPIC_KEY',
  trusted_auth_child_env: 'ANTHROPIC_API_KEY',
} as const;

const verifiedIntegrity = {
  state: 'verified' as const,
  sdkVersion: '0.3.304',
  cliVersion: '2.1.304',
  executablePath: '/opt/claude-agent-sdk-linux-x64/claude',
};

describe('claudeCode harness gateway', () => {
  it('moves profile_ids to claude-code catalog entry', async () => {
    const catalog = await buildHarnessAdapterCatalog({
      commandCodeProbe: { state: 'missing' },
      openCodeProbe: { state: 'missing' },
      claudeCodeProbe: verifiedIntegrity,
    });
    const cc = catalog.find((e) => e.descriptor.id === 'command-code');
    const claude = catalog.find((e) => e.descriptor.id === 'claude-code');
    assert.equal(cc?.profile_ids, undefined);
    assert.deepEqual(claude?.profile_ids, [
      EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
    ]);
  });

  it('rejects policy evidence when effective settings cannot be proved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-policy-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-policy-cfg-'));
    const evidence = await resolveClaudeCodePolicyEvidence({
      cwd: root,
      config_root: configRoot,
      project_policy_root: root,
      provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      resolveSettings: async () => ({ ok: false, digest: 'x', detail: 'stub' }),
    });
    assert.equal(evidence.ok, false);
  });

  it('runs admitted turn through fake SDK and production credential resolver', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-claude-turn-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-cfg-'));
    writeFileSync(
      join(configRoot, CLAUDE_HARNESS_MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        credential_refs: {
          TEST_CRED: { host_env: 'BABEL_TEST_ANTHROPIC_KEY' },
        },
      }),
      'utf8',
    );
    const prev = process.env['BABEL_TEST_ANTHROPIC_KEY'];
    process.env['BABEL_TEST_ANTHROPIC_KEY'] = 'test-token';
    const admission = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
        harness_model_profile: 'claude-haiku-5-5',
        harness_credential_ref: 'TEST_CRED',
        harness_config_root: configRoot,
        project_root: projectRoot,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-1' }),
      },
    );
    assert.equal(admission.status, 'qualified');
    if (admission.status !== 'qualified') return;

    const sdkPort = createClaudeCodeFakeSdkPort(() => [
      { type: 'assistant', text: 'hello' },
      {
        type: 'result',
        subtype: 'success',
        result: 'hello',
        total_cost_usd: 0.01,
        session_id: 'sess-golden-1',
      },
    ]);
    const registry = new ClaudeCodeAgentRuntimeRegistry({ sdkPort });
    const threadId = 'thread-claude-1';
    registry.bindAdmitted(threadId, admission.admitted);

    const descriptor: SessionDescriptor = {
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
      harness_adapter_id: 'claude-code',
      harness_provider_profile: admission.admitted.harness_provider_profile,
      harness_model_profile: admission.admitted.harness_model_profile,
      harness_config_root: admission.admitted.harness_config_root,
      harness_credential_ref: admission.admitted.harness_credential_ref,
      harness_admission_digest: admission.admitted.admission_digest,
    };

    const engine = createClaudeCodeHarnessEngine({ descriptor, registry });
    const broker = new RemoteApprovalBroker();
    const events = await runOnRemoteSurface(
      {
        broker,
        threadId,
        turnId: 'turn-1',
        cwd: projectRoot,
        failClosedMcp: true,
      },
      async () => {
        const collected: string[] = [];
        for await (const event of engine.submitMessageStream('ping')) {
          collected.push(event.type);
        }
        return collected;
      },
    );
    assert.ok(events.includes('thinking'));
    assert.ok(events.includes('done'));
    if (prev === undefined) delete process.env['BABEL_TEST_ANTHROPIC_KEY'];
    else process.env['BABEL_TEST_ANTHROPIC_KEY'] = prev;
  });

  it('observes interrupt and teardown through fake SDK lifecycle', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-claude-interrupt-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-interrupt-cfg-'));
    writeFileSync(
      join(configRoot, CLAUDE_HARNESS_MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        credential_refs: { TEST_CRED: { host_env: 'BABEL_TEST_ANTHROPIC_KEY' } },
      }),
      'utf8',
    );
    process.env['BABEL_TEST_ANTHROPIC_KEY'] = 'test-token';
    const admission = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
        harness_model_profile: 'claude-haiku-5-5',
        harness_credential_ref: 'TEST_CRED',
        harness_config_root: configRoot,
        project_root: projectRoot,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-1' }),
      },
    );
    assert.equal(admission.status, 'qualified');
    if (admission.status !== 'qualified') return;

    let interruptCalls = 0;
    let closeCalls = 0;
    const sdkPort = createClaudeCodeFakeSdkPort(() => [{ type: 'assistant', text: 'slow' }], {
      stallUntilInterrupted: true,
    });
    const originalInterrupt = sdkPort.interrupt.bind(sdkPort);
    const originalClose = sdkPort.close.bind(sdkPort);
    sdkPort.interrupt = async (key) => {
      interruptCalls += 1;
      await originalInterrupt(key);
    };
    sdkPort.close = async (key) => {
      closeCalls += 1;
      await originalClose(key);
    };
    const registry = new ClaudeCodeAgentRuntimeRegistry({ sdkPort });
    const threadId = 'thread-claude-interrupt';
    registry.bindAdmitted(threadId, admission.admitted);
    const descriptor: SessionDescriptor = {
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
      harness_adapter_id: 'claude-code',
      harness_provider_profile: admission.admitted.harness_provider_profile,
      harness_model_profile: admission.admitted.harness_model_profile,
      harness_config_root: admission.admitted.harness_config_root,
      harness_credential_ref: admission.admitted.harness_credential_ref,
      harness_admission_digest: admission.admitted.admission_digest,
    };
    const broker = new RemoteApprovalBroker();
    await runOnRemoteSurface(
      { broker, threadId, turnId: 'turn-int', cwd: projectRoot, failClosedMcp: true },
      async () => {
        const run = registry.runTurn({
          descriptor,
          message: 'work',
          binding: { threadId, turnId: 'turn-int', cwd: projectRoot, broker },
        });
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            assert.equal(registry.requestInterrupt(descriptor, 'turn-int'), true);
            resolve();
          });
        });
        await run;
      },
    );
    assert.ok(interruptCalls >= 1);
    await registry.forceStopForThread(descriptor, 'turn-int');
    assert.ok(closeCalls >= 1);
  });
});
