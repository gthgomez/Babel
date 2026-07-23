import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
      executionProfile: 'opencalw_manager',
    });
    const second = requestDependencyInstallApproval({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'opencalw_manager',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.record.id, second.record.id);
    assert.equal(
      isDependencyInstallApproved({
        command: 'npm install',
        projectRoot: '/tmp/scratch\\hello-cli',
        executionProfile: 'opencalw_manager',
      }),
      false,
    );

    approveApproval(first.record.id, { ttlHours: 1 });

    assert.equal(
      isDependencyInstallApproved({
        command: 'npm install',
        projectRoot: '/tmp/scratch\\hello-cli',
        executionProfile: 'opencalw_manager',
      }),
      true,
    );
    assert.equal(
      isDependencyInstallApproved({
        command: 'pip install pytest',
        projectRoot: '/tmp/scratch\\hello-cli',
        executionProfile: 'opencalw_manager',
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
      executionProfile: 'opencalw_manager',
    });
    denyApproval(request.record.id);

    const repeated = requestDependencyInstallApproval({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'opencalw_manager',
    });
    const decision = getDependencyInstallApprovalDecision({
      command: 'npm install',
      projectRoot: '/tmp/scratch\\hello-cli',
      executionProfile: 'opencalw_manager',
    });

    assert.equal(repeated.created, false);
    assert.equal(repeated.record.status, 'denied');
    assert.equal(decision?.status, 'denied');
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
