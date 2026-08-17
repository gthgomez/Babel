import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PORTABLE_WORKFLOW_VERSION,
  type WorkflowRunV1,
  type PortableExportV1,
  type RevisionRefV1,
  type AuthorityRefV1,
  type EvidenceRefV1,
  type VerifierReceiptV1,
  validateWorkflowRunV1,
} from './workflow.js';

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildCanonicalJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://babel.governance/schemas/portable-workflow-v1.schema.json',
    title: 'PortableExportV1',
    description: 'Canonical portable export envelope for Babel workflow runs (portable-workflow-v1).',
    type: 'object',
    required: ['version', 'run', 'redaction_profile', 'exported_at'],
    additionalProperties: false,
    properties: {
      version: {
        type: 'string',
        const: PORTABLE_WORKFLOW_VERSION,
      },
      run: {
        $ref: '#/$defs/WorkflowRunV1',
      },
      redaction_profile: {
        type: 'string',
        enum: ['public', 'internal', 'diagnostic'],
      },
      exported_at: {
        type: 'string',
        format: 'date-time',
      },
    },
    $defs: {
      PortableId: {
        type: 'string',
        pattern: '^[^\\u0000-\\u001f]{1,256}$',
      },
      PortableHash: {
        type: 'string',
        pattern: '^[0-9a-f]{32,64}$',
      },
      RevisionRefV1: {
        type: 'object',
        required: ['kind', 'composite_tree_hash', 'source'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'workspace-revision' },
          composite_tree_hash: { $ref: '#/$defs/PortableHash' },
          source: { type: 'string', enum: ['git', 'filesystem', 'native-authority'] },
        },
      },
      EvidenceRefV1: {
        type: 'object',
        required: ['id', 'kind', 'sha256'],
        additionalProperties: false,
        properties: {
          id: { $ref: '#/$defs/PortableId' },
          kind: { type: 'string', enum: ['event', 'artifact', 'verifier-receipt', 'checkpoint'] },
          sha256: { $ref: '#/$defs/PortableHash' },
          native_path: { type: 'string', minLength: 1 },
        },
      },
      AuthorityRefV1: {
        type: 'object',
        required: ['native_kind', 'native_id', 'sha256'],
        additionalProperties: false,
        properties: {
          native_kind: {
            type: 'string',
            enum: ['task-contract', 'instruction-manifest', 'live-session', 'episode'],
          },
          native_id: { $ref: '#/$defs/PortableId' },
          sha256: { $ref: '#/$defs/PortableHash' },
        },
      },
      VerifierIdentityV1: {
        type: 'object',
        required: ['command', 'command_sha256', 'scope', 'independent', 'clean_room'],
        additionalProperties: false,
        properties: {
          command: { type: 'string', minLength: 1 },
          command_sha256: { $ref: '#/$defs/PortableHash' },
          scope: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          independent: { type: 'boolean' },
          clean_room: { type: 'boolean' },
        },
      },
      VerifierReceiptV1: {
        type: 'object',
        required: [
          'id',
          'status',
          'verifier',
          'bound_revision',
          'authority',
          'evidence',
          'produced_at',
        ],
        additionalProperties: false,
        properties: {
          id: { $ref: '#/$defs/PortableId' },
          status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
          verifier: { $ref: '#/$defs/VerifierIdentityV1' },
          bound_revision: { $ref: '#/$defs/RevisionRefV1' },
          authority: { $ref: '#/$defs/AuthorityRefV1' },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/EvidenceRefV1' },
          },
          exit_code: { type: 'integer' },
          produced_at: { type: 'string', format: 'date-time' },
        },
      },
      TaskRefV1: {
        type: 'object',
        required: ['task_id', 'goal', 'acceptance_criteria', 'mutation_policy', 'required_verifiers'],
        additionalProperties: false,
        properties: {
          task_id: { $ref: '#/$defs/PortableId' },
          goal: { type: 'string' },
          acceptance_criteria: {
            type: 'array',
            items: { type: 'string' },
          },
          mutation_policy: {
            type: 'string',
            enum: ['read_only', 'workspace_write', 'governed'],
          },
          required_verifiers: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      StageInputV1: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'task'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'orient' },
              task: { $ref: '#/$defs/TaskRefV1' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'task', 'target_refs'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'review' },
              task: { $ref: '#/$defs/TaskRefV1' },
              target_refs: {
                type: 'array',
                items: { $ref: '#/$defs/EvidenceRefV1' },
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'task', 'target_refs'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'attack' },
              task: { $ref: '#/$defs/TaskRefV1' },
              target_refs: {
                type: 'array',
                items: { $ref: '#/$defs/EvidenceRefV1' },
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'task', 'stage_refs'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'integrate' },
              task: { $ref: '#/$defs/TaskRefV1' },
              stage_refs: {
                type: 'array',
                items: { $ref: '#/$defs/PortableId' },
              },
            },
          },
        ],
      },
      StageResultV1: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'findings'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'orient' },
              findings: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'findings', 'required_changes'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'review' },
              findings: {
                type: 'array',
                items: { type: 'string' },
              },
              required_changes: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'findings', 'reproductions'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'attack' },
              findings: {
                type: 'array',
                items: { type: 'string' },
              },
              reproductions: {
                type: 'array',
                items: { $ref: '#/$defs/EvidenceRefV1' },
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'verifier_receipts', 'changed_refs'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'integrate' },
              verifier_receipts: {
                type: 'array',
                items: { $ref: '#/$defs/VerifierReceiptV1' },
              },
              changed_refs: {
                type: 'array',
                items: { $ref: '#/$defs/EvidenceRefV1' },
              },
            },
          },
        ],
      },
      StageRecordV1: {
        type: 'object',
        required: ['stage_id', 'kind', 'status', 'input', 'workers', 'evidence'],
        additionalProperties: false,
        properties: {
          stage_id: { $ref: '#/$defs/PortableId' },
          kind: { type: 'string', enum: ['orient', 'review', 'attack', 'integrate'] },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'passed', 'failed', 'blocked', 'cancelled'],
          },
          input: { $ref: '#/$defs/StageInputV1' },
          result: { $ref: '#/$defs/StageResultV1' },
          workers: {
            type: 'array',
            items: { $ref: '#/$defs/PortableId' },
          },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/EvidenceRefV1' },
          },
        },
      },
      WorkerRunV1: {
        type: 'object',
        required: ['worker_id', 'stage_id', 'role', 'status', 'native_authority', 'evidence'],
        additionalProperties: false,
        properties: {
          worker_id: { $ref: '#/$defs/PortableId' },
          stage_id: { $ref: '#/$defs/PortableId' },
          role: { type: 'string', enum: ['primary', 'reviewer', 'verifier', 'integrator'] },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'passed', 'failed', 'blocked', 'cancelled'],
          },
          provider: { type: 'string', minLength: 1 },
          native_authority: { $ref: '#/$defs/AuthorityRefV1' },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/EvidenceRefV1' },
          },
        },
      },
      TerminalOutcomeV1: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'receipts', 'revision'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'completed_verified' },
              receipts: {
                type: 'array',
                items: { $ref: '#/$defs/PortableId' },
              },
              revision: { $ref: '#/$defs/RevisionRefV1' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'completed_unverified' },
              reason: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'blocked_external' },
              reason: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'blocked_policy' },
              reason: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'dimension'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'budget_exhausted' },
              dimension: {
                type: 'string',
                enum: ['turns', 'tokens', 'repair', 'infra'],
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'cancelled' },
              reason: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'infra_failure' },
              reason: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'agent_failure' },
              reason: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
      WorkflowRunV1: {
        type: 'object',
        required: [
          'version',
          'run_id',
          'task',
          'authority',
          'stages',
          'workers',
          'evidence',
        ],
        additionalProperties: false,
        properties: {
          version: { type: 'string', const: PORTABLE_WORKFLOW_VERSION },
          run_id: { $ref: '#/$defs/PortableId' },
          task: { $ref: '#/$defs/TaskRefV1' },
          authority: { $ref: '#/$defs/AuthorityRefV1' },
          stages: {
            type: 'array',
            items: { $ref: '#/$defs/StageRecordV1' },
          },
          workers: {
            type: 'array',
            items: { $ref: '#/$defs/WorkerRunV1' },
          },
          terminal: { $ref: '#/$defs/TerminalOutcomeV1' },
          revision: { $ref: '#/$defs/RevisionRefV1' },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/EvidenceRefV1' },
          },
        },
      },
    },
  };
}

export function generateGoldenArtifacts(outDir: string = resolve(process.cwd(), '../docs/specs/golden')) {
  mkdirSync(outDir, { recursive: true });

  const revision: RevisionRefV1 = {
    kind: 'workspace-revision',
    composite_tree_hash: hash('composite-tree-hash-v1'),
    source: 'git',
  };

  const evidence: EvidenceRefV1 = {
    id: 'ev-1',
    kind: 'event',
    sha256: hash('evidence-payload-1'),
    native_path: 'logs/events.jsonl',
  };

  const authority: AuthorityRefV1 = {
    native_kind: 'task-contract',
    native_id: 'task-contract-1',
    sha256: hash('authority-contract-payload-1'),
  };

  const receipt: VerifierReceiptV1 = {
    id: 'receipt-1',
    status: 'passed',
    verifier: {
      command: 'npm run test:portable-workflow',
      command_sha256: hash('npm run test:portable-workflow'),
      scope: ['src/portable/workflow.ts'],
      independent: true,
      clean_room: true,
    },
    bound_revision: revision,
    authority,
    evidence: [evidence],
    exit_code: 0,
    produced_at: '2026-08-08T12:00:00.000Z',
  };

  const validRun: WorkflowRunV1 = {
    version: PORTABLE_WORKFLOW_VERSION,
    run_id: 'run-valid-1',
    task: {
      task_id: 'task-1',
      goal: 'Validate portable workflow schemas against golden fixtures',
      acceptance_criteria: ['Golden fixtures must validate with zero errors'],
      mutation_policy: 'read_only',
      required_verifiers: ['verifier-test-1'],
    },
    authority,
    stages: [
      {
        stage_id: 'stage-0',
        kind: 'orient',
        status: 'passed',
        input: {
          kind: 'orient',
          task: {
            task_id: 'task-1',
            goal: 'Validate portable workflow schemas against golden fixtures',
            acceptance_criteria: ['Golden fixtures must validate with zero errors'],
            mutation_policy: 'read_only',
            required_verifiers: ['verifier-test-1'],
          },
        },
        result: {
          kind: 'orient',
          findings: ['Requirements verified against golden schema'],
        },
        workers: ['worker-0'],
        evidence: [evidence],
      },
      {
        stage_id: 'stage-1',
        kind: 'integrate',
        status: 'passed',
        input: {
          kind: 'integrate',
          task: {
            task_id: 'task-1',
            goal: 'Validate portable workflow schemas against golden fixtures',
            acceptance_criteria: ['Golden fixtures must validate with zero errors'],
            mutation_policy: 'read_only',
            required_verifiers: ['verifier-test-1'],
          },
          stage_refs: ['stage-0'],
        },
        result: {
          kind: 'integrate',
          verifier_receipts: [receipt],
          changed_refs: [evidence],
        },
        workers: ['worker-1'],
        evidence: [evidence],
      },
    ],
    workers: [
      {
        worker_id: 'worker-0',
        stage_id: 'stage-0',
        role: 'primary',
        status: 'passed',
        native_authority: authority,
        evidence: [evidence],
      },
      {
        worker_id: 'worker-1',
        stage_id: 'stage-1',
        role: 'verifier',
        status: 'passed',
        native_authority: authority,
        evidence: [evidence],
      },
    ],
    terminal: {
      kind: 'completed_verified',
      receipts: ['receipt-1'],
      revision,
    },
    revision,
    evidence: [evidence],
  };

  const validExport: PortableExportV1 = {
    version: PORTABLE_WORKFLOW_VERSION,
    run: validRun,
    redaction_profile: 'public',
    exported_at: '2026-08-08T12:00:00.000Z',
  };

  const validation = validateWorkflowRunV1(validRun);
  if (!validation.ok) {
    throw new Error(`Self-check failed: ${validation.errors.join(', ')}`);
  }

  const validJsonStr = JSON.stringify(validExport, null, 2) + '\n';
  writeFileSync(resolve(outDir, 'portable-workflow-v1-valid.json'), validJsonStr, 'utf-8');

  const invalidRevisionMismatch = {
    ...validExport,
    run: {
      ...validRun,
      stages: [
        {
          ...validRun.stages[0],
          result: {
            kind: 'integrate',
            verifier_receipts: [
              {
                ...receipt,
                bound_revision: {
                  ...revision,
                  composite_tree_hash: hash('mismatched-revision-hash'),
                },
              },
            ],
            changed_refs: [],
          },
        },
      ],
    },
  };
  const invalidRevisionStr = JSON.stringify(invalidRevisionMismatch, null, 2) + '\n';
  writeFileSync(
    resolve(outDir, 'portable-workflow-v1-invalid-revision-mismatch.json'),
    invalidRevisionStr,
    'utf-8',
  );

  const invalidVersion = {
    ...validExport,
    version: 'portable-workflow-v2',
    run: {
      ...validRun,
      version: 'portable-workflow-v2',
    },
  };
  const invalidVersionStr = JSON.stringify(invalidVersion, null, 2) + '\n';
  writeFileSync(
    resolve(outDir, 'portable-workflow-v1-invalid-version.json'),
    invalidVersionStr,
    'utf-8',
  );

  const invalidStageLinkage = {
    ...validExport,
    run: {
      ...validRun,
      workers: [
        {
          ...validRun.workers[0],
          stage_id: 'non-existent-stage-999',
        },
      ],
    },
  };
  const invalidStageLinkageStr = JSON.stringify(invalidStageLinkage, null, 2) + '\n';
  writeFileSync(
    resolve(outDir, 'portable-workflow-v1-invalid-stage-linkage.json'),
    invalidStageLinkageStr,
    'utf-8',
  );

  const invalidUnknownProperty = {
    ...validExport,
    unauthorized_injected_field: 'malicious-payload',
  };
  const invalidUnknownPropertyStr = JSON.stringify(invalidUnknownProperty, null, 2) + '\n';
  writeFileSync(
    resolve(outDir, 'portable-workflow-v1-invalid-unknown-property.json'),
    invalidUnknownPropertyStr,
    'utf-8',
  );

  const schemaObj = buildCanonicalJsonSchema();
  const schemaStr = JSON.stringify(schemaObj, null, 2) + '\n';
  writeFileSync(resolve(outDir, 'portable-workflow-v1.schema.json'), schemaStr, 'utf-8');

  // Derive source file sha256
  const workflowTsPath = resolve(process.cwd(), 'src/portable/workflow.ts');
  const workflowTsContent = readFileSync(workflowTsPath);
  const workflowSourceSha256 = hash(workflowTsContent);

  const fixtureSetSha256 = hash(
    validJsonStr +
      invalidRevisionStr +
      invalidVersionStr +
      invalidStageLinkageStr +
      invalidUnknownPropertyStr,
  );
  const schemaArtifactSha256 = hash(schemaStr);

  const manifest = {
    schema_version: PORTABLE_WORKFLOW_VERSION,
    schema_source_file: 'src/portable/workflow.ts',
    workflow_source_sha256: workflowSourceSha256,
    schema_artifact_sha256: schemaArtifactSha256,
    fixture_set_sha256: fixtureSetSha256,
    exported_at: '2026-08-08T12:00:00.000Z',
  };

  const manifestStr = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(resolve(outDir, 'portable-workflow-v1.manifest.json'), manifestStr, 'utf-8');

  return {
    manifest,
    files: {
      'portable-workflow-v1-valid.json': validJsonStr,
      'portable-workflow-v1-invalid-revision-mismatch.json': invalidRevisionStr,
      'portable-workflow-v1-invalid-version.json': invalidVersionStr,
      'portable-workflow-v1-invalid-stage-linkage.json': invalidStageLinkageStr,
      'portable-workflow-v1-invalid-unknown-property.json': invalidUnknownPropertyStr,
      'portable-workflow-v1.schema.json': schemaStr,
      'portable-workflow-v1.manifest.json': manifestStr,
    },
  };
}
