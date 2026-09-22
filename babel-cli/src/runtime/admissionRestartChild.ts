/**
 * Test-only child-process fixture for `admissionLifecycle.test.ts`.
 *
 * Reopens a durable admission store in a FRESH process (a real process-level
 * restart), recovers the owner of record, admits a follow-up command under
 * that recovered owner, prints one JSON line, and exits WITHOUT closing the
 * store — a crash-like exit. The parent then proves the owner survived and
 * the unsettled claim stays fail-closed (`claimed`).
 *
 * Never imported by production code; executed only via `node --import tsx`.
 */
import { openAdmissionStore } from './admission.js';
import type { CommandDigestInput } from './admissionContracts.js';

const [root, runDir, threadId, commandId] = process.argv.slice(2);
if (!root || !runDir || !threadId || !commandId) {
  console.log(
    JSON.stringify({
      ok: false,
      error: 'usage: admissionRestartChild <authorizedRoot> <runDir> <threadId> <commandId>',
    }),
  );
  process.exit(2);
}

const opened = openAdmissionStore({ authorizedRoot: root, runDir });
if (!opened.ok) {
  console.log(JSON.stringify({ ok: false, error: `${opened.reasonCode}: ${opened.detail}` }));
  process.exit(1);
}

const owner = opened.store.readOwner(threadId);
const digestInput: CommandDigestInput = {
  threadId,
  taskId: 'task-restart-probe',
  commandId,
  mode: 'chat',
  resolvedOperationPolicy: { mutation: 'normal', approval: 'interactive' },
  taskShapeClass: 'general',
  targetRoot: root,
  offeredToolSchemaVersion: 'tools-v1',
  contextSnapshotId: 'ctx-restart-probe',
  payload: { command: 'restart_probe' },
};

let admitted: string;
if (owner) {
  const decision = opened.store.admitCommand({
    digestInput,
    ownerGeneration: owner.generation,
    ownerToken: owner.token,
    effectClass: 'read_only',
    operationId: `op-${commandId}`,
  });
  admitted = decision.kind;
} else {
  admitted = 'no_owner';
}

console.log(JSON.stringify({ ok: true, owner, admitted }));
// Crash-like exit: the handle is still open; every COMMIT above must survive.
process.exit(0);
