/**
 * S04/#214 — execution-scoped immutable context.
 *
 * Approval session, turn id, effective root and read-only index-write policy
 * were process-wide globals / env flags, so overlapping asynchronous executions
 * could read or overwrite each other's binding (chatApproval.ts globals;
 * BABEL_READ_ONLY_NO_INDEX_WRITE). This module carries them in one immutable
 * context bound with AsyncLocalStorage, following the existing precedents
 * (localTools.runWithProjectRoot, bridge/remoteApproval.runOnRemoteSurface,
 * authority/unprivilegedChildEnv.runWithUnprivilegedChildEnv).
 *
 * The context is a *carrier*, not a policy evaluator. The single PDP remains
 * `agent/toolExecutor.ts::executeActionWithPolicy` (`AuthoritySessionContext`);
 * approval decisions remain in `agent/approvalRequests.ts`. A child derives a
 * new context strictly from the ALS-bound parent and may never widen the
 * parent's approval ceiling.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ApprovalSessionState } from './approvalRequests.js';

export type IndexWritePolicy = 'allow' | 'deny';

export interface ExecutionContext {
  readonly threadId: string;
  readonly turnId: string | null;
  /** Effective project root for this execution. */
  readonly root: string;
  /** Frozen-for-this-execution approval session (reference; mutated in place by decisions). */
  readonly approvalSession?: ApprovalSessionState;
  readonly indexWritePolicy: IndexWritePolicy;
  readonly taskOwnerId?: string;
  readonly parentTaskOwnerId?: string;
  /** Owning parent of a derived child scope, for no-widening / audit. */
  readonly parentTrace?: { threadId: string; turnId: string | null };
}

const store = new AsyncLocalStorage<ExecutionContext>();

/** Bind a context for the duration of `fn` (and its async descendants). */
export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * Bind a context for the remainder of the current async execution. Use only
 * where wrapping the awaited body is impractical; callers MUST restore the
 * owning context in a `finally`. Prefer `runWithExecutionContext`.
 *
 * This rebinds permanently within the current async execution, so it must never
 * be used to open a production turn: use `scopeAsyncGenerator` for that.
 */
export function enterWithExecutionContext(ctx: ExecutionContext): void {
  store.enterWith(ctx);
}

/** Restore a previously captured context (pair with `enterWithExecutionContext`). */
export function restoreExecutionContext(prior: ExecutionContext | undefined): void {
  store.enterWith(prior as ExecutionContext);
}

/**
 * Scope an async generator so every `next`/`return`/`throw` step runs with the
 * execution context produced by `contextFactory`, while the *consumer's* async
 * context is left untouched.
 *
 * `AsyncLocalStorage.run` cannot span a generator's suspension points, but a
 * generator body executes synchronously as part of each `next()` call, so
 * wrapping each step is sufficient: the store is active for the body's work and
 * unwinds automatically when the step returns. The factory is evaluated outside
 * the run scope, so it reads the engine's own state rather than a previously
 * bound context. This is what makes a completed turn leave no context behind.
 */
export function scopeAsyncGenerator<T>(
  contextFactory: () => ExecutionContext,
  source: AsyncGenerator<T, void, undefined>,
): AsyncGenerator<T, void, undefined> {
  const wrapper = {
    [Symbol.asyncIterator]() {
      return wrapper;
    },
    next: () => store.run(contextFactory(), () => source.next()),
    return: (value?: void) => store.run(contextFactory(), () => source.return(value as void)),
    throw: (err: unknown) => store.run(contextFactory(), () => source.throw(err)),
  };
  return wrapper as AsyncGenerator<T, void, undefined>;
}

export function getExecutionContext(): ExecutionContext | undefined {
  return store.getStore();
}

export function getEffectiveApprovalSession(): ApprovalSessionState | undefined {
  return store.getStore()?.approvalSession;
}

/**
 * Task-local read-only enforcement. The environment flag is honoured only as a
 * startup / child-process seed; an active execution context is authoritative.
 */
export function isIndexWriteDenied(): boolean {
  if (store.getStore()?.indexWritePolicy === 'deny') return true;
  return process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'] === '1';
}

/** True when the child approval ceiling is a subset of the parent's. */
export function childApprovalWithinParent(
  child: ApprovalSessionState,
  parent: ApprovalSessionState,
): boolean {
  return child.parentScopeCeiling.every((cap) => parent.parentScopeCeiling.includes(cap));
}

/** Fail closed if a derived child session would widen the parent ceiling. */
export function assertChildApprovalWithinParent(
  child: ApprovalSessionState,
  parent: ApprovalSessionState,
): void {
  if (!childApprovalWithinParent(child, parent)) {
    throw new Error(
      'S04/#214: derived child approval session would widen the parent ceiling; refusing to bind.',
    );
  }
}
