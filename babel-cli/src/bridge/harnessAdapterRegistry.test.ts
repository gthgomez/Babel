import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXTERNAL_ADAPTER_CAMPAIGN_ORDER } from './harnessAdapterContract.js';
import { buildHarnessAdapterCatalog } from './harnessAdapterRegistry.js';

describe('harnessAdapterRegistry', () => {
  it('lists adapters in campaign order with command-code and opencode before stubs', async () => {
    const catalog = await buildHarnessAdapterCatalog({
      commandCodeProbe: { state: 'verified', version: '9.9.9', executable: '/bin/command-code' },
      openCodeProbe: { state: 'verified', version: '1.2.3', executable: '/bin/opencode' },
    });
    const ids = catalog.map((entry) => entry.descriptor.id);
    assert.deepEqual(ids, ['babel-native', ...EXTERNAL_ADAPTER_CAMPAIGN_ORDER]);
    const commandCode = catalog.find((entry) => entry.descriptor.id === 'command-code');
    assert.equal(commandCode?.installation, 'verified');
    assert.equal(commandCode?.descriptor.version, '9.9.9');
    const opencode = catalog.find((entry) => entry.descriptor.id === 'opencode');
    assert.equal(opencode?.installation, 'verified');
    assert.equal(opencode?.descriptor.version, '1.2.3');
  });

  it('advertises unmanaged live attach as unsupported on the shared-owner payload', async () => {
    const catalog = await buildHarnessAdapterCatalog({
      commandCodeProbe: { state: 'missing' },
    });
    const external = catalog.filter((entry) => entry.descriptor.id !== 'babel-native');
    assert.ok(external.every((entry) => entry.descriptor.capabilities.attachLive === false));
  });

  it('exposes antigravity offline foundation without probe, profile, or execution', async () => {
    const catalog = await buildHarnessAdapterCatalog({
      commandCodeProbe: { state: 'missing' },
      openCodeProbe: { state: 'missing' },
    });
    const agy = catalog.find((entry) => entry.descriptor.id === 'antigravity');
    assert.equal(agy?.installation, 'not_implemented');
    assert.equal(agy?.profile_ids, undefined);
    assert.equal(agy?.descriptor.capabilities.start, false);
    assert.equal(agy?.descriptor.capabilities.approve, false);
    assert.ok(
      Object.values(agy?.descriptor.capabilities ?? {}).every((enabled) => enabled === false),
    );
    assert.match(agy?.descriptor.unsupportedReason ?? '', /offline evidence foundation/i);
  });
});
