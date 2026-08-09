import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import {
  AuthorityRefV1Schema,
  PortableExportV1Schema,
  RevisionRefV1Schema,
  WorkflowRunV1Schema,
  assertGoalAmendment,
  assertRepairTransition,
  assertStageTransition,
  parsePortableExportV1,
  redactPortableExport,
  recoverPortableRun,
  serializePortableExport,
  toPortableAuthorityRefV1,
  toPortableRevisionRefV1,
  validateWorkflowRunV1,
  type AuthorityRefV1,
  type EvidenceRefV1,
  type PortableExportV1,
  type RevisionRefV1,
  type VerifierReceiptV1,
  type WorkflowRunV1,
} from './workflow.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const revision: RevisionRefV1 = {
  kind: 'workspace-revision',
  composite_tree_hash: hash('revision'),
  source: 'git',
};

const authority: AuthorityRefV1 = {
  native_kind: 'task-contract',
  native_id: 'tc1:test',
  sha256: hash('authority'),
};

const machineRunPath = ['C:', 'Users', 'operator', 'run'].join('\\');

const evidence: EvidenceRefV1 = {
  id: 'evidence-1',
  kind: 'verifier-receipt',
  sha256: hash('evidence'),
  native_path: `${machineRunPath}\\receipt.json`,
};

const receipt: VerifierReceiptV1 = {
  id: 'receipt-1',
  status: 'passed',
  verifier: {
    command: 'npm test',
    command_sha256: hash('npm test'),
    scope: ['portable-workflow'],
    independent: true,
    clean_room: true,
  },
  bound_revision: revision,
  authority,
  evidence: [evidence],
  exit_code: 0,
  produced_at: '2026-08-08T12:00:00.000Z',
};

function validRun(overrides: Partial<WorkflowRunV1> = {}): WorkflowRunV1 {
  return {
    version: 'portable-workflow-v1',
    run_id: 'run-1',
    task: {
      task_id: 'task-1',
      goal: 'prove the portable contract',
      acceptance_criteria: ['schema passes'],
      mutation_policy: 'read_only',
      required_verifiers: ['npm test'],
    },
    authority,
    stages: [
      {
        stage_id: 'stage-1',
        kind: 'integrate',
        status: 'passed',
        input: { kind: 'integrate', task: {
          task_id: 'task-1',
          goal: 'prove the portable contract',
          acceptance_criteria: ['schema passes'],
          mutation_policy: 'read_only',
          required_verifiers: ['npm test'],
        }, stage_refs: [] },
        result: { kind: 'integrate', verifier_receipts: [receipt], changed_refs: [] },
        workers: ['worker-1'],
        evidence: [evidence],
      },
    ],
    workers: [{
      worker_id: 'worker-1',
      stage_id: 'stage-1',
      role: 'verifier',
      status: 'passed',
      native_authority: authority,
      evidence: [evidence],
    }],
    terminal: { kind: 'completed_verified', receipts: ['receipt-1'], revision },
    revision,
    evidence: [evidence],
    ...overrides,
  };
}

function baseStage(): WorkflowRunV1['stages'][number] {
  return validRun().stages[0]!;
}

function validExport(overrides: Partial<PortableExportV1> = {}): PortableExportV1 {
  return {
    version: 'portable-workflow-v1',
    run: validRun(),
    redaction_profile: 'public',
    exported_at: '2026-08-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('portable workflow schemas', () => {
  it('round-trips the complete v1 graph', () => {
    const parsed = parsePortableExportV1(validExport());
    assert.deepEqual(parsed, validExport());
    assert.deepEqual(WorkflowRunV1Schema.parse(parsed.run), parsed.run);
  });

  it('rejects unknown fields and unsupported versions', () => {
    assert.throws(() => PortableExportV1Schema.parse({ ...validExport(), extra: true }));
    assert.throws(() => PortableExportV1Schema.parse({ ...validExport(), version: 'portable-workflow-v2' }));
    assert.throws(() => AuthorityRefV1Schema.parse({ ...authority, sha256: 'not-a-hash' }));
  });

  it('rejects verified completion without an authoritative passed receipt', () => {
    const invalid = validRun({
      terminal: { kind: 'completed_verified', receipts: ['missing'], revision },
    });
    const result = validateWorkflowRunV1(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /missing receipt/);
  });
});

describe('portable authority and verification', () => {
  it('hashes native authority independently of object key order', () => {
    const first = toPortableAuthorityRefV1('episode', 'episode-1', { a: 1, b: 2 });
    const second = toPortableAuthorityRefV1('episode', 'episode-1', { b: 2, a: 1 });
    assert.deepEqual(first, second);
  });

  it('preserves the native revision identity', () => {
    const projected = toPortableRevisionRefV1({ compositeTreeHash: revision.composite_tree_hash, gitCommitHash: 'abc' });
    assert.deepEqual(projected, revision);
    assert.deepEqual(RevisionRefV1Schema.parse(projected), projected);
  });

  it('rejects a verifier receipt bound to a different revision', () => {
    const invalid = validRun({
      stages: [{
        ...baseStage(),
        result: { kind: 'integrate', verifier_receipts: [{ ...receipt, bound_revision: { ...revision, composite_tree_hash: hash('other') } }], changed_refs: [] },
      }],
    });
    const result = validateWorkflowRunV1(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /revision mismatch/);
  });
});

describe('portable recovery and repair', () => {
  it('replays only a committed native checkpoint', () => {
    const result = recoverPortableRun({
      journal: { schema_version: 1, batch_id: 'batch-1', status: 'committed', backups_ready: true, targets: ['task.json'] },
      committedRun: validRun(),
    });
    assert.equal(result.status, 'replayed');
  });

  it('blocks an ambiguous prepared checkpoint instead of guessing', () => {
    const result = recoverPortableRun({
      journal: { schema_version: 1, batch_id: 'batch-1', status: 'prepared', backups_ready: true, targets: ['task.json'] },
      committedRun: validRun(),
    });
    assert.deepEqual(result, {
      status: 'blocked',
      terminal: { kind: 'blocked_external', reason: 'native checkpoint was prepared but its commit state is ambiguous' },
    });
  });

  it('enforces repair and amendment receipt invalidation', () => {
    assert.throws(() => assertRepairTransition({
      from: 'failed', to: 'pending', class: 'implementation', reason: 'changed files', invalidates_receipts: false, evidence: [],
    }, true));
    assert.throws(() => assertGoalAmendment({
      amendment_id: 'amend-1', previous_task_id: 'task-1', approved_by: 'user', invalidates_receipts: false,
      new_task: { task_id: 'task-2', goal: 'new', acceptance_criteria: [], mutation_policy: 'read_only', required_verifiers: [] },
    }));
    assert.doesNotThrow(() => assertStageTransition('failed', 'pending'));
    assert.throws(() => assertStageTransition('passed', 'pending'));
  });
});

describe('portable public redaction', () => {
  it('removes machine paths and secret-bearing strings from public exports', () => {
    const exported = validExport({
      run: validRun({
        stages: [{
          ...baseStage(),
          result: { kind: 'integrate', verifier_receipts: [{ ...receipt, verifier: { ...receipt.verifier, command: `pwsh ${machineRunPath}.ps1 --token=secret-value` } }], changed_refs: [] },
        }],
      }),
    });
    const redacted = redactPortableExport(exported);
    const serialized = serializePortableExport(redacted);
    assert.doesNotMatch(serialized, /Users\\operator/);
    assert.doesNotMatch(serialized, /secret-value/);
    assert.doesNotMatch(serialized, /native_path/);
    assert.match(serialized, /\[REDACTED\]/);
  });
});
