/**
 * S04/#214 — execution-scoped context native acceptance (T1–T6).
 *
 * Uses real modules (executionContext, chatApproval, approvalRequests,
 * approvalOperation, chronicleMemory) with explicit deferred barriers. No live
 * provider/network. T6 drives the real ChatEngine.executeActions serialization
 * guard.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  assertChildApprovalWithinParent,
  childApprovalWithinParent,
  getEffectiveApprovalSession,
  getExecutionContext,
  isIndexWriteDenied,
  runWithExecutionContext,
  type ExecutionContext,
} from './executionContext.js';
import {
  getChatApprovalSession,
  requestChatActionApproval,
  resetChatApprovalSession,
} from './chatApproval.js';
import {
  applyApprovalDecision,
  buildApprovalRequest,
  createApprovalSession,
  deriveSubagentApprovalSession,
  isPreApproved,
  type ApprovalSessionState,
} from './approvalRequests.js';
import {
  approvalOperationFromAgentAction,
  digestApprovalOperation,
  operationDigestMatches,
} from './approvalOperation.js';
import { handleSemanticSearch } from '../tools/chronicleMemory.js';

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    threadId: 'thread-A',
    turnId: 'turn-A',
    root: '/scope/a',
    approvalSession: createApprovalSession('thread-A'),
    indexWritePolicy: 'allow',
    ...overrides,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const previousRoot = process.env['BABEL_PROJECT_ROOT'];
const previousSeed = process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
const previousOffline = process.env['BABEL_LITE_OFFLINE'];

before(() => {
  delete process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
});
after(() => {
  if (previousRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
  else process.env['BABEL_PROJECT_ROOT'] = previousRoot;
  if (previousSeed === undefined) delete process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
  else process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'] = previousSeed;
  if (previousOffline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
  else process.env['BABEL_LITE_OFFLINE'] = previousOffline;
  resetChatApprovalSession();
});

describe('S04/#214 T1 — interleaved executions have no cross-scope reads', () => {
  test('two contexts interleave at barriers and each reads only its own state', async () => {
    resetChatApprovalSession('startup');
    const gateA = deferred();
    const gateB = deferred();
    const observed: Record<string, string | boolean> = {};

    const scopeA = runWithExecutionContext(
      ctx({
        threadId: 'A',
        turnId: 'turn-A',
        root: '/a',
        approvalSession: createApprovalSession('A'),
        indexWritePolicy: 'deny',
      }),
      async () => {
        await gateB.promise; // A runs while B is already live
        observed['A'] = getChatApprovalSession().thread_id;
        observed['A-turn'] = getExecutionContext()?.turnId ?? 'none';
        observed['A-deny'] = isIndexWriteDenied();
        gateA.resolve();
      },
    );
    const scopeB = runWithExecutionContext(
      ctx({
        threadId: 'B',
        turnId: 'turn-B',
        root: '/b',
        approvalSession: createApprovalSession('B'),
        indexWritePolicy: 'allow',
      }),
      async () => {
        gateB.resolve();
        await gateA.promise;
        observed['B'] = getChatApprovalSession().thread_id;
        observed['B-turn'] = getExecutionContext()?.turnId ?? 'none';
        observed['B-deny'] = isIndexWriteDenied();
      },
    );
    await Promise.all([scopeA, scopeB]);

    assert.equal(observed['A'], 'A');
    assert.equal(observed['A-turn'], 'turn-A');
    assert.equal(observed['A-deny'], true);
    assert.equal(observed['B'], 'B');
    assert.equal(observed['B-turn'], 'turn-B');
    assert.equal(observed['B-deny'], false);
    assert.equal(getExecutionContext(), undefined, 'ALS scope must unwind');
    assert.equal(getChatApprovalSession().thread_id, 'startup', 'no global leak');
  });
});

describe('S04/#214 T2 — a child cannot widen the parent lease', () => {
  test('child derives only from the ALS parent and inherits only in-ceiling grants', async () => {
    const parentA = createApprovalSession('A', ['other', 'write']);
    parentA.sessionAllows.add('other::A-scope');
    parentA.rules.push('narrow-a');
    const siblingB = createApprovalSession('B', ['other']);
    siblingB.sessionAllows.add('other::B-scope');

    const gate = deferred();
    let childFromA: ApprovalSessionState | undefined;
    const scopeA = runWithExecutionContext(
      ctx({ threadId: 'A', approvalSession: parentA }),
      async () => {
        await gate.promise; // sibling B is bound in its own async execution
        childFromA = deriveSubagentApprovalSession(
          getEffectiveApprovalSession() ?? parentA,
          'child-A',
          ['other'],
        );
      },
    );
    const scopeB = runWithExecutionContext(
      ctx({ threadId: 'B', approvalSession: siblingB }),
      async () => {
        gate.resolve();
      },
    );
    await Promise.all([scopeA, scopeB]);

    assert.ok(childFromA);
    assert.equal(childFromA!.thread_id, 'child-A');
    assert.ok(childFromA!.sessionAllows.has('other::A-scope'));
    assert.equal(childFromA!.sessionAllows.has('other::B-scope'), false, 'sibling grant leaked');
    assert.ok(childApprovalWithinParent(childFromA!, parentA));
    // Derivation filters a requested capability the parent lacks.
    const outOfCeiling = deriveSubagentApprovalSession(parentA, 'child-network', ['network']);
    assert.deepEqual(outOfCeiling.parentScopeCeiling, [], 'parent ceiling filters the child');

    const wider = createApprovalSession('wide', ['other', 'network']);
    assert.throws(
      () => assertChildApprovalWithinParent(wider, parentA),
      /widen the parent/,
    );
  });
});

describe('S04/#214 T3 — cancellation/rejection/exceptions restore the owner', () => {
  test('runWithExecutionContext restores the parent on throw, reject and abort', async () => {
    const parent = ctx({ threadId: 'P', turnId: 'turn-P' });
    const child = ctx({ threadId: 'C', turnId: 'turn-C' });

    await runWithExecutionContext(parent, async () => {
      assert.throws(() => {
        runWithExecutionContext(child, () => {
          throw new Error('boom');
        });
      }, /boom/);
      assert.equal(getExecutionContext()?.threadId, 'P', 'throw restored parent');

      await assert.rejects(
        runWithExecutionContext(child, async () => {
          throw new Error('reject');
        }),
        /reject/,
      );
      assert.equal(getExecutionContext()?.threadId, 'P', 'rejection restored parent');

      const controller = new AbortController();
      await runWithExecutionContext(child, async () => {
        controller.abort();
        assert.equal(getExecutionContext()?.threadId, 'C', 'child scope active before unwind');
      });
      assert.equal(getExecutionContext()?.threadId, 'P', 'abort restored parent');
    });
  });
});

describe('S04/#214 T4 — read-only index policy is task-local and does not leak', () => {
  test('overlapping read scopes each see deny; the policy unwinds', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const seen: Record<string, boolean> = {};

    const a = runWithExecutionContext(
      ctx({ threadId: 'A', indexWritePolicy: 'deny' }),
      async () => {
        seen['A-before'] = isIndexWriteDenied();
        gateB.resolve();
        await gateA.promise;
      },
    );
    const b = runWithExecutionContext(
      ctx({ threadId: 'B', indexWritePolicy: 'deny' }),
      async () => {
        gateB.resolve();
        await gateA.promise;
        seen['B-mid'] = isIndexWriteDenied();
      },
    );
    gateA.resolve();
    await Promise.all([a, b]);

    assert.equal(seen['A-before'], true);
    assert.equal(seen['B-mid'], true);
    assert.equal(isIndexWriteDenied(), false, 'policy must not leak past both scopes');
  });

  test('semantic search refuses to warm/create an index under a deny context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-idx-readonly-'));
    process.env['BABEL_PROJECT_ROOT'] = root;
    try {
      const result = await runWithExecutionContext(
        ctx({ root, indexWritePolicy: 'deny' }),
        () => handleSemanticSearch({ tool: 'semantic_search', query: 'anything', limit: 3 }),
      );
      assert.equal(result.exit_code, 1);
      assert.match(result.stderr ?? '', /no already-open index/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('S04/#214 T5 — grants/revocation bind to the right turn and operation digest', () => {
  test('the same action has a different operation digest under a different turn', async () => {
    const action = { type: 'write_file' as const, path: 'src/x.ts', content: 'x' };
    const turn1 = ctx({ threadId: 'T', turnId: 'turn-1', root: '/p' });
    const operation1 = approvalOperationFromAgentAction(action, {
      thread_id: 'T',
      turn_id: 'turn-1',
      cwd: '/p',
    });
    const digest1 = digestApprovalOperation(operation1);

    await runWithExecutionContext(turn1, async () => {
      assert.equal(getExecutionContext()?.turnId, 'turn-1');
      const live = approvalOperationFromAgentAction(action, {
        thread_id: 'T',
        turn_id: getExecutionContext()!.turnId!,
        cwd: getExecutionContext()!.root,
      });
      assert.equal(operationDigestMatches(digest1, live), true);
    });

    await runWithExecutionContext(ctx({ threadId: 'T', turnId: 'turn-2', root: '/p' }), async () => {
      const otherTurn = approvalOperationFromAgentAction(action, {
        thread_id: 'T',
        turn_id: getExecutionContext()!.turnId!,
        cwd: getExecutionContext()!.root,
      });
      assert.equal(operationDigestMatches(digest1, otherTurn), false, 'turn must bind the digest');
    });

    // I2: `allow_once` adds no grant by design, so it cannot demonstrate
    // turn-scoping. Use a durable `allow_session` (which DOES add a grant) and
    // assert the grant is scope-bound to the exact operation (path+payload),
    // not a blanket path allow. The turn id participates only in the digest,
    // which the first half of this test covers.
    const session = createApprovalSession('T');
    const req1 = buildApprovalRequest({
      thread_id: 'T',
      turn_id: 'turn-1',
      command: 'write src/x.ts',
      cwd: '/p',
      capability: 'write',
      proposed_scope: 'write:src/x.ts:nopayload',
      reason: 'r',
      operation_digest: digest1,
    });
    applyApprovalDecision(session, req1, 'allow_session');
    assert.equal(isPreApproved(session, req1), true, 'allow_session grants the exact scope');

    const sameScopeOtherPayload = buildApprovalRequest({
      thread_id: 'T',
      turn_id: 'turn-2',
      command: 'write src/x.ts',
      cwd: '/p',
      capability: 'write',
      proposed_scope: 'write:src/x.ts:payload2',
      reason: 'r',
      operation_digest: digestApprovalOperation(
        approvalOperationFromAgentAction(
          { type: 'write_file', path: 'src/x.ts', content: 'different' },
          { thread_id: 'T', turn_id: 'turn-2', cwd: '/p' },
        ),
      ),
    });
    assert.equal(
      isPreApproved(session, sameScopeOtherPayload),
      false,
      'a session grant is payload-scoped, not a blanket path allow',
    );

    // A child derived from the parent inherits the in-ceiling grant under its
    // own thread id, so a sibling scope cannot read the parent grant directly.
    const child = deriveSubagentApprovalSession(session, 'child-T', ['write']);
    assert.equal(child.thread_id, 'child-T');
    assert.ok(child.sessionAllows.has('write::write:src/x.ts:nopayload'));
  });

  test('headless approval inside a context uses that context turn, not a global', async () => {
    const action = { type: 'write_file' as const, path: 'a.ts', content: 'x' };
    let observedTurn: string | null = null;
    const session = createApprovalSession('CTX');
    const allowed = await runWithExecutionContext(
      ctx({ threadId: 'CTX', turnId: 'ctx-turn', root: '/ctx', approvalSession: session }),
      async () => {
        observedTurn = getExecutionContext()?.turnId ?? null;
        return requestChatActionApproval(action);
      },
    );
    assert.equal(allowed, false, 'no grant exists in the context session');
    assert.equal(observedTurn, 'ctx-turn', 'the request must run under the context turn');
    assert.equal(session.history.at(-1)?.decision, 'deny');
    assert.equal(session.history.at(-1)?.request_id !== undefined, true);
  });
});

describe('S04/#214 C1/I1 — production turn binding is scoped and unwound', () => {
  test('no execution context survives a completed turn and a second turn is not seeded by the first', async () => {
    const { ChatEngine } = await import('./chatEngine.js');
    const root = mkdtempSync(join(tmpdir(), 'babel-turn-scope-'));
    const install = (engine: InstanceType<typeof ChatEngine>, label: string) => {
      const runner = {
        executeWithToolsStream: async function* () {
          yield { type: 'text_delta', text: `${label} done.` };
          yield { type: 'done', finishReason: 'stop' };
        },
        execute: async () => ({ type: 'completion', answer: `${label} done.` }),
        getLastInvocationMetadata: () => null,
      };
      const anyEngine = engine as unknown as {
        deliberationRunner: unknown;
        synthesisRunner: unknown;
        shouldUseNativeTools: () => boolean;
      };
      anyEngine.deliberationRunner = runner;
      anyEngine.synthesisRunner = runner;
      anyEngine.shouldUseNativeTools = () => true;
    };

    try {
      resetChatApprovalSession('fallback-before');
      const engine = new ChatEngine({ task: 'first turn', projectRoot: root });
      install(engine, 'turn1');
      await engine.submitMessage('first turn', {});

      assert.equal(
        getExecutionContext(),
        undefined,
        'no execution context may survive a completed turn (C1)',
      );

      // A reset must not be masked by a leaked turn context.
      resetChatApprovalSession('fallback-after-reset');
      assert.equal(getChatApprovalSession().thread_id, 'fallback-after-reset');

      // A second engine turn must derive from the (reset) fallback, not from a
      // leaked prior turn's approval session.
      const engine2 = new ChatEngine({ task: 'second turn', projectRoot: root });
      let sessionDuringTurn: string | undefined;
      const anyEngine2 = engine2 as unknown as {
        deliberationRunner: unknown;
        synthesisRunner: unknown;
        shouldUseNativeTools: () => boolean;
      };
      const runner = {
        executeWithToolsStream: async function* () {
          sessionDuringTurn = getChatApprovalSession().thread_id;
          yield { type: 'text_delta', text: 'turn2 done.' };
          yield { type: 'done', finishReason: 'stop' };
        },
        execute: async () => ({ type: 'completion', answer: 'turn2 done.' }),
        getLastInvocationMetadata: () => null,
      };
      anyEngine2.deliberationRunner = runner;
      anyEngine2.synthesisRunner = runner;
      anyEngine2.shouldUseNativeTools = () => true;
      await engine2.submitMessage('second turn', {});

      assert.equal(sessionDuringTurn, 'fallback-after-reset');
      assert.equal(getExecutionContext(), undefined, 'second turn must also unwind');
    } finally {
      resetChatApprovalSession();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('S04/#214 T6 — same-parent child serialization retained', () => {
  test('a parallel_reads batch containing sub_agents still executes sequentially', async () => {
    process.env['BABEL_LITE_OFFLINE'] = '1';
    const root = mkdtempSync(join(tmpdir(), 'babel-serial-'));
    const { ChatEngine } = await import('./chatEngine.js');
    const engine = new ChatEngine({ task: 'serialize children', projectRoot: root });
    const sequence: string[] = [];
    const internals = engine as unknown as {
      executeActions: (
        actions: Array<{ type: 'sub_agent'; task: string; mutation?: boolean }>,
        callbacks: unknown,
      ) => Promise<unknown>;
    };
    try {
      await internals.executeActions(
        [
          { type: 'sub_agent', task: 'child one', mutation: false },
          { type: 'sub_agent', task: 'child two', mutation: false },
        ],
        {
          onSubAgentStart: (info: { id: string; label: string }) =>
            sequence.push(`start:${info.label}`),
          onSubAgentComplete: (info: { id: string; summary?: string }) =>
            sequence.push(`complete:${info.id}`),
        },
      );
      // With serialization, child two cannot start before child one completes.
      const twoStart = sequence.findIndex((entry) => entry.includes('child two'));
      const oneComplete = sequence.findIndex((entry) => entry.startsWith('complete:'));
      assert.ok(twoStart >= 0 && oneComplete >= 0, `sequence: ${sequence.join(',')}`);
      assert.ok(oneComplete < twoStart, `children must not overlap: ${sequence.join(',')}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
