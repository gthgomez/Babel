import assert from 'node:assert/strict';
import test from 'node:test';

import { maybeApplyModelAdapterFallback } from './manifestPatching.js';
import type { OrchestratorManifest } from '../schemas/agentContracts.js';

function manifestWithAdapter(adapter: string): OrchestratorManifest {
  return {
    instruction_stack: { model_adapter_id: adapter },
    worker_configuration: { assigned_model: 'deepseek' },
  } as unknown as OrchestratorManifest;
}

test('preserves the cataloged DeepSeek adapter during manifest fallback', () => {
  const known = maybeApplyModelAdapterFallback(manifestWithAdapter('adapter_deepseek_balanced'));
  assert.equal(known.applied, false);
  assert.equal(known.manifest.instruction_stack?.model_adapter_id, 'adapter_deepseek_balanced');

  const unknown = maybeApplyModelAdapterFallback(manifestWithAdapter('adapter_unknown'));
  assert.equal(unknown.applied, true);
  assert.equal(unknown.manifest.instruction_stack?.model_adapter_id, 'adapter_deepseek_balanced');
});
