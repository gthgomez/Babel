/**
 * D04 — physical repository identity at the protocol hydration seam.
 *
 * The REPL resume seam fails closed with `repo_identity_mismatch` when a
 * durable identity provably points at a different physical repository. The
 * protocol surface must do the same before an engine is materialized/admitted:
 * `thread.resume` and `turn.submit` both hydrate through the shared
 * `sessionHydration` seam, so identity must be validated there.
 *
 * These are the alternate-path reproductions: a thread whose descriptor root
 * differs from its durable event-log root must be refused, not silently
 * hydrated, and a symlink alias of the same physical root must not be rejected
 * by a lexical comparison. A session with no resolvable identity is degraded
 * (never claimed verified) but still resumable as inert history.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatEngine } from '../../agent/chatEngine.js';
import {
  THREAD_EVENT_LOG_FILENAME,
  createThreadEventLog,
  endTurn,
  loadThreadEventLogFromDir,
  repoRootFingerprint,
  resolveRepoIdentityOnResume,
  resolveSavedRepoFingerprintFromLog,
  serializeThreadEventLog,
  startTurn,
  validateRepoIdentityOnResume,
} from '../../agent/threadEventLog.js';
import { chatSessionDir, threadDir } from '../../cli/runsLayout.js';
import { BabelProtocolErrorCode } from '../types.js';
import { createProtocolHostState, handleProtocolRequest } from './index.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-protocol-identity-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ConversationMessage {
  role: string;
  content: string;
}

/** Hydration-capable engine stub: records admitted history without a provider. */
class RecordingEngine {
  conversation: ConversationMessage[] = [];
  executions = 0;
  restoredLog = false;

  assignRunId(_runId: string): void {
    /* identity only */
  }

  cancel(): void {
    /* no-op */
  }

  getConversation(): ConversationMessage[] {
    return [...this.conversation];
  }

  replaceConversation(messages: ConversationMessage[]): void {
    this.conversation = [...messages];
  }

  replaceProviderConversation(_messages: unknown): void {
    /* not under test */
  }

  restoreEventLog(_log: unknown): void {
    this.restoredLog = true;
  }

  async *submitMessageStream(_message: string): AsyncGenerator<unknown> {
    this.executions += 1;
    yield { type: 'done', answer: 'ok', usage: {} };
  }
}

interface CountingHost {
  state: ReturnType<typeof createProtocolHostState>;
  counter: { calls: number };
}

function makeCountingHost(): CountingHost {
  const counter = { calls: 0 };
  const state = createProtocolHostState({
    engineFactory: () => {
      counter.calls += 1;
      return new RecordingEngine() as unknown as ChatEngine;
    },
    executeWithoutNotifications: true,
  });
  return { state, counter };
}

function freshHost(): ReturnType<typeof createProtocolHostState> {
  return createProtocolHostState({ executeWithoutNotifications: true });
}

async function createThread(
  state: ReturnType<typeof createProtocolHostState>,
  projectRoot: string,
): Promise<string> {
  const response = await handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: projectRoot, task: 'identity reproduction' },
    },
    state,
  );
  assert.ok('result' in response, 'thread.create must succeed');
  return (response as { result: { thread_id: string } }).result.thread_id;
}

/** Write a durable thread event log whose recorded root is `projectRoot`. */
function writeEventLog(threadId: string, projectRoot: string): void {
  const log = createThreadEventLog(threadId);
  const turn = startTurn(log, {
    task: 't',
    model: 'm',
    provider: 'p',
    projectRoot,
    policyPreset: 'safe_repo',
  });
  endTurn(log, turn, undefined, 'ok');
  const sessionDir = chatSessionDir(threadId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, THREAD_EVENT_LOG_FILENAME), serializeThreadEventLog(log));
}

function resume(
  state: ReturnType<typeof createProtocolHostState>,
  threadId: string,
  projectRoot?: string,
) {
  return handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'thread.resume',
      params: {
        thread_id: threadId,
        ...(projectRoot !== undefined ? { project_root: projectRoot } : {}),
      },
    },
    state,
  );
}

function submit(
  state: ReturnType<typeof createProtocolHostState>,
  threadId: string,
  message: string,
  confirmed?: boolean,
) {
  return handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'turn.submit',
      params: {
        thread_id: threadId,
        message,
        ...(confirmed !== undefined ? { repo_identity_confirmed: confirmed } : {}),
      },
    },
    state,
  );
}

interface RestoreView {
  resumable?: boolean;
  source?: string;
  repoIdentity?: { status?: string; reason?: string; savedRoot?: string | null };
}

function restoreOf(response: Awaited<ReturnType<typeof resume>>): RestoreView {
  return (response as { result?: { restore?: RestoreView } }).result?.restore ?? {};
}

test('D04 protocol hydration identity', { concurrency: false }, async (t) => {
  await t.test('thread.resume fails closed when descriptor root differs from durable log root', async () => {
    const fixture = withTempRunsDir();
    const descriptorRoot = mkdtempSync(join(tmpdir(), 'd04-proto-desc-'));
    const savedRoot = mkdtempSync(join(tmpdir(), 'd04-proto-saved-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, descriptorRoot);
      // Durable identity records a different physical repository than the
      // descriptor/current root, so resume must not trust the descriptor.
      writeEventLog(threadId, savedRoot);

      const resumed = await resume(freshHost(), threadId);
      assert.equal('error' in resumed, true, 'mismatch must fail closed, not hydrate');
      if (!('error' in resumed)) return;
      assert.equal(resumed.error.code, BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH);
      assert.match(resumed.error.message, /repo_identity_mismatch/);
      assert.match(resumed.error.message, new RegExp(escapeRegExp(savedRoot)));
      assert.match(resumed.error.message, new RegExp(escapeRegExp(descriptorRoot)));
    } finally {
      fixture.cleanup();
      rmSync(descriptorRoot, { recursive: true, force: true });
      rmSync(savedRoot, { recursive: true, force: true });
    }
  });

  await t.test('turn.submit fails closed before materializing an engine on mismatch', async () => {
    const fixture = withTempRunsDir();
    const descriptorRoot = mkdtempSync(join(tmpdir(), 'd04-proto-desc-sub-'));
    const savedRoot = mkdtempSync(join(tmpdir(), 'd04-proto-saved-sub-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, descriptorRoot);
      writeEventLog(threadId, savedRoot);

      const harness = makeCountingHost();
      const submitted = await submit(harness.state, threadId, 'continue on the wrong repo');
      assert.equal('error' in submitted, true, 'submit must fail closed, not execute');
      if (!('error' in submitted)) return;
      assert.equal(submitted.error.code, BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH);
      assert.equal(harness.counter.calls, 0, 'no engine may be materialized on mismatch');
    } finally {
      fixture.cleanup();
      rmSync(descriptorRoot, { recursive: true, force: true });
      rmSync(savedRoot, { recursive: true, force: true });
    }
  });

  await t.test('case-variant durable identity is a mismatch, not a lexical match', async () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      t.skip('requires a case-sensitive filesystem');
      return;
    }
    const fixture = withTempRunsDir();
    const parent = mkdtempSync(join(tmpdir(), 'd04-proto-case-'));
    try {
      const upper = join(parent, 'Repo');
      const lower = join(parent, 'repo');
      mkdirSync(upper);
      mkdirSync(lower);
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, upper);
      writeEventLog(threadId, lower);

      const resumed = await resume(freshHost(), threadId);
      assert.equal('error' in resumed, true, 'distinct physical roots must fail closed');
      if (!('error' in resumed)) return;
      assert.equal(resumed.error.code, BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH);
    } finally {
      fixture.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  await t.test('symlink alias of the same physical root is not rejected lexically', async (tc) => {
    if (process.platform === 'win32') {
      tc.skip('symlink semantics differ on Windows');
      return;
    }
    const fixture = withTempRunsDir();
    const realRoot = mkdtempSync(join(tmpdir(), 'd04-proto-real-'));
    const linkRoot = join(tmpdir(), `d04-proto-link-${process.pid}-${Date.now()}`);
    try {
      symlinkSync(realRoot, linkRoot, 'dir');
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, realRoot);
      writeEventLog(threadId, realRoot);

      // The caller supplies the symlink spelling of the same physical repo.
      const harness = makeCountingHost();
      const resumed = await resume(harness.state, threadId, linkRoot);
      assert.equal('error' in resumed, false, 'a symlink alias is the same physical repository');
      const restore = restoreOf(resumed);
      assert.equal(restore.repoIdentity?.status, 'verified');

      const submitted = await submit(harness.state, threadId, 'continue via alias');
      assert.equal('error' in submitted, false, 'verified alias must remain submittable');
      assert.equal(harness.counter.calls, 1, 'verified identity admits the runtime');
    } finally {
      fixture.cleanup();
      rmSync(linkRoot, { force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  await t.test('unresolvable identity is degraded, never claimed verified', async () => {
    const fixture = withTempRunsDir();
    const vanishedRoot = mkdtempSync(join(tmpdir(), 'd04-proto-vanish-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, vanishedRoot);
      // The repository no longer exists, so neither side resolves physically.
      rmSync(vanishedRoot, { recursive: true, force: true });

      const resumed = await resume(freshHost(), threadId);
      assert.equal('error' in resumed, false, 'unproven identity resumes as inert history');
      const restore = restoreOf(resumed);
      assert.equal(restore.resumable, true);
      assert.equal(restore.repoIdentity?.status, 'unknown', 'absence of identity must not be verified');
      assert.notEqual(restore.repoIdentity?.status, 'verified');
      assert.match(restore.repoIdentity?.reason ?? '', /identity/i);
    } finally {
      fixture.cleanup();
      rmSync(vanishedRoot, { recursive: true, force: true });
    }
  });

  await t.test('turn.submit proceeds degraded when identity is unknown', async () => {
    const fixture = withTempRunsDir();
    const vanishedRoot = mkdtempSync(join(tmpdir(), 'd04-proto-vanish-sub-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, vanishedRoot);
      rmSync(vanishedRoot, { recursive: true, force: true });

      const harness = makeCountingHost();
      const submitted = await submit(harness.state, threadId, 'degraded cold submit');
      assert.equal('error' in submitted, false, 'unknown identity must not hard-fail submission');
      assert.equal(harness.counter.calls, 1, 'degraded submission still materializes a runtime');
    } finally {
      fixture.cleanup();
      rmSync(vanishedRoot, { recursive: true, force: true });
    }
  });

  await t.test('R0-2: a synthesized descriptor cannot serve as its own historical identity', async () => {
    const fixture = withTempRunsDir();
    const rootA = mkdtempSync(join(tmpdir(), 'r0-2-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'r0-2-b-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, rootA);
      // Legacy / cells-only thread: no persisted descriptor, no durable
      // event-log identity, no session-events identity.
      rmSync(join(threadDir(threadId), 'session-descriptor.json'), { force: true });
      rmSync(join(chatSessionDir(threadId), THREAD_EVENT_LOG_FILENAME), { force: true });

      // Resume the thread against an unrelated repository B. With no historical
      // evidence the current root must never prove its own identity.
      const resumed = await resume(freshHost(), threadId, rootB);
      assert.equal('error' in resumed, false, 'unknown identity resumes as inspectable history');
      const restore = restoreOf(resumed);
      assert.equal(
        restore.repoIdentity?.status,
        'unknown',
        'no durable historical identity => unknown, never verified',
      );
      assert.notEqual(restore.repoIdentity?.status, 'verified');
    } finally {
      fixture.cleanup();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  await t.test('R0-4: the durable log records an advisory root fingerprint (canonical continuity)', async (tc) => {
    if (process.platform === 'win32') {
      tc.skip('filesystem inode identity is unavailable on this platform');
      return;
    }
    const fixture = withTempRunsDir();
    const repoRoot = mkdtempSync(join(tmpdir(), 'r0-4-repo-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, repoRoot);
      writeEventLog(threadId, repoRoot);

      const log = loadThreadEventLogFromDir(chatSessionDir(threadId));
      const fingerprint = resolveSavedRepoFingerprintFromLog(log);
      assert.ok(fingerprint, 'a filesystem fingerprint is recorded at turn start');
      assert.deepEqual(fingerprint, repoRootFingerprint(repoRoot), 'fingerprint matches the root');
      // The same repository verifies against its own recorded fingerprint.
      assert.equal(
        validateRepoIdentityOnResume(log, repoRoot).status,
        'verified',
        'an unchanged repository verifies',
      );
      // A DIFFERENT filesystem identity is a mismatch, not path continuity.
      // NOTE: this is advisory — an inode can be reused after delete/recreate,
      // so a same-path replacement is not always distinguishable. The claim is
      // canonical-root continuity, not proven physical identity.
      assert.equal(
        resolveRepoIdentityOnResume(repoRoot, repoRoot, { device: -1, inode: -1 }).status,
        'mismatch',
        'a differing filesystem identity fails closed',
      );
    } finally {
      fixture.cleanup();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  await t.test('R0-3: unknown identity with durable history requires explicit rebind before execution', async () => {
    const fixture = withTempRunsDir();
    const savedRoot = mkdtempSync(join(tmpdir(), 'r0-3-history-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, savedRoot);
      writeEventLog(threadId, savedRoot);
      // The recorded root no longer resolves, so identity is unprovable while
      // durable history remains.
      rmSync(savedRoot, { recursive: true, force: true });

      // History is inspectable and truthfully reports unknown identity.
      const resumed = await resume(freshHost(), threadId);
      assert.equal('error' in resumed, false, 'history remains inspectable');
      assert.equal(restoreOf(resumed).repoIdentity?.status, 'unknown');

      // Execution is guarded: no silent run on unproven identity.
      const harness = makeCountingHost();
      const refused = await submit(harness.state, threadId, 'execute without rebind');
      assert.equal('error' in refused, true, 'unknown identity must not execute silently');
      if (!('error' in refused)) return;
      assert.equal(refused.error.code, BabelProtocolErrorCode.REPO_IDENTITY_UNKNOWN);
      assert.equal(harness.counter.calls, 0, 'no engine materialized without rebind');

      // Explicit rebind/confirmation admits execution.
      const confirmed = await submit(harness.state, threadId, 'execute after rebind', true);
      assert.equal('error' in confirmed, false, 'explicit rebind admits execution');
      assert.equal(harness.counter.calls, 1, 'confirmed submission materializes the runtime');
    } finally {
      fixture.cleanup();
      rmSync(savedRoot, { recursive: true, force: true });
    }
  });

  await t.test('submit re-validates identity and does not trust a report verified before the change', async () => {
    const fixture = withTempRunsDir();
    const descriptorRoot = mkdtempSync(join(tmpdir(), 'd04-proto-stale-desc-'));
    const rotatedRoot = mkdtempSync(join(tmpdir(), 'd04-proto-stale-rot-'));
    try {
      const creator = createProtocolHostState();
      const threadId = await createThread(creator, descriptorRoot);
      writeEventLog(threadId, descriptorRoot);

      // A resume that validated cleanly, caching a `verified` restore report.
      const harness = makeCountingHost();
      const resumed = await resume(harness.state, threadId);
      assert.equal('error' in resumed, false);
      assert.equal(restoreOf(resumed).repoIdentity?.status, 'verified');

      // The durable identity now points elsewhere; submission must re-check and
      // refuse rather than trust the cached verified report.
      writeEventLog(threadId, rotatedRoot);
      const submitted = await submit(harness.state, threadId, 'continue after identity change');
      assert.equal('error' in submitted, true, 'a stale verified report must not admit execution');
      if (!('error' in submitted)) return;
      assert.equal(submitted.error.code, BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH);
      assert.equal(harness.counter.calls, 0);
    } finally {
      fixture.cleanup();
      rmSync(descriptorRoot, { recursive: true, force: true });
      rmSync(rotatedRoot, { recursive: true, force: true });
    }
  });
});
