import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildVerifiedCompletion,
  loadAndValidateExample,
  validateVerifiedCompletion,
  VERIFIED_COMPLETION_ARTIFACT_TYPE,
} from './verifiedCompletion.js';

const REPO_ROOT = join(process.cwd(), '..');

describe('verifiedCompletion (T5.1)', () => {
  it('validates a well-formed artifact', () => {
    const art = buildVerifiedCompletion({
      status: 'completed',
      run_dir: 'runs/x',
      changed_files: ['src/a.ts'],
      verifier_receipt: { command: 'npm test', exit_code: 0, summary: 'ok' },
    });
    const r = validateVerifiedCompletion(art);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(art.artifact_type, VERIFIED_COMPLETION_ARTIFACT_TYPE);
  });

  it('rejects missing changed_files', () => {
    const r = validateVerifiedCompletion({
      schema_version: 1,
      artifact_type: VERIFIED_COMPLETION_ARTIFACT_TYPE,
      status: 'completed',
      run_dir: null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('changed_files')));
  });

  it('rejects bad verifier_receipt', () => {
    const r = validateVerifiedCompletion({
      schema_version: 1,
      artifact_type: VERIFIED_COMPLETION_ARTIFACT_TYPE,
      status: 'completed',
      run_dir: 'runs/x',
      changed_files: [],
      verifier_receipt: { command: '', exit_code: 0, summary: 'x' },
    });
    assert.equal(r.ok, false);
  });

  it('published example validates', () => {
    const r = loadAndValidateExample(REPO_ROOT);
    assert.equal(r.ok, true, r.errors.join('; '));
  });
});
