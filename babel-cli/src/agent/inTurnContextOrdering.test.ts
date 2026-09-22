/**
 * In-turn context ordering (Task 5 — R1/P11 closure).
 *
 * Sequencing invariant under test (.superpowers/sdd/r1-closure-plan/task-5-brief.md):
 *   candidate compaction → durable capsule commit → validate/install the
 *   CURRENT context checkpoint → rebuild provider messages FROM THE INSTALLED
 *   AUTHORITY → provider invocation.
 *
 * Dispatch assertions capture the ACTUAL provider request at the runner
 * boundary (executeWithToolsStream arguments) and in the serialized fetch
 * body — never internal engine state alone. The installed root answers
 * "which exact installed context root authorized this message sequence?"
 * through the existing route-identity pattern: `checkpoint.route.compiled_request_identity`
 * must be the sha256 of exactly the dispatched {mode, prompt, systemPrompt,
 * providerMessages} tuple.
 *
 * The compacting scenario runs inside ONE submission (the natural production
 * shape): loop iteration 1 dispatches a tool call and installs generation A;
 * loop iteration 2 commits capsule B through `compactIfNeeded` before the
 * rebuild/install/dispatch sequence. (Fresh, non-continued submissions drop
 * the task-scoped in-memory generation at applyUserSubmission, so the
 * "promoted A still in memory when B commits" window only exists within one
 * submission — exactly the routed Task-4 trace.)
 *
 * Required matrix (brief + routed Task-4 finding):
 *   1. compacting turn dispatches the JUST-INSTALLED generation (root identity,
 *      content, route-identity binding), completing in enforce mode.
 *   2. non-compacting turns are unchanged (dispatch deep-equals the rebuild the
 *      pre-fix ordering produced; install-blocked / install-unavailable paths
 *      unchanged).
 *   3. routed Task-4 trace: promoted A + mid-process commit B → next dispatch
 *      roots at B (never A), in BOTH enforce and shadow modes; B validates
 *      CURRENT while A proves `lineage_superseded`.
 *   4. negative control: install fails in a compacting turn → dispatch is
 *      refused (fail closed), never a stale-A dispatch.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { commitCompaction } from './compactionCommit.js';
import type { ChatMessage } from './chatCompaction.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ProviderMessage } from '../runners/base.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir, openSessionAdmissionStore } from '../cli/runsLayout.js';
import { getOpenAdmissionStoreCount } from '../runtime/admissionTestHooks.js';
import {
  validateContextCheckpoint,
  type ContextCheckpointV1,
} from '../runtime/contextCheckpoints.js';
import type { AdmissionStore } from '../runtime/admission.js';

const TURN1_TASK = 'question one: first fixture question';
const TURN2_TASK = 'question two COMPACT_MARKER_TWO second fixture question';
const TURN3_TASK = 'question three: non-compacting continuation';
const CAPSULE_MARKER = '# Compaction capsule';

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'test-fixture',
  family: 'test-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'test-fixture',
  provider: 'opencode-go',
  providerModelId: 'mimo-v2.5',
  expensive: false,
  enabled: true,
  experimental: true,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4_096,
  nativeToolUse: true,
};

// ─── fixture harness (mirrors p11AdmissionWiring.test.ts) ─────────────────

async function withRunsDir(fn: () => Promise<void>): Promise<void> {
  const previous = process.env['BABEL_RUNS_DIR'];
  const runsRoot = mkdtempSync(join(tmpdir(), 't5-ordering-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previous;
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

function requireStore(sessionId: string): AdmissionStore {
  const opened = openSessionAdmissionStore(sessionId);
  assert.equal(opened.ok, true, opened.ok ? '' : `${opened.reasonCode}: ${opened.detail}`);
  if (!opened.ok) throw new Error('store unavailable');
  return opened.store;
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 't5-ordering-proj-'));
  writeFileSync(join(root, 'README.md'), 'fixture repository\n', 'utf8');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

interface ProviderStubState {
  providerCalls: number;
  bodies: string[];
}

/** OpenAI-compatible SSE stub that records the EXACT serialized request body. */
function stubProvider(state: ProviderStubState): void {
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    state.providerCalls += 1;
    if (init?.body !== undefined && init.body !== null) {
      state.bodies.push(String(init.body));
    }
    return new Response(
      `data: ${JSON.stringify({
        model: 'mimo-v2.5',
        choices: [{ delta: { content: 'fixture answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  }) as typeof fetch;
}

// ─── engine capture: the real provider boundary + rebuild roots ───────────

interface DispatchRecord {
  messages: ProviderMessage[];
  systemPrompt: string | null;
  prompt: string | null;
}

interface TurnCapture {
  /** Every executeWithToolsStream invocation, in order. */
  dispatches: DispatchRecord[];
  /** Every rebuildProviderMessages call with the authority root it was given. */
  rebuilds: Array<{ root: ContextCheckpointV1 | null; messages: ProviderMessage[] }>;
  prompts: string[];
  control: {
    /**
     * When true, the first dispatch of a submission is synthetic: it records
     * the real request content at the runner boundary but yields a tool call
     * instead of hitting the provider, so the SAME submission reaches a second
     * loop iteration — the production shape in which a promoted generation is
     * still in memory when the next iteration commits a capsule.
     */
    syntheticToolRound: boolean;
  };
}

function capturingEngine(
  runId: string,
  projectRoot: string,
  store: AdmissionStore,
  options?: { runtimeInvariantMode?: 'enforce' | 'shadow' },
): { engine: ChatEngine; capture: TurnCapture } {
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'fixture-only',
  });
  const capture: TurnCapture = {
    dispatches: [],
    rebuilds: [],
    prompts: [],
    control: { syntheticToolRound: false },
  };

  // Capture the ACTUAL provider request at the runner boundary.
  const runnerSlots = runner as unknown as {
    executeWithToolsStream: (...args: unknown[]) => AsyncGenerator<unknown, void, undefined>;
  };
  const originalExecuteWithToolsStream = runner.executeWithToolsStream.bind(runner);
  runnerSlots.executeWithToolsStream = (...args: unknown[]) => {
    const messages = args[0] as ProviderMessage[];
    const systemPrompt = (args[2] as string | undefined) ?? null;
    const prompt = capture.prompts.length > 0 ? capture.prompts[capture.prompts.length - 1]! : null;
    capture.dispatches.push({ messages, systemPrompt, prompt });
    if (capture.control.syntheticToolRound && capture.dispatches.length === 1) {
      return (async function* syntheticToolRound() {
        yield {
          type: 'tool_use' as const,
          id: 'tool-t5-round-1',
          name: 'read_file',
          input: { path: 'README.md' },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' as const };
      })();
    }
    return originalExecuteWithToolsStream(
      ...(args as Parameters<OpenCodeGoApiRunner['executeWithToolsStream']>),
    );
  };

  const engine = new ChatEngine({
    task: 'Prove in-turn context ordering',
    projectRoot,
    runId,
    admissionStore: store,
    model: 'mimo-v2.5',
    maxTurns: 4,
    providerRunner: runner,
    providerPolicy: FIXTURE_POLICY,
    ...(options?.runtimeInvariantMode
      ? { runtimeInvariantMode: options.runtimeInvariantMode }
      : {}),
  });
  const internals = engine as unknown as Record<string, unknown>;
  // Phase routing resolves through these slots; pin both to the wrapped fixture
  // runner so dispatch capture always sees the real provider boundary.
  internals['investigateRunner'] = runner;
  internals['mutateRunner'] = runner;
  // Tool execution is out of scope for ordering: run the real turn body, stub
  // only the action effect and the P11 observation capture (ordering does not
  // depend on observations, and an empty manifest keeps install deterministic).
  internals['executeOneAction'] = async (action: unknown) => ({
    action,
    observation: 'fixture observation: README.md fixture repository',
  });
  internals['captureP11Observation'] = () => {};

  const services = internals['services'] as {
    conversation: {
      rebuildProviderMessages: (...args: unknown[]) => ProviderMessage[];
      buildTurnPrompt: (...args: unknown[]) => string;
    };
  };
  const originalRebuild = services.conversation.rebuildProviderMessages.bind(
    services.conversation,
  );
  services.conversation.rebuildProviderMessages = (log: unknown, opts: unknown) => {
    const messages = originalRebuild(log, opts);
    const root =
      (opts as { installedContextCheckpoint?: ContextCheckpointV1 } | undefined)
        ?.installedContextCheckpoint ?? null;
    capture.rebuilds.push({ root, messages });
    return messages;
  };
  const originalPrompt = services.conversation.buildTurnPrompt.bind(services.conversation);
  services.conversation.buildTurnPrompt = (opts: unknown) => {
    const prompt = originalPrompt(opts);
    capture.prompts.push(prompt);
    return prompt;
  };

  return { engine, capture };
}

interface SubmitOutcome {
  events: Array<{ type: string } & Record<string, unknown>>;
  error: unknown;
  last: ({ type: string } & Record<string, unknown>) | null;
}

async function submit(
  engine: ChatEngine,
  text: string,
  submitOpts?: { continueTask?: boolean },
): Promise<SubmitOutcome> {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  let error: unknown = null;
  try {
    for await (const event of engine.submitMessageStream(
      text,
      undefined,
      submitOpts ?? {},
    )) {
      events.push(event as { type: string } & Record<string, unknown>);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error, last: events.length > 0 ? events[events.length - 1]! : null };
}

interface CompactionStubState {
  calls: number;
  threadEventId: string | null;
  sessionEventId: string | null;
  committed: boolean;
}

/**
 * Replace only the compaction TRIGGER at a chosen `compactIfNeeded` call with a
 * real durable capsule commit — `commitCompaction` is the exact production
 * commit path (thread `compaction_capsule` + session `compaction_committed` +
 * retained working-set re-append), so the mid-process commit the ordering
 * invariant guards against is genuine. Every other call delegates to the real
 * `compactIfNeeded`, and the turn body after it runs untouched production
 * code: rebuild → install → dispatch.
 */
function stubMidTurnCompaction(
  engine: ChatEngine,
  task: string,
  commitAtCall: number,
): CompactionStubState {
  const state: CompactionStubState = {
    calls: 0,
    threadEventId: null,
    sessionEventId: null,
    committed: false,
  };
  const internals = engine as unknown as Record<string, unknown>;
  const original = internals['compactIfNeeded'] as (
    ...args: unknown[]
  ) => Promise<unknown>;
  internals['compactIfNeeded'] = async (...args: unknown[]) => {
    state.calls += 1;
    if (state.calls !== commitAtCall) {
      return original.call(engine, ...args);
    }
    const parity = engine.getParityRuntime();
    const conversation = internals['conversation'] as ChatMessage[];
    const commit = await commitCompaction({
      strategyMessages: [...conversation],
      priorConversation: conversation,
      strategy: 'heuristic-retained',
      tokensBefore: 1200,
      tokensAfter: 400,
      operational: { task },
      threadLog: parity.eventLog,
      sessionLog: parity.sessionEvents,
      turnId: parity.turnId,
      modelId: 'mimo-v2.5',
      persist: async () => true,
      blockOnPersistFailure: true,
    });
    assert.equal(
      commit.status,
      'committed',
      `mid-turn capsule must commit (got ${commit.status}: ${commit.error ?? ''})`,
    );
    state.threadEventId = commit.threadEventId ?? null;
    state.sessionEventId = commit.sessionEventId ?? null;
    state.committed = true;
    internals['conversation'] = commit.conversation;
    return {
      mode: 'llm' as const,
      beforeMessages: conversation.length,
      afterMessages: commit.conversation.length,
      message: `[Context compacted…] ${conversation.length}→${commit.conversation.length} messages (llm)`,
    };
  };
  return state;
}

/** Make every P11 source (and therefore prepare/install) unavailable. */
function blockP11Install(engine: ChatEngine, when?: () => boolean): () => void {
  const internals = engine as unknown as Record<string, unknown>;
  const original = internals['buildP11Sources'] as (
    ...args: unknown[]
  ) => unknown;
  internals['buildP11Sources'] = (...args: unknown[]) => {
    if (!when || when()) return null;
    return original.call(engine, ...args);
  };
  return () => {
    internals['buildP11Sources'] = original;
  };
}

// ─── assertions over captured artifacts ───────────────────────────────────

function readCheckpoint(runId: string): ContextCheckpointV1 | null {
  const path = join(chatSessionDir(runId), 'context-checkpoint.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as ContextCheckpointV1;
}

function countContent(
  messages: readonly { content?: unknown }[],
  content: string,
): number {
  return messages.filter(
    (message) => 'content' in message && (message as { content?: unknown }).content === content,
  ).length;
}

function countOccurrences(messages: readonly { content?: unknown }[], needle: string): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') total += content.split(needle).length - 1;
  }
  return total;
}

function countCapsuleMessages(messages: readonly ProviderMessage[]): number {
  return messages.filter(
    (message) => 'name' in message && (message as { name?: unknown }).name === 'compaction_capsule',
  ).length;
}

function wireMessages(bodies: string[], bodyIndex: number): ProviderMessage[] | null {
  if (bodies.length <= bodyIndex) return null;
  const body = JSON.parse(bodies[bodyIndex]!) as { messages?: ProviderMessage[] };
  return Array.isArray(body.messages) ? body.messages : null;
}

/** chatEngine.ts turn body: sha256({mode, prompt, systemPrompt, providerMessages}). */
function compiledRequestIdentity(
  mode: 'native' | 'text' | 'legacy',
  prompt: string,
  systemPrompt: string,
  messages: ProviderMessage[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ mode, prompt, systemPrompt, providerMessages: messages }))
    .digest('hex');
}

function resetCapture(capture: TurnCapture): void {
  capture.dispatches.length = 0;
  capture.rebuilds.length = 0;
  capture.prompts.length = 0;
}

/** The rebuild call that PRODUCED a given dispatch (array identity). */
function rootOfDispatch(capture: TurnCapture, dispatchIndex: number): ContextCheckpointV1 {
  const dispatch = capture.dispatches[dispatchIndex];
  assert.ok(dispatch, `dispatch #${dispatchIndex} must have reached the provider runner`);
  const entry = capture.rebuilds.find((candidate) => candidate.messages === dispatch.messages);
  assert.ok(entry, 'dispatched messages must be the product of a rebuild call');
  assert.ok(
    entry.root,
    'dispatched rebuild must name an installed/candidate context root (stale/absent root would mean unrooted dispatch)',
  );
  return entry.root;
}

/** The first promoted generation visible in the submission's rebuild history. */
function promotedGenerationA(capture: TurnCapture): ContextCheckpointV1 {
  const entry = capture.rebuilds.find(
    (candidate) =>
      candidate.root !== null &&
      (candidate.root.installed_lineage?.compaction_commit_event_id ?? null) === null,
  );
  assert.ok(entry?.root, 'loop iteration 1 must promote generation A');
  return entry.root;
}

// ─── 1. compacting turn uses the just-installed generation ────────────────

test('compacting turn: provider request uses the just-installed generation (runner capture + route identity)', async () => {
  await withRunsDir(async () => {
    const runId = 't5-compacting-turn';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const provider: ProviderStubState = { providerCalls: 0, bodies: [] };
    const originalFetch = globalThis.fetch;
    stubProvider(provider);
    let engine: ChatEngine | undefined;
    try {
      const { engine: subject, capture } = capturingEngine(runId, projectRoot, store, {
        runtimeInvariantMode: 'enforce',
      });
      engine = subject;

      // One submission, two loop iterations:
      //  iteration 1 — tool call dispatch, generation A installs;
      //  iteration 2 — compactIfNeeded commits capsule B, then the turn body
      //                rebuilds / installs / dispatches for THIS turn.
      capture.control.syntheticToolRound = true;
      const compaction = stubMidTurnCompaction(engine, TURN2_TASK, 2);
      const bodiesBefore = provider.bodies.length;
      const outcome = await submit(engine, TURN1_TASK);

      assert.equal(
        outcome.error,
        null,
        `enforce mode must not kill the compacting iteration pre-dispatch because of ordering: ${outcome.error}`,
      );
      assert.equal(outcome.last?.type, 'done', 'the submission must complete');
      assert.ok(compaction.threadEventId, 'the mid-turn capsule must have committed');
      assert.ok(compaction.sessionEventId, 'the mid-turn commit must be durable in session events');
      assert.ok(
        capture.dispatches.length >= 2,
        'both loop iterations must have reached the provider runner',
      );
      assert.ok(
        provider.bodies.length > bodiesBefore,
        'the compacting iteration must produce a serialized provider request',
      );

      // Generation A (promoted by iteration 1) for the "never A" comparisons.
      const checkpointA = promotedGenerationA(capture);

      // (a) Root identity: the compacting dispatch is rooted at the checkpoint
      // installed THIS iteration — the just-installed generation B.
      const rootB = rootOfDispatch(capture, 1);
      assert.equal(
        rootB.installed_lineage?.compaction_commit_event_id ?? null,
        compaction.sessionEventId,
        'the dispatch root lineage must name the mid-turn capsule commit',
      );
      assert.notEqual(
        rootB.installed_lineage?.compaction_event_id ?? null,
        null,
        'the dispatch root must be the B lineage (A has no compaction lineage)',
      );
      assert.notEqual(
        rootB.checkpoint_digest,
        checkpointA.checkpoint_digest,
        'dispatch must never root at the superseded generation A',
      );
      const diskB = readCheckpoint(runId);
      assert.ok(diskB, 'generation B must be installed on disk');
      assert.equal(
        rootB.checkpoint_digest,
        diskB.checkpoint_digest,
        'the dispatched root must be the checkpoint installed this iteration',
      );
      assert.equal(
        diskB.installed_lineage?.compaction_commit_event_id ?? null,
        compaction.sessionEventId,
      );

      // (b) Content of the ACTUAL dispatched request: B-rooted.
      const dispatchB = capture.dispatches[1]!;
      assert.equal(
        countCapsuleMessages(dispatchB.messages),
        1,
        'the just-committed capsule must appear exactly once in the dispatched messages',
      );
      assert.ok(
        countContent(dispatchB.messages, TURN1_TASK) <= 1,
        'pre-compaction history must never be duplicated (an A-rooted dispatch repeats it)',
      );
      assert.ok(dispatchB.systemPrompt && dispatchB.prompt, 'identity inputs must be captured');

      // (c) The serialized provider request (wire) carries the same content.
      const wire = wireMessages(provider.bodies, bodiesBefore);
      assert.ok(wire, 'the compacting iteration must produce a serialized request body');
      assert.equal(
        countOccurrences(wire, CAPSULE_MARKER),
        1,
        'the wire request must contain the capsule exactly once',
      );
      assert.ok(
        countContent(wire, TURN1_TASK) <= 1,
        'the wire request must not duplicate pre-compaction history',
      );

      // (d) Route identity binds the installed root to EXACTLY this request.
      const identity = compiledRequestIdentity(
        'native',
        dispatchB.prompt!,
        dispatchB.systemPrompt!,
        dispatchB.messages,
      );
      assert.equal(
        diskB.route?.compiled_request_identity,
        identity,
        'the installed root must carry the identity of the dispatched message sequence',
      );

      // (e) Enforce-mode coherence: no runtime-invariant violation recorded.
      assert.equal(
        engine.getRuntimeInvariantViolationCount(),
        0,
        'the dispatch/reconstruction tripwire must pass by construction after the ordering fix',
      );

      // (f) Interplay with Task 4: B is CURRENT; A proves superseded.
      const parity = engine.getParityRuntime();
      const evidence = {
        threadEvents: parity.eventLog.events,
        sessionEvents: parity.sessionEvents.events,
      };
      const bValidation = validateContextCheckpoint(diskB, {
        requireInstalledLineage: true,
        lineageEvidence: evidence,
      });
      assert.equal(
        bValidation.status,
        'valid',
        `just-installed B must be current under the currency rule: ${bValidation.reasons.join('; ')}`,
      );
      const aValidation = validateContextCheckpoint(checkpointA, {
        requireInstalledLineage: true,
        lineageEvidence: evidence,
      });
      assert.equal(aValidation.status, 'blocked', 'A must no longer be provable as current');
      assert.ok(
        aValidation.reasons.includes('lineage_superseded'),
        `A must be proven stale after B commits: ${aValidation.reasons.join('; ')}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });
});

// ─── 2. non-compacting turns remain unchanged ─────────────────────────────

test('non-compacting turns: dispatch identical to the pre-fix rebuild, install paths unchanged', async () => {
  await withRunsDir(async () => {
    const runId = 't5-noncompacting';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const provider: ProviderStubState = { providerCalls: 0, bodies: [] };
    const originalFetch = globalThis.fetch;
    stubProvider(provider);
    let engine: ChatEngine | undefined;
    try {
      const { engine: subject, capture } = capturingEngine(runId, projectRoot, store, {
        runtimeInvariantMode: 'enforce',
      });
      engine = subject;

      // (A) First turn: no compaction anywhere. The pre-fix ordering rebuilt
      // (and dispatched) from whatever root was in memory (none on a fresh
      // submission); a non-compacting turn must keep producing that array.
      let bodiesBefore = provider.bodies.length;
      const first = await submit(engine, TURN1_TASK);
      assert.equal(first.error, null, `turn 1 must not throw: ${first.error}`);
      assert.equal(first.last?.type, 'done');
      const checkpointA = readCheckpoint(runId);
      assert.ok(checkpointA, 'turn 1 must install generation A');
      assert.equal(checkpointA.installed_lineage?.compaction_event_id ?? null, null);
      assert.equal(
        capture.rebuilds[0]?.root ?? null,
        null,
        'fresh submission: the pre-install rebuild root is unchanged (no root in memory)',
      );
      const firstDispatch = capture.dispatches[0];
      assert.ok(firstDispatch);
      assert.deepEqual(
        firstDispatch.messages,
        capture.rebuilds[0]!.messages,
        'turn-1 dispatch must be identical to the pre-fix rebuild (no behavior delta)',
      );
      assert.ok(firstDispatch.prompt && firstDispatch.systemPrompt);
      assert.equal(
        checkpointA.route?.compiled_request_identity,
        compiledRequestIdentity(
          'native',
          firstDispatch.prompt!,
          firstDispatch.systemPrompt!,
          firstDispatch.messages,
        ),
        'route identity binds the installed root to the dispatched sequence (as before)',
      );
      const firstWire = wireMessages(provider.bodies, bodiesBefore);
      assert.ok(firstWire);
      assert.equal(countOccurrences(firstWire, CAPSULE_MARKER), 0);

      // (A2) The NEXT turn, fresh submission, no compaction: unchanged.
      resetCapture(capture);
      bodiesBefore = provider.bodies.length;
      const second = await submit(engine, TURN2_TASK);
      assert.equal(second.error, null, `turn 2 must not throw: ${second.error}`);
      assert.equal(second.last?.type, 'done');
      assert.equal(
        capture.rebuilds[0]?.root ?? null,
        null,
        'fresh submission drops the task-scoped root at applyUserSubmission (unchanged behavior)',
      );
      const secondDispatch = capture.dispatches[0];
      assert.ok(secondDispatch);
      assert.deepEqual(
        secondDispatch.messages,
        capture.rebuilds[0]!.messages,
        'non-compacting dispatch must be identical to the pre-fix rebuild (no behavior delta)',
      );
      const diskB = readCheckpoint(runId);
      assert.ok(diskB);
      assert.equal(
        diskB.installed_lineage?.compaction_event_id ?? null,
        checkpointA.installed_lineage?.compaction_event_id ?? null,
        'non-compacting turn: installed lineage must not change',
      );
      assert.ok(secondDispatch.prompt && secondDispatch.systemPrompt);
      assert.equal(
        diskB.route?.compiled_request_identity,
        compiledRequestIdentity(
          'native',
          secondDispatch.prompt!,
          secondDispatch.systemPrompt!,
          secondDispatch.messages,
        ),
        'route identity still binds the installed root to the dispatched sequence',
      );
      const secondWire = wireMessages(provider.bodies, bodiesBefore);
      assert.ok(secondWire);
      assert.equal(countOccurrences(secondWire, CAPSULE_MARKER), 0, 'no capsule on a non-compacting turn');

      // (2a) Install blocked while a generation is in memory (continued
      // submission) ⇒ refuse — the pre-existing guard, unchanged.
      const restoreSources = blockP11Install(engine);
      const bodiesBeforeBlocked = provider.bodies.length;
      const dispatchesBeforeBlocked = capture.dispatches.length;
      const blocked = await submit(engine, TURN3_TASK, { continueTask: true });
      restoreSources();
      assert.equal(blocked.error, null, `blocked install must fail closed, not throw: ${blocked.error}`);
      assert.equal(
        blocked.last?.type,
        'failed',
        'install failure with an in-memory generation refuses dispatch',
      );
      assert.match(
        String(blocked.last?.['error'] ?? ''),
        /P11 context installation was blocked/,
        'the refusal must name the P11 install failure',
      );
      assert.equal(
        provider.bodies.length,
        bodiesBeforeBlocked,
        'a refused turn must not reach the provider',
      );
      assert.equal(
        capture.dispatches.length,
        dispatchesBeforeBlocked,
        'a refused turn must not dispatch',
      );
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });

  // (2b) Install never available on a capsule-less session: dispatch proceeds
  // exactly as before the ordering fix (root-less rebuild, no refusal).
  await withRunsDir(async () => {
    const runId = 't5-no-install-ever';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const provider: ProviderStubState = { providerCalls: 0, bodies: [] };
    const originalFetch = globalThis.fetch;
    stubProvider(provider);
    let engine: ChatEngine | undefined;
    try {
      const { engine: subject, capture } = capturingEngine(runId, projectRoot, store, {
        runtimeInvariantMode: 'enforce',
      });
      engine = subject;
      const restoreSources = blockP11Install(engine);
      const first = await submit(engine, TURN1_TASK);
      restoreSources();
      assert.equal(first.error, null, `no-install turn must not throw: ${first.error}`);
      assert.equal(
        first.last?.type,
        'done',
        'a capsule-less turn dispatches even without install (unchanged)',
      );
      const dispatch = capture.dispatches[0];
      assert.ok(dispatch);
      const entry = capture.rebuilds.find((candidate) => candidate.messages === dispatch.messages);
      assert.ok(entry);
      assert.equal(
        entry.root,
        null,
        'no installed root: the rebuild stays root-less exactly as before',
      );
      assert.equal(readCheckpoint(runId), null, 'no checkpoint may install');
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });
});

// ─── 3. routed Task-4 trace: promoted A + commit B mid-process ────────────

test('routed Task-4 trace: after B commits mid-process the next dispatch roots at B, never A (enforce + shadow)', async () => {
  // shadow first: in production (shadow default) the pre-fix ordering does NOT
  // throw — it silently dispatches the stale generation, which the root/content
  // assertions below catch. enforce follows and must no longer die either.
  for (const mode of ['shadow', 'enforce'] as const) {
    await withRunsDir(async () => {
      const runId = `t5-routed-${mode}`;
      const projectRoot = makeProjectRoot();
      const store = requireStore(runId);
      const provider: ProviderStubState = { providerCalls: 0, bodies: [] };
      const originalFetch = globalThis.fetch;
      stubProvider(provider);
      let engine: ChatEngine | undefined;
      try {
        const { engine: subject, capture } = capturingEngine(runId, projectRoot, store, {
          runtimeInvariantMode: mode,
        });
        engine = subject;

        // Single submission: iteration 1 promotes A, iteration 2 commits B.
        capture.control.syntheticToolRound = true;
        const compaction = stubMidTurnCompaction(engine, TURN2_TASK, 2);
        const bodiesBefore = provider.bodies.length;
        const outcome = await submit(engine, TURN1_TASK);
        assert.equal(
          outcome.error,
          null,
          `[${mode}] compacting iteration must not die pre-dispatch: ${outcome.error}`,
        );
        assert.equal(outcome.last?.type, 'done', `[${mode}] submission must complete`);
        assert.ok(compaction.sessionEventId);

        const checkpointA = promotedGenerationA(capture);

        // NEVER dispatch A-rooted messages after B commits.
        const rootB = rootOfDispatch(capture, 1);
        assert.notEqual(
          rootB.installed_lineage?.compaction_event_id ?? null,
          null,
          `[${mode}] dispatch must never root at A (lineage-less) after B commits`,
        );
        assert.notEqual(
          rootB.checkpoint_digest,
          checkpointA.checkpoint_digest,
          `[${mode}] dispatch must never root at the superseded A after B commits`,
        );
        assert.equal(
          rootB.installed_lineage?.compaction_commit_event_id ?? null,
          compaction.sessionEventId,
          `[${mode}] B lineage must name the mid-process commit`,
        );
        const diskB = readCheckpoint(runId);
        assert.ok(diskB);
        assert.equal(
          rootB.checkpoint_digest,
          diskB.checkpoint_digest,
          `[${mode}] dispatch roots at the installed B`,
        );

        const dispatchB = capture.dispatches[1]!;
        assert.equal(countCapsuleMessages(dispatchB.messages), 1, `[${mode}] capsule exactly once`);
        assert.ok(
          countContent(dispatchB.messages, TURN1_TASK) <= 1,
          `[${mode}] no duplicated pre-compaction history (the A-rooted defect)`,
        );
        assert.ok(
          capture.rebuilds.every((entry) => entry.root !== checkpointA),
          `[${mode}] no rebuild in the compacting iteration may consume A once B commits`,
        );
        const wire = wireMessages(provider.bodies, bodiesBefore);
        assert.ok(wire);
        assert.equal(countOccurrences(wire, CAPSULE_MARKER), 1, `[${mode}] wire carries capsule`);
        assert.ok(
          countContent(wire, TURN1_TASK) <= 1,
          `[${mode}] wire must not duplicate pre-compaction history`,
        );
      } finally {
        globalThis.fetch = originalFetch;
        engine?.closeAdmissionStore();
        store.close();
      }
      assert.equal(getOpenAdmissionStoreCount(), 0);
    });
  }
});

// ─── 4. negative control: install fails in a compacting turn ⇒ refuse ─────

test('negative control: install unavailable in a compacting turn fails closed, never a stale dispatch', async () => {
  // (a) Fresh session (no generation in memory): a capsule commits but no
  // checkpoint can install ⇒ dispatch must be refused — not built from the
  // ownership fallback as if nothing were pending.
  await withRunsDir(async () => {
    const runId = 't5-negative-fresh';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const provider: ProviderStubState = { providerCalls: 0, bodies: [] };
    const originalFetch = globalThis.fetch;
    stubProvider(provider);
    let engine: ChatEngine | undefined;
    try {
      const { engine: subject, capture } = capturingEngine(runId, projectRoot, store, {
        runtimeInvariantMode: 'enforce',
      });
      engine = subject;
      const restoreSources = blockP11Install(engine);
      stubMidTurnCompaction(engine, TURN2_TASK, 1);
      const outcome = await submit(engine, TURN2_TASK);
      restoreSources();
      assert.equal(outcome.error, null, `refusal must be a terminal event, not a throw: ${outcome.error}`);
      assert.equal(
        outcome.last?.type,
        'failed',
        'a compacting turn with failed install must fail closed',
      );
      assert.match(
        String(outcome.last?.['error'] ?? ''),
        /P11 context installation was blocked/,
        'the refusal must name the P11 install failure',
      );
      assert.equal(capture.dispatches.length, 0, 'no provider dispatch may happen');
      assert.equal(provider.bodies.length, 0, 'no serialized request may leave the process');
      assert.equal(readCheckpoint(runId), null, 'no checkpoint may install');
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });

  // (b) Generation A in memory, then install fails while B commits
  // mid-process: the turn must refuse — never fall back to dispatching
  // A-rooted messages.
  await withRunsDir(async () => {
    const runId = 't5-negative-stale-a';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const provider: ProviderStubState = { providerCalls: 0, bodies: [] };
    const originalFetch = globalThis.fetch;
    stubProvider(provider);
    let engine: ChatEngine | undefined;
    try {
      const { engine: subject, capture } = capturingEngine(runId, projectRoot, store, {
        runtimeInvariantMode: 'enforce',
      });
      engine = subject;
      capture.control.syntheticToolRound = true;
      // Iteration 1 installs A; iteration 2 commits B and only THEN does the
      // install become unavailable — the exact "stale A + fresh B" window.
      const compaction = stubMidTurnCompaction(engine, TURN2_TASK, 2);
      const restoreSources = blockP11Install(engine, () => compaction.committed);
      const bodiesBefore = provider.bodies.length;
      const outcome = await submit(engine, TURN1_TASK);
      restoreSources();
      assert.equal(outcome.error, null, `refusal must be a terminal event, not a throw: ${outcome.error}`);
      assert.ok(compaction.committed, 'the mid-process capsule must have committed');
      assert.equal(
        outcome.last?.type,
        'failed',
        'a compacting iteration whose install fails must refuse even with A in memory',
      );
      assert.match(String(outcome.last?.['error'] ?? ''), /P11 context installation was blocked/);
      assert.equal(
        capture.dispatches.length,
        1,
        'only iteration 1 (pre-compaction) may have dispatched; stale A must never dispatch after B commits',
      );
      assert.equal(
        provider.bodies.length,
        bodiesBefore,
        'no request may leave the process for the refused iteration (iteration 1 is synthetic)',
      );
      assert.equal(readCheckpoint(runId)?.installed_lineage?.compaction_event_id ?? null, null, 'B must never install');
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });
});
