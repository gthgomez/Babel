/**
 * Remote clarification cannot expand a lease; unauthorized actions deny
 * without going through ALLOW_ONCE.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLeaseJson } from './lease.js';
import { applyClarificationResponse, evaluateSessionTaskGate } from './taskClarity.js';
import { requestChatActionApproval } from '../agent/chatApproval.js';
import { runOnRemoteSurface, RemoteApprovalBroker } from '../bridge/remoteApproval.js';

const PUBLICATION = [
  'inspect_repository',
  'search_repository',
  'edit_task_files',
  'run_tests',
  'commit_ship_set',
  'push_feature_branch',
];

test('clarification.respond cannot add a capability or widen environments', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'remote-clarify',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: [...PUBLICATION, 'production_deploy'],
      constraints: { productionDeploy: true, allowedEnvironments: ['staging'] },
    }),
  );
  assert.ok(parsed.ok);
  const widen = applyClarificationResponse({
    lease: parsed.lease,
    intendedCapability: 'production_deploy',
    chosenTarget: 'production',
  });
  assert.equal(widen.outcome, 'deny');
  const addMerge = evaluateSessionTaskGate({
    task: 'merge it',
    lease: parsed.lease,
    candidates: { pullRequests: ['#88', '#90'] },
  });
  assert.equal(addMerge.kind, 'deny');
});

test('remote default path denies without an ALLOW_ONCE card', async () => {
  const broker = new RemoteApprovalBroker();
  let notified = 0;
  const denied = await runOnRemoteSurface(
    {
      broker,
      threadId: 't',
      turnId: '1',
      failClosedMcp: true,
      cwd: '/tmp',
      notify: () => {
        notified += 1;
      },
    },
    () => requestChatActionApproval({ type: 'write_file', path: 'a.ts', content: 'x' }),
  );
  assert.equal(denied, false);
  assert.equal(notified, 0);
});
