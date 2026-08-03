import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkspaceReadinessReceipt,
  createWorkspaceReadinessSigner,
  decodeWorkspaceReadinessReceipt,
  encodeWorkspaceReadinessReceipt,
  verifyWorkspaceReadinessReceipt,
} from './workspaceReadinessReceipt.js';

function fixtureReceipt() {
  const signer = createWorkspaceReadinessSigner();
  const receipt = createWorkspaceReadinessReceipt(
    {
      workspaceRoot: 'C:/fixtures/agent-workspace',
      verifierRoot: 'C:/fixtures/verifier-overlay',
      gitHead: '0123456789abcdef',
      testPath: 'tests/test_example.py',
      verifierCommand: 'python -m pytest tests/test_example.py -q',
      dependencyReady: true,
      pythonExecutableValid: true,
      collectionReady: true,
      testPatchApplied: true,
      verifierAuthority: 'dataset_bound',
      createdAt: '2026-08-02T00:00:00.000Z',
    },
    signer,
  );
  return { signer, receipt };
}

test('workspace readiness receipt is redacted, signed, and round-trips', () => {
  const { signer, receipt } = fixtureReceipt();
  assert.equal(receipt.workspace_root_sha256.includes('fixtures'), false);
  assert.equal(receipt.verifier_root_sha256?.includes('overlay'), false);

  const encoded = encodeWorkspaceReadinessReceipt(receipt);
  const decoded = decodeWorkspaceReadinessReceipt(encoded);
  assert.deepEqual(decoded, receipt);

  const verified = verifyWorkspaceReadinessReceipt({
    receipt: decoded,
    publicKeyBase64: signer.publicKeyBase64,
    expectedWorkspaceRoot: 'C:/fixtures/agent-workspace',
  });
  assert.equal(verified.ok, true, verified.reason ?? 'receipt should verify');
});

test('workspace readiness receipt rejects tampering and root mismatch', () => {
  const { signer, receipt } = fixtureReceipt();
  const tampered = { ...receipt, dependency_ready: false };
  const tamperResult = verifyWorkspaceReadinessReceipt({
    receipt: tampered,
    publicKeyBase64: signer.publicKeyBase64,
    expectedWorkspaceRoot: 'C:/fixtures/agent-workspace',
  });
  assert.equal(tamperResult.ok, false);
  assert.ok(
    tamperResult.reason === 'receipt_id_mismatch' || tamperResult.reason === 'receipt_signature_invalid',
  );

  const mismatch = verifyWorkspaceReadinessReceipt({
    receipt,
    publicKeyBase64: signer.publicKeyBase64,
    expectedWorkspaceRoot: 'C:/fixtures/other-workspace',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'receipt_workspace_mismatch');
});

test('workspace readiness receipt rejects incomplete preflight facts', () => {
  const signer = createWorkspaceReadinessSigner();
  const receipt = createWorkspaceReadinessReceipt(
    {
      workspaceRoot: 'C:/fixtures/agent-workspace',
      dependencyReady: true,
      pythonExecutableValid: false,
      collectionReady: false,
    },
    signer,
  );
  const result = verifyWorkspaceReadinessReceipt({
    receipt,
    publicKeyBase64: signer.publicKeyBase64,
    expectedWorkspaceRoot: 'C:/fixtures/agent-workspace',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'workspace_python_not_executable');
});
