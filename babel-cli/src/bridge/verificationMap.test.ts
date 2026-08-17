import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapVerificationEvidence,
  verificationFromModelProse,
} from './verificationMap.js';

describe('verificationMap', () => {
  it('never maps missing evidence or model prose to PASS', () => {
    const missing = mapVerificationEvidence({ hasMachineEvidence: false });
    assert.equal(missing.status, 'NOT_VERIFIED');
    assert.equal(missing.has_machine_evidence, false);

    const prose = verificationFromModelProse('All tests passed successfully.');
    assert.equal(prose.status, 'NOT_VERIFIED');

    const failed = mapVerificationEvidence({
      hasMachineEvidence: true,
      commandExitCode: 1,
    });
    assert.equal(failed.status, 'FAILED');

    const pass = mapVerificationEvidence({
      hasMachineEvidence: true,
      commandExitCode: 0,
    });
    assert.equal(pass.status, 'PASS');
  });
});
