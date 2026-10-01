import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  approveApproval,
  denyApproval,
  getDependencyInstallApprovalDecision,
  isDependencyInstallApproved,
  isModelEscalationApproved,
  listApprovals,
  requestDependencyInstallApproval,
  requestModelEscalationApproval,
} from './approvalQueue.js';

function withQueue<T>(run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'babel-approvals-'));
  const previous = process.env['BABEL_APPROVAL_QUEUE_PATH'];
  process.env['BABEL_APPROVAL_QUEUE_PATH'] = join(root, 'approval-queue.json');
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_APPROVAL_QUEUE_PATH'];
    } else {
      process.env['BABEL_APPROVAL_QUEUE_PATH'] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('dependency install approvals are exact to command, project root, and profile', () => {
  withQueue(() => {
    const first = requestDependencyInstallApproval({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'workspace_manager',
    });
    const second = requestDependencyInstallApproval({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'workspace_manager',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.record.id, second.record.id);
    assert.equal(
      isDependencyInstallApproved({
        command: 'npm install',
        projectRoot: '/tmp/scratch\\hello-cli',
        executionProfile: 'workspace_manager',
      }),
      false,
    );

    approveApproval(first.record.id, { ttlHours: 1 });

    assert.equal(
      isDependencyInstallApproved({
        command: 'npm install',
        projectRoot: '/tmp/scratch\\hello-cli',
        executionProfile: 'workspace_manager',
      }),
      true,
    );
    assert.equal(
      isDependencyInstallApproved({
        command: 'pip install pytest',
        projectRoot: '/tmp/scratch\\hello-cli',
        executionProfile: 'workspace_manager',
      }),
      false,
    );
  });
});

test('denied approvals remain visible and do not auto-grant on repeated request', () => {
  withQueue(() => {
    const request = requestDependencyInstallApproval({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'workspace_manager',
    });
    denyApproval(request.record.id);

    const repeated = requestDependencyInstallApproval({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'workspace_manager',
    });
    const decision = getDependencyInstallApprovalDecision({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'workspace_manager',
    });

    assert.equal(repeated.created, false);
    assert.equal(repeated.record.status, 'denied');
    assert.equal(decision?.status, 'denied');
  });
});

test('persisted legacy approvals remain exact after canonical profile migration', () => {
  withQueue(() => {
    const request = requestDependencyInstallApproval({
      command: 'npm install', projectRoot: '/tmp/migration-project',
      executionProfile: 'openclaw_manager',
    });
    approveApproval(request.record.id, { ttlHours: 1 });
    const queuePath = process.env['BABEL_APPROVAL_QUEUE_PATH']!;
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    // Construct the pre-migration fingerprint independently of the current writer.
    queue.records[0].scope.execution_profile = 'openclaw_manager';
    queue.records[0].fingerprint = createHash('sha256').update(
      '{"kind":"dependency_install","payload":{"command":"npm install"},"scope":{"execution_profile":"openclaw_manager","project_root":' +
      JSON.stringify(resolve('/tmp/migration-project')) + '}}',
    ).digest('hex').slice(0, 16);
    queue.records[0].id = `dep-${queue.records[0].fingerprint}`;
    writeFileSync(queuePath, JSON.stringify(queue));
    assert.equal(queue.records[0].status, 'approved');
    assert.equal(isDependencyInstallApproved({
      command: 'npm install', projectRoot: '/tmp/migration-project',
      executionProfile: 'workspace_manager',
    }), true);
    assert.equal(isDependencyInstallApproved({
      command: 'npm install other', projectRoot: '/tmp/migration-project',
      executionProfile: 'workspace_manager',
    }), false);
    assert.equal(isDependencyInstallApproved({
      command: 'npm install', projectRoot: '/tmp/other-project',
      executionProfile: 'workspace_manager',
    }), false);
    assert.equal(isDependencyInstallApproved({
      command: 'npm install', projectRoot: '/tmp/migration-project',
      executionProfile: 'safe_repo',
    }), false);
    queue.records[0].status = 'denied';
    writeFileSync(queuePath, JSON.stringify(queue));
    assert.equal(isDependencyInstallApproved({
      command: 'npm install', projectRoot: '/tmp/migration-project',
      executionProfile: 'workspace_manager',
    }), false);
    queue.records[0].status = 'approved';
    queue.records[0].expires_at = '2000-01-01T00:00:00.000Z';
    writeFileSync(queuePath, JSON.stringify(queue));
    assert.equal(isDependencyInstallApproved({
      command: 'npm install', projectRoot: '/tmp/migration-project',
      executionProfile: 'workspace_manager',
    }), false);
    queue.records[0].expires_at = new Date(Date.now() + 60_000).toISOString();
    queue.records[0].fingerprint = 'invalid-fingerprint';
    writeFileSync(queuePath, JSON.stringify(queue));
    assert.equal(isDependencyInstallApproved({
      command: 'npm install', projectRoot: '/tmp/migration-project',
      executionProfile: 'workspace_manager',
    }), false);
  });
});

test('model escalation approvals are exact to task/model/tier/project', () => {
  withQueue(() => {
    const request = requestModelEscalationApproval({
      task: 'fix hard bug',
      model: 'qwen3',
      modelTier: 'escalation',
      projectRoot: '/tmp/example_game_suite\\GameOne',
    });

    assert.equal(
      isModelEscalationApproved({
        task: 'fix hard bug',
        model: 'qwen3',
        modelTier: 'escalation',
        projectRoot: '/tmp/example_game_suite\\GameOne',
      }),
      false,
    );

    approveApproval(request.record.id, { ttlHours: 1 });

    assert.equal(
      isModelEscalationApproved({
        task: 'fix hard bug',
        model: 'qwen3',
        modelTier: 'escalation',
        projectRoot: '/tmp/example_game_suite\\GameOne',
      }),
      true,
    );
    assert.equal(
      isModelEscalationApproved({
        task: 'fix hard bug',
        model: 'qwen3',
        modelTier: 'standard',
        projectRoot: '/tmp/example_game_suite\\GameOne',
      }),
      false,
    );
    assert.equal(listApprovals({ status: 'approved' }).length, 1);
  });
});
