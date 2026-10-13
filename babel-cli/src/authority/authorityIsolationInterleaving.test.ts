/**
 * Authority isolation under overlapping async contexts (#213, #214, #289, #291).
 *
 * Locks seams that already exist. Does not claim the open issues are closed.
 *
 * Absent, not asserted (a pass here would be fake):
 * - `deriveSubagentApprovalSession` copies `sessionAllows`, `rules`, and
 *   `parentScopeCeiling` into a new session. Nothing revokes that copy when
 *   the parent set is deleted or the parent ceiling shrinks (#289 / #214).
 * - `AutonomyLease` / `AuthoritySessionContext` have no authority revision,
 *   epoch, or reload-before-admission API. `decideActionRequest` does not
 *   read `invalidateLease`. A JSON clone taken before a splice keeps the old
 *   capability list (#289).
 * - `markSessionInvalidated` mutates the session object it is given and does
 *   not by itself update a detached copy or call `invalidateLease`.
 *
 * Present and locked below:
 * - AsyncLocalStorage execution context (approval session, turn, root,
 *   index-write policy) does not cross overlapping `run` scopes.
 * - `invalidateLease(leaseId)` and a shared `authoritySession.invalidated`
 *   flag make `decideWithLease` deny, including for a cloned lease object.
 * - Shrinking `parentScopeCeiling` on the same session object stops
 *   `isPreApproved` even if the allow key is still stored.
 * - `decideActionRequest` reads the lease object at call time. It does not
 *   replay an earlier allow after that object's capability list shrinks.
 * - A read-only child ceiling, `read_only` preset, and the read-only prompt
 *   tool list do not pick up a sibling's write grant or write prompt.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  applyApprovalDecision,
  buildApprovalRequest,
  createApprovalSession,
  deriveSubagentApprovalSession,
  isPreApproved,
  type ApprovalRequest,
  type ApprovalSessionState,
} from '../agent/approvalRequests.js';
import {
  approvalOperationFromAgentAction,
  digestApprovalOperation,
  operationDigestMatches,
} from '../agent/approvalOperation.js';
import { bindChatApprovalSession, getChatApprovalSession, resetChatApprovalSession, setChatApprovalTurnId } from '../agent/chatApproval.js';
import { buildDelegatedChildEnvelope } from '../agent/chatEngineChildExecution.js';
import {
  assertChildApprovalWithinParent,
  childApprovalWithinParent,
  getExecutionContext,
  isIndexWriteDenied,
  runWithExecutionContext,
  type ExecutionContext,
} from '../agent/executionContext.js';
import { buildReadOnlyAgentTurnPrompt } from '../agent/lanes/readOnlyAgentLoop.js';
import { buildMutationAgentTurnPrompt } from '../agent/lanes/runMutationAgentLoop.js';
import { decideAction, READ_ONLY_LITE_TOOLS } from '../agent/policy.js';
import { decideActionRequest } from './pdp.js';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import { markSessionInvalidated, type AuthoritySessionContext } from './sessionContext.js';
import { decideWithLease, invalidateLease, isLeaseInvalidated, resetLeaseInvalidations } from './wire.js';

/** Production read-only child ceiling (`executeSubAgentAction`). */
const READ_ONLY_CHILD_CEILING = ['other'] as const;
/** Production mutation child ceiling (`executeSubAgentAction`). */
const MUTATION_CHILD_CEILING = ['shell', 'write', 'other'] as const;
/** Literal tool list passed by `runReadOnlyAgentLoop`. */
const READ_ONLY_CHILD_TOOLS = ['directory_list', 'file_read', 'semantic_search', 'grep', 'glob'];

const NOW = 1_700_000_000_000;
const PROJECT_ROOT = '/isol/project';
const SIBLING_WRITE_PATH = 'isol-sibling-write.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    threadId: 'thread',
    turnId: 'turn',
    root: PROJECT_ROOT,
    indexWritePolicy: 'allow',
    ...overrides,
  };
}

function lease(leaseId: string, allowed: AutonomyLease['allowedCapabilities']): AutonomyLease {
  const parsed = parseLeaseJson(JSON.stringify({
    version: 2,
    leaseId,
    scope: { repository: 'gthgomez/Babel' },
    allowedCapabilities: allowed,
  }));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.lease;
}

function writeRequest(scope: string): ApprovalRequest {
  return buildApprovalRequest({
    thread_id: 'request',
    turn_id: 'turn',
    command: `write ${scope}`,
    cwd: PROJECT_ROOT,
    capability: 'write',
    proposed_scope: scope,
    reason: 'isolation',
  });
}

const previousReadOnlySeed = process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];

before(() => {
  delete process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
  resetLeaseInvalidations();
  resetChatApprovalSession('startup');
});

after(() => {
  resetLeaseInvalidations();
  resetChatApprovalSession();
  if (previousReadOnlySeed === undefined) delete process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
  else process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'] = previousReadOnlySeed;
});

describe('#214 / #291 — overlapping async contexts do not leak approvals', () => {
  test('interleaved sessions keep their own grants, turns, and digests', async () => {
    resetChatApprovalSession('startup');
    const sessionA = createApprovalSession('owner-A', ['write', 'shell', 'other']);
    const sessionB = createApprovalSession('owner-B', ['write', 'shell', 'other']);
    const grantA = writeRequest('write:src/a.ts:nopayload');
    const grantB = writeRequest('write:src/b.ts:nopayload');
    const action = { type: 'write_file' as const, path: 'src/a.ts', content: 'a' };
    const enteredA = deferred();
    const enteredB = deferred();
    const grantedA = deferred();

    const scopeA = runWithExecutionContext(
      ctx({
        threadId: 'A',
        turnId: 'turn-A',
        root: '/scope/a',
        taskOwnerId: 'task-A',
        approvalSession: sessionA,
        indexWritePolicy: 'deny',
      }),
      async () => {
        enteredA.resolve();
        await enteredB.promise;
        assert.throws(
          () => bindChatApprovalSession(sessionB),
          /must not mutate global approval state/,
        );
        assert.throws(() => setChatApprovalTurnId('turn-B'), /must not mutate global/);
        applyApprovalDecision(getChatApprovalSession(), grantA, 'allow_session');
        grantedA.resolve();
        await enteredB.promise;
        assert.equal(getExecutionContext()?.turnId, 'turn-A');
        assert.equal(getExecutionContext()?.taskOwnerId, 'task-A');
        assert.equal(getChatApprovalSession(), sessionA);
        assert.equal(isIndexWriteDenied(), true);
        assert.equal(isPreApproved(getChatApprovalSession(), grantA), true);
        assert.equal(isPreApproved(getChatApprovalSession(), grantB), false);
        const live = approvalOperationFromAgentAction(action, {
          thread_id: getChatApprovalSession().thread_id,
          turn_id: getExecutionContext()!.turnId!,
          cwd: getExecutionContext()!.root,
        });
        return digestApprovalOperation(live);
      },
    );

    const scopeB = runWithExecutionContext(
      ctx({
        threadId: 'B',
        turnId: 'turn-B',
        root: '/scope/b',
        taskOwnerId: 'task-B',
        approvalSession: sessionB,
        indexWritePolicy: 'allow',
      }),
      async () => {
        await enteredA.promise;
        enteredB.resolve();
        await grantedA.promise;
        applyApprovalDecision(getChatApprovalSession(), grantB, 'allow_session');
        assert.equal(getExecutionContext()?.turnId, 'turn-B');
        assert.equal(getChatApprovalSession(), sessionB);
        assert.equal(isIndexWriteDenied(), false);
        assert.equal(isPreApproved(getChatApprovalSession(), grantB), true);
        assert.equal(
          isPreApproved(getChatApprovalSession(), grantA),
          false,
          'turn B must not borrow turn A session allow',
        );
        const live = approvalOperationFromAgentAction(action, {
          thread_id: getChatApprovalSession().thread_id,
          turn_id: getExecutionContext()!.turnId!,
          cwd: getExecutionContext()!.root,
        });
        return digestApprovalOperation(live);
      },
    );

    const [digestA, digestB] = await Promise.all([scopeA, scopeB]);
    assert.notEqual(digestA, digestB);
    assert.equal(
      operationDigestMatches(
        digestA,
        approvalOperationFromAgentAction(action, { thread_id: 'owner-A', turn_id: 'turn-A', cwd: '/scope/a' }),
      ),
      true,
    );
    assert.equal(
      operationDigestMatches(
        digestA,
        approvalOperationFromAgentAction(action, { thread_id: 'owner-B', turn_id: 'turn-B', cwd: '/scope/b' }),
      ),
      false,
    );
    assert.equal(sessionA.sessionAllows.has('write::write:src/b.ts:nopayload'), false);
    assert.equal(sessionB.sessionAllows.has('write::write:src/a.ts:nopayload'), false);
    assert.equal(isPreApproved(sessionA, grantA), true, 'A keeps GA after B starts');
    assert.equal(getExecutionContext(), undefined);
    assert.equal(getChatApprovalSession().thread_id, 'startup');
  });
});

describe('#289 / #214 — revocation removes access on the seams that exist', () => {
  test('shrinking the same session ceiling drops a stored allow', () => {
    const session: ApprovalSessionState = createApprovalSession('same', ['write', 'other']);
    const req = writeRequest('write:src/a.ts:nopayload');
    applyApprovalDecision(session, req, 'allow_session');
    assert.equal(isPreApproved(session, req), true);
    const index = session.parentScopeCeiling.indexOf('write');
    assert.ok(index >= 0);
    session.parentScopeCeiling.splice(index, 1);
    assert.equal(session.sessionAllows.has('write::write:src/a.ts:nopayload'), true);
    assert.equal(isPreApproved(session, req), false);
  });

  test('invalidateLease denies a cloned lease while a sibling lease id stays unfenced', async () => {
    resetLeaseInvalidations();
    const parentLease = lease('parent-lease', ['inspect_repository', 'run_tests']);
    const childLease = JSON.parse(JSON.stringify(parentLease)) as AutonomyLease;
    const siblingLease = lease('sibling-lease', ['inspect_repository', 'run_tests']);
    assert.notEqual(childLease, parentLease);
    assert.equal(childLease.leaseId, parentLease.leaseId);

    const childEntered = deferred();
    const revoked = deferred();
    const action = { type: 'write_file' as const, path: 'src/a.ts', content: 'x' };

    const childFlight = runWithExecutionContext(ctx({ threadId: 'child-lease', taskOwnerId: 'child' }), async () => {
      childEntered.resolve();
      await revoked.promise;
      return decideWithLease(action, 'workspace_write', { lease: childLease });
    });
    const parentFlight = runWithExecutionContext(ctx({ threadId: 'parent-lease', taskOwnerId: 'parent' }), async () => {
      await childEntered.promise;
      assert.equal(getExecutionContext()?.threadId, 'parent-lease');
      invalidateLease(parentLease.leaseId);
      revoked.resolve();
    });
    const siblingFlight = runWithExecutionContext(ctx({ threadId: 'sibling-lease', taskOwnerId: 'sibling' }), async () => {
      await revoked.promise;
      assert.equal(isLeaseInvalidated(siblingLease.leaseId), false);
      return decideWithLease(action, 'workspace_write', { lease: siblingLease }).reasonCode;
    });

    const [childDecision, , siblingReason] = await Promise.all([childFlight, parentFlight, siblingFlight]);
    assert.equal(childDecision.decision, 'deny');
    assert.equal(childDecision.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
    assert.ok(childLease.allowedCapabilities.includes('run_tests'));
    assert.equal(isLeaseInvalidated(parentLease.leaseId), true);
    assert.equal(siblingReason, 'DENY_AUTHORITY_CONTEXT_INCOMPLETE');
  });

  test('in-flight holder of a shared authority session sees invalidation', async () => {
    resetLeaseInvalidations();
    const shared: AuthoritySessionContext = {
      lease: lease('session-object', ['inspect_repository', 'run_tests']),
      repoRoot: PROJECT_ROOT,
      baseline: null,
      invalidated: false,
    };
    const entered = deferred();
    const revoked = deferred();
    const action = { type: 'write_file' as const, path: 'src/a.ts', content: 'x' };

    const holder = runWithExecutionContext(ctx({ threadId: 'holder' }), async () => {
      entered.resolve();
      await revoked.promise;
      return decideWithLease(action, 'workspace_write', {
        lease: JSON.parse(JSON.stringify(shared.lease)) as AutonomyLease,
        authoritySession: shared,
      });
    });
    const owner = runWithExecutionContext(ctx({ threadId: 'session-owner' }), async () => {
      await entered.promise;
      markSessionInvalidated(shared);
      revoked.resolve();
    });

    const [decision] = await Promise.all([holder, owner]);
    assert.equal(shared.invalidated, true);
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
  });
});

describe('#289 — PDP reads the lease object at decision time', () => {
  test('an in-flight caller does not keep allow after the shared capability list shrinks', async () => {
    const shared = lease('revocable-object', ['inspect_repository', 'run_tests']);
    const strict = lease('already-strict', ['inspect_repository']);
    const started = deferred();
    const revised = deferred();
    const request = { capability: 'run_tests' as const };

    const flight = runWithExecutionContext(ctx({ threadId: 'wide-lease', turnId: 'turn-wide' }), async () => {
      const before = decideActionRequest(request, shared, NOW);
      started.resolve();
      await revised.promise;
      const after = decideActionRequest(request, shared, NOW);
      return {
        threadId: getExecutionContext()?.threadId,
        before: before.outcome,
        beforeReason: before.reasonCode,
        after: after.outcome,
        afterReason: after.reasonCode,
      };
    });
    const reviser = runWithExecutionContext(ctx({ threadId: 'reviser', turnId: 'turn-reviser' }), async () => {
      await started.promise;
      const strictDecision = decideActionRequest(request, strict, NOW);
      const index = shared.allowedCapabilities.indexOf('run_tests');
      assert.ok(index >= 0);
      shared.allowedCapabilities.splice(index, 1);
      revised.resolve();
      return {
        threadId: getExecutionContext()?.threadId,
        strict: strictDecision.outcome,
        strictReason: strictDecision.reasonCode,
      };
    });

    const [wide, other] = await Promise.all([flight, reviser]);
    assert.equal(wide.threadId, 'wide-lease');
    assert.equal(other.threadId, 'reviser');
    assert.equal(wide.before, 'allow');
    assert.equal(wide.beforeReason, 'ALLOW_SAFE_LOCAL');
    assert.equal(wide.after, 'deny');
    assert.equal(wide.afterReason, 'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT');
    assert.equal(other.strict, 'deny');
    assert.equal(getExecutionContext(), undefined);
  });
});

describe('#213 / #214 — a read-only child does not gain a sibling write tool', () => {
  test('overlapping child scopes keep read-only ceiling, prompt tools, and preset', async () => {
    const parent = createApprovalSession('parent-tools', ['shell', 'write', 'other']);
    applyApprovalDecision(parent, writeRequest('write:src/parent.ts:nopayload'), 'allow_session');
    const readChild = deriveSubagentApprovalSession(parent, 'read-child', [...READ_ONLY_CHILD_CEILING]);
    const mutationChild = deriveSubagentApprovalSession(parent, 'mutation-child', [...MUTATION_CHILD_CEILING]);
    assertChildApprovalWithinParent(readChild, parent);
    assert.equal(childApprovalWithinParent(readChild, parent), true);
    assert.deepEqual(readChild.parentScopeCeiling, ['other']);
    assert.equal(readChild.sessionAllows.has('write::write:src/parent.ts:nopayload'), false);
    assert.equal(mutationChild.sessionAllows.has('write::write:src/parent.ts:nopayload'), true);

    const readReady = deferred();
    const mutationReady = deferred();
    const writeAction = { type: 'write_file' as const, path: SIBLING_WRITE_PATH, content: 'nope' };

    const readFlight = runWithExecutionContext(
      ctx({
        threadId: 'read-child',
        turnId: 'turn-read',
        approvalSession: readChild,
        indexWritePolicy: 'deny',
        parentTrace: { threadId: 'parent-tools', turnId: 'turn-parent' },
      }),
      async () => {
        readReady.resolve();
        await mutationReady.promise;
        const envelope = buildDelegatedChildEnvelope({
          task: 'inspect only',
          projectRoot: PROJECT_ROOT,
          parentReadOnly: true,
          requestedMutation: false,
          requestedWriteScope: [SIBLING_WRITE_PATH],
          instructions: null,
          parentModel: 'parent/model',
          maxRounds: null,
        });
        const prompt = buildReadOnlyAgentTurnPrompt({
          verb: 'ask',
          task: 'inspect only',
          projectRoot: PROJECT_ROOT,
          round: 1,
          maxRounds: envelope.spec.effectiveRounds,
          priorObservations: '',
          allowedTools: READ_ONLY_CHILD_TOOLS,
          additionalInstructions: `sibling holds ${SIBLING_WRITE_PATH}`,
        });
        const toolsLine = prompt.split('\n').find((line) => line.startsWith('Allowed tools:'));
        return {
          threadId: getExecutionContext()?.threadId,
          denied: isIndexWriteDenied(),
          preApproved: isPreApproved(getChatApprovalSession(), writeRequest('write:src/parent.ts:nopayload')),
          ceiling: getChatApprovalSession().parentScopeCeiling,
          mutationEnabled: envelope.mutationEnabled,
          writeScope: envelope.writeScope,
          capabilityLine: envelope.envelope.split('\n').find((line) => line.startsWith('Capability:')),
          rounds: envelope.spec.effectiveRounds,
          toolsLine,
          preset: decideAction(writeAction, 'read_only'),
          forbidsWrite: prompt.includes('Do not emit write_file, apply_patch, or run_command.'),
        };
      },
    );

    const mutationFlight = runWithExecutionContext(
      ctx({
        threadId: 'mutation-child',
        turnId: 'turn-mutation',
        approvalSession: mutationChild,
        indexWritePolicy: 'allow',
        parentTrace: { threadId: 'parent-tools', turnId: 'turn-parent' },
      }),
      async () => {
        await readReady.promise;
        const extra = writeRequest(`write:${SIBLING_WRITE_PATH}:nopayload`);
        applyApprovalDecision(getChatApprovalSession(), extra, 'allow_session');
        mutationReady.resolve();
        const envelope = buildDelegatedChildEnvelope({
          task: 'edit the sibling path',
          projectRoot: PROJECT_ROOT,
          parentReadOnly: false,
          requestedMutation: true,
          requestedWriteScope: [SIBLING_WRITE_PATH],
          instructions: null,
          parentModel: 'parent/model',
          maxRounds: null,
        });
        const prompt = buildMutationAgentTurnPrompt({
          task: 'edit the sibling path',
          projectRoot: PROJECT_ROOT,
          round: 1,
          maxRounds: envelope.spec.effectiveRounds,
          priorObservations: '',
          writeScope: envelope.writeScope,
        });
        return {
          threadId: getExecutionContext()?.threadId,
          denied: isIndexWriteDenied(),
          holdsSiblingWrite: getChatApprovalSession().sessionAllows.has(`write::write:${SIBLING_WRITE_PATH}:nopayload`),
          mutationEnabled: envelope.mutationEnabled,
          writeScope: envelope.writeScope,
          rounds: envelope.spec.effectiveRounds,
          promptAllowsWrite: prompt.includes('write_file, apply_patch, run_command'),
          preset: decideAction(writeAction, 'workspace_write'),
        };
      },
    );

    const [readOnly, sibling] = await Promise.all([readFlight, mutationFlight]);
    assert.equal(readOnly.threadId, 'read-child');
    assert.equal(sibling.threadId, 'mutation-child');
    assert.equal(readOnly.denied, true);
    assert.equal(sibling.denied, false);
    assert.equal(readOnly.preApproved, false);
    assert.deepEqual(readOnly.ceiling, ['other']);
    assert.equal(readOnly.mutationEnabled, false);
    assert.deepEqual(readOnly.writeScope, []);
    assert.equal(readOnly.capabilityLine, 'Capability: read-only');
    assert.equal(readOnly.rounds, 4);
    assert.equal(readOnly.toolsLine, `Allowed tools: ${READ_ONLY_CHILD_TOOLS.join(', ')}`);
    assert.equal(readOnly.toolsLine!.includes('file_write'), false);
    assert.equal(readOnly.toolsLine!.includes('write_file'), false);
    assert.equal(readOnly.forbidsWrite, true);
    assert.equal(readOnly.preset, 'deny');
    assert.equal((READ_ONLY_LITE_TOOLS as readonly string[]).includes('file_write'), false);
    assert.equal(sibling.holdsSiblingWrite, true);
    assert.equal(readChild.sessionAllows.has(`write::write:${SIBLING_WRITE_PATH}:nopayload`), false);
    assert.equal(sibling.mutationEnabled, true);
    assert.deepEqual(sibling.writeScope, [SIBLING_WRITE_PATH]);
    assert.equal(sibling.rounds, 8);
    assert.equal(sibling.promptAllowsWrite, true);
    assert.equal(sibling.preset, 'allow');
    assert.equal(getExecutionContext(), undefined);
  });
});
