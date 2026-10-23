import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { createClaudeCodeFakeSdkPort } from './claudeCodeFakeSdkPort.js';
import { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import {
  createClaudeCodeHostLaunchRegistryFromBindings,
  type ClaudeCodeHostProfileBindingV1,
} from './claudeCodeHostLaunchRegistry.js';
import { createHarnessAwareEngineFactory } from './harnessEngineFactory.js';
import { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';
import {
  createProtocolHostState,
  handleProtocolRequest,
} from '../protocol/client/host.js';
import type { ClaudeCodeTurnRequest } from './claudeCodeSdkPort.js';

const verifiedIntegrity = {
  state: 'verified' as const,
  sdkVersion: '0.3.304',
  cliVersion: '2.1.304',
  executablePath: '/opt/claude-agent-sdk-linux-x64/claude',
};

function hostFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-claude-host-prod-'));
  const configHome = mkdtempSync(join(tmpdir(), 'babel-claude-host-cfg-'));
  writeFileSync(
    join(configHome, CLAUDE_HARNESS_MANIFEST_FILENAME),
    JSON.stringify({
      version: 1,
      credential_refs: {
        GOAT_CRED: { host_env: 'BABEL_HOST_GOAT_KEY' },
      },
    }),
    'utf8',
  );
  process.env['BABEL_HOST_GOAT_KEY'] = 'host-secret-token';
  const binding: ClaudeCodeHostProfileBindingV1 = {
    profile_id: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
    model: 'mimo-v2.5',
    credential_ref: 'GOAT_CRED',
    auth_host_env: 'BABEL_HOST_GOAT_KEY',
    auth_child_env: 'ANTHROPIC_API_KEY',
    config_home: configHome,
  };
  const hostRegistry = createClaudeCodeHostLaunchRegistryFromBindings([binding]);
  const captured: ClaudeCodeTurnRequest[] = [];
  const sdkPort = createClaudeCodeFakeSdkPort((req) => {
    captured.push(req);
    return [
      { type: 'assistant', text: 'ok' },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        total_cost_usd: 0.02,
        session_id: 'native-1',
      },
    ];
  });
  const claudeRegistry = new ClaudeCodeAgentRuntimeRegistry({ sdkPort });
  const ccRegistry = new CommandCodeAcpRuntimeRegistry({ hostScopeId: 'test-cc' });
  const ocRegistry = new OpenCodeAcpRuntimeRegistry({ hostScopeId: 'test-oc' });
  const host = createProtocolHostState({
    executeWithoutNotifications: true,
    remoteSurface: true,
    claudeCodeRegistry: claudeRegistry,
    claudeCodeHostLaunchRegistry: hostRegistry,
    claudeCodeAdmissionDeps: {
      integrityProbe: async () => verifiedIntegrity,
      resolveSettings: async (input) => ({
        ok: true,
        digest: `policy-${input.configHome.length}`,
      }),
    },
    engineFactory: createHarnessAwareEngineFactory(ccRegistry, ocRegistry, claudeRegistry),
  });
  return { host, projectRoot, configHome, captured, binding };
}

describe('claudeCode host production path', () => {
  it('thread.create uses trusted host registry (not RPC config roots)', async () => {
    const { host, projectRoot, configHome, binding } = hostFixture();
    const created = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: {
          project_root: projectRoot,
          harness_adapter_id: 'claude-code',
          harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
          harness_config_root: '/tmp/evil-config',
          harness_credential_ref: 'EVIL',
          harness_model_profile: 'evil-model',
        },
      },
      host,
    );
    assert.ok('result' in created, JSON.stringify(created));
    const threadId = (created as { result: { thread_id: string } }).result.thread_id;
    const descriptor = host.descriptors.get(threadId);
    assert.ok(descriptor);
    assert.equal(descriptor.harness_model_profile, binding.model);
    assert.equal(descriptor.harness_config_root, configHome);
    assert.equal(descriptor.harness_credential_ref, binding.credential_ref);
  });

  it('rejects unknown live profile at thread.create', async () => {
    const { host, projectRoot } = hostFixture();
    const created = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'thread.create',
        params: {
          project_root: projectRoot,
          harness_adapter_id: 'claude-code',
          harness_provider_profile: 'unknown-live-profile',
        },
      },
      host,
    );
    assert.ok('error' in created);
  });

  it('turn.submit reaches fake SDK with trusted child env and session key', async () => {
    const { host, projectRoot, captured } = hostFixture();
    const created = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'thread.create',
        params: {
          project_root: projectRoot,
          harness_adapter_id: 'claude-code',
          harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        },
      },
      host,
    );
    const threadId = (created as { result: { thread_id: string } }).result.thread_id;
    const submitted = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'turn.submit',
        params: { thread_id: threadId, message: 'hello' },
      },
      host,
    );
    assert.ok('result' in submitted, JSON.stringify(submitted));
    for (let i = 0; i < 80; i++) {
      if (!host.activeTurns.has(threadId) && captured.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.childEnv.CLAUDE_CONFIG_DIR, captured[0]?.admitted.harness_config_root);
    assert.equal(captured[0]?.childEnv.ANTHROPIC_API_KEY, 'host-secret-token');
    assert.match(captured[0]?.sessionKey ?? '', new RegExp(`^${threadId}:`));
  });
});
