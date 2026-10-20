import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { createClaudeCodeFakeSdkPort } from './claudeCodeFakeSdkPort.js';
import { createClaudeCodeHarnessEngine } from './claudeCodeHarnessEngine.js';
import { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';
import { buildHarnessAdapterCatalog } from './harnessAdapterRegistry.js';
import { RemoteApprovalBroker, runOnRemoteSurface } from './remoteApproval.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { evaluateClaudeCodeAdmission } from './claudeCodeAdmission.js';

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

  it('runs admitted turn through fake SDK and broker allow_once', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-claude-turn-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-cfg-'));
    const admission = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
        harness_model_profile: 'claude-haiku-5-5',
        harness_credential_ref: 'TEST_CRED',
        harness_config_root: configRoot,
        project_root: projectRoot,
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
    const registry = new ClaudeCodeAgentRuntimeRegistry({
      sdkPort,
      credentialResolver: async () => ({ ANTHROPIC_AUTH_TOKEN: 'test-token' }),
    });
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
  });
});
