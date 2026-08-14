/**
 * Durable versioned event log and exact resume.
 *
 * Persist all agent events with thread_id, turn_id, item_id, and tool_call_id.
 * Resume rebuilds ProviderMessage[] from typed events + compaction capsules
 * so no tool result is dropped and tools are not re-executed for lost history.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderMessage, ProviderToolCall } from '../runners/base.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

export const THREAD_EVENT_LOG_VERSION = 1 as const;

/** A present-but-invalid durable log must never be downgraded to legacy resume. */
export class ThreadEventLogRestoreError extends Error {
  readonly code = 'THREAD_EVENT_LOG_INVALID' as const;

  constructor(path: string, cause: unknown) {
    super(`Cannot restore thread event log at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ThreadEventLogRestoreError';
  }
}

export type ThreadEventKind =
  | 'turn_started'
  | 'user_message'
  | 'assistant_message'
  | 'assistant_tool_calls'
  | 'tool_result'
  | 'compaction_capsule'
  | 'policy_decision'
  | 'approval'
  | 'progress'
  | 'turn_ended'
  | 'repo_identity';

export interface ThreadEventBase {
  schema_version: typeof THREAD_EVENT_LOG_VERSION;
  event_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  seq: number;
  ts: string;
  kind: ThreadEventKind;
}

export type ThreadEvent =
  | (ThreadEventBase & {
      kind: 'turn_started';
      task: string;
      model: string;
      provider: string;
      projectRoot: string;
      policyPreset: string;
      verifier?: string;
      /** P0-C: effective chat task class for this submission (budgets / gates). */
      taskClass?: string;
      /** P0-C: verification policy for this submission. */
      gatePolicy?: string;
      /** P0-C: submission index within the thread. */
      submissionIndex?: number;
      /** P0-C: whether counters continued from prior task. */
      continuedTask?: boolean;
    })
  | (ThreadEventBase & { kind: 'user_message'; content: string })
  | (ThreadEventBase & { kind: 'assistant_message'; content: string })
  | (ThreadEventBase & {
      kind: 'assistant_tool_calls';
      content: string;
      tool_calls: ProviderToolCall[];
    })
  | (ThreadEventBase & {
      kind: 'tool_result';
      tool_call_id: string;
      tool_name: string;
      content: string;
      exit_code?: number;
    })
  | (ThreadEventBase & {
      kind: 'compaction_capsule';
      content: string;
      preserved_tool_call_ids: string[];
    })
  | (ThreadEventBase & {
      kind: 'policy_decision';
      source: string;
      action: string;
      message: string;
    })
  | (ThreadEventBase & {
      kind: 'approval';
      request_id: string;
      decision: 'deny' | 'allow_once' | 'allow_session' | 'narrow_rule';
      scope?: string;
    })
  | (ThreadEventBase & {
      kind: 'progress';
      hasDelta: boolean;
      deltas: string[];
    })
  | (ThreadEventBase & {
      kind: 'turn_ended';
      outcome: TerminalOutcome;
      status: string;
    })
  | (ThreadEventBase & {
      kind: 'repo_identity';
      projectRoot: string;
      gitHead?: string;
    });

export interface TurnSnapshot {
  turn_id: string;
  model: string;
  provider: string;
  projectRoot: string;
  policyPreset: string;
  verifier?: string;
  outcome?: TerminalOutcome;
  approvals: string[];
}

export interface ThreadEventLog {
  schema_version: typeof THREAD_EVENT_LOG_VERSION;
  thread_id: string;
  events: ThreadEvent[];
  nextSeq: number;
}

export function createThreadEventLog(threadId?: string): ThreadEventLog {
  return {
    schema_version: THREAD_EVENT_LOG_VERSION,
    thread_id: threadId ?? randomUUID(),
    events: [],
    nextSeq: 0,
  };
}

function baseFields(
  log: ThreadEventLog,
  turnId: string,
  kind: ThreadEventKind,
): ThreadEventBase {
  const seq = log.nextSeq++;
  return {
    schema_version: THREAD_EVENT_LOG_VERSION,
    event_id: randomUUID(),
    thread_id: log.thread_id,
    turn_id: turnId,
    item_id: `${turnId}:${seq}`,
    seq,
    ts: new Date().toISOString(),
    kind,
  };
}

/**
 * Payload for append — callers pass kind-specific fields + turn_id.
 * (Discriminated-union Omit collapses poorly under exactOptionalPropertyTypes.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appendThreadEvent(
  log: ThreadEventLog,
  event: { turn_id: string; kind: ThreadEventKind } & Record<string, unknown>,
): ThreadEvent {
  const base = baseFields(log, event.turn_id, event.kind);
  const full = { ...event, ...base, kind: event.kind } as ThreadEvent;
  log.events.push(full);
  return full;
}

export function startTurn(
  log: ThreadEventLog,
  input: {
    task: string;
    model: string;
    provider: string;
    projectRoot: string;
    policyPreset: string;
    verifier?: string;
    taskClass?: string;
    gatePolicy?: string;
    submissionIndex?: number;
    continuedTask?: boolean;
  },
): string {
  const turnId = randomUUID();
  appendThreadEvent(log, {
    kind: 'turn_started',
    turn_id: turnId,
    task: input.task,
    model: input.model,
    provider: input.provider,
    projectRoot: input.projectRoot,
    policyPreset: input.policyPreset,
    ...(input.verifier !== undefined ? { verifier: input.verifier } : {}),
    ...(input.taskClass !== undefined ? { taskClass: input.taskClass } : {}),
    ...(input.gatePolicy !== undefined ? { gatePolicy: input.gatePolicy } : {}),
    ...(input.submissionIndex !== undefined ? { submissionIndex: input.submissionIndex } : {}),
    ...(input.continuedTask !== undefined ? { continuedTask: input.continuedTask } : {}),
  });
  appendThreadEvent(log, {
    kind: 'repo_identity',
    turn_id: turnId,
    projectRoot: input.projectRoot,
  });
  appendThreadEvent(log, {
    kind: 'user_message',
    turn_id: turnId,
    content: input.task,
  });
  return turnId;
}

export function endTurn(
  log: ThreadEventLog,
  turnId: string,
  outcome: TerminalOutcome,
  status: string,
): void {
  appendThreadEvent(log, {
    kind: 'turn_ended',
    turn_id: turnId,
    outcome,
    status,
  });
}

export function recordAssistantToolCalls(
  log: ThreadEventLog,
  turnId: string,
  content: string,
  toolCalls: ProviderToolCall[],
): void {
  appendThreadEvent(log, {
    kind: 'assistant_tool_calls',
    turn_id: turnId,
    content,
    tool_calls: toolCalls,
  });
}

export function recordAssistantMessage(
  log: ThreadEventLog,
  turnId: string,
  content: string,
): void {
  appendThreadEvent(log, {
    kind: 'assistant_message',
    turn_id: turnId,
    content,
  });
}

export function recordToolResult(
  log: ThreadEventLog,
  turnId: string,
  input: {
    tool_call_id: string;
    tool_name: string;
    content: string;
    exit_code?: number;
  },
): void {
  appendThreadEvent(log, {
    kind: 'tool_result',
    turn_id: turnId,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    content: input.content,
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
  });
}

/**
 * Rebuild provider-neutral messages from the durable event log.
 * Compaction capsules replace prior history when present (after the capsule).
 */
export function rebuildProviderMessagesFromEvents(
  log: ThreadEventLog,
  options: { systemPrompt?: string; upToSeq?: number } = {},
): ProviderMessage[] {
  const events =
    options.upToSeq === undefined
      ? log.events
      : log.events.filter((e) => e.seq <= options.upToSeq!);

  // Find last compaction capsule — history before it is replaced by capsule content.
  let startIdx = 0;
  let capsuleContent: string | null = null;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.kind === 'compaction_capsule') {
      startIdx = i + 1;
      capsuleContent = (events[i] as Extract<ThreadEvent, { kind: 'compaction_capsule' }>)
        .content;
    }
  }

  const messages: ProviderMessage[] = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  if (capsuleContent) {
    messages.push({
      role: 'system',
      content: capsuleContent,
      name: 'compaction_capsule',
    });
  }

  for (let i = startIdx; i < events.length; i++) {
    const e = events[i]!;
    switch (e.kind) {
      case 'user_message':
        messages.push({ role: 'user', content: e.content });
        break;
      case 'assistant_message':
        messages.push({ role: 'assistant', content: e.content });
        break;
      case 'assistant_tool_calls': {
        const msg: ProviderMessage = {
          role: 'assistant',
          content: e.content || 'Using tools…',
          name: 'tool_calls',
        };
        if (e.tool_calls.length > 0) msg.tool_calls = e.tool_calls;
        messages.push(msg);
        break;
      }
      case 'tool_result':
        messages.push({
          role: 'tool',
          content: e.content,
          tool_call_id: e.tool_call_id,
          name: e.tool_name,
        });
        break;
      default:
        break;
    }
  }

  return messages;
}

/**
 * Validate repository identity on resume. Returns ok or a required ask reason.
 */
export function validateRepoIdentityOnResume(
  log: ThreadEventLog,
  currentRoot: string,
): { ok: true } | { ok: false; reason: string; savedRoot: string } {
  const last = [...log.events]
    .reverse()
    .find((e) => e.kind === 'repo_identity' || e.kind === 'turn_started');
  if (!last) return { ok: true };
  const savedRoot =
    last.kind === 'repo_identity'
      ? last.projectRoot
      : last.kind === 'turn_started'
        ? last.projectRoot
        : currentRoot;
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (normalize(savedRoot) !== normalize(currentRoot)) {
    return {
      ok: false,
      reason: 'Repository root changed since last turn; confirm before resume',
      savedRoot,
    };
  }
  return { ok: true };
}

export function latestTurnSnapshot(log: ThreadEventLog): TurnSnapshot | null {
  const started = [...log.events]
    .reverse()
    .find((e): e is Extract<ThreadEvent, { kind: 'turn_started' }> => e.kind === 'turn_started');
  if (!started) return null;
  const ended = log.events.find(
    (e): e is Extract<ThreadEvent, { kind: 'turn_ended' }> =>
      e.kind === 'turn_ended' && e.turn_id === started.turn_id,
  );
  const approvals = log.events
    .filter(
      (e): e is Extract<ThreadEvent, { kind: 'approval' }> =>
        e.kind === 'approval' && e.turn_id === started.turn_id,
    )
    .map((e) => e.decision);
  return {
    turn_id: started.turn_id,
    model: started.model,
    provider: started.provider,
    projectRoot: started.projectRoot,
    policyPreset: started.policyPreset,
    ...(started.verifier !== undefined ? { verifier: started.verifier } : {}),
    ...(ended ? { outcome: ended.outcome } : {}),
    approvals,
  };
}

/** Canonical filename under chat session dir. */
export const THREAD_EVENT_LOG_FILENAME = 'thread_events.json';

/** Serialize for persistence (JSON-friendly). */
export function serializeThreadEventLog(log: ThreadEventLog): string {
  return JSON.stringify(
    {
      schema_version: log.schema_version,
      thread_id: log.thread_id,
      events: log.events,
      nextSeq: log.nextSeq,
    },
    null,
    2,
  );
}

export function parseThreadEventLog(raw: string): ThreadEventLog {
  const data = JSON.parse(raw) as unknown;
  assertThreadEventLog(data);
  return data;
}

/** Fail closed before a persisted transcript can rebuild model-visible context. */
function assertThreadEventLog(data: unknown): asserts data is ThreadEventLog {
  const log = requireRecord(data, 'Thread event log');
  if (log['schema_version'] !== THREAD_EVENT_LOG_VERSION) {
    throw new Error(
      `Unsupported thread event log version: ${String(log['schema_version'])} (expected ${THREAD_EVENT_LOG_VERSION})`,
    );
  }
  const threadId = requireNonEmptyString(log, 'thread_id', 'Thread event log');
  if (!Array.isArray(log['events'])) throw new Error('Thread event log events must be an array');
  const events = log['events'];
  if (!Number.isInteger(log['nextSeq']) || log['nextSeq'] !== events.length) {
    throw new Error('Thread event log nextSeq must equal the next contiguous sequence');
  }

  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = requireRecord(events[index], `Thread event ${index}`);
    if (event['schema_version'] !== THREAD_EVENT_LOG_VERSION) {
      throw new Error(`Thread event ${index} has an unsupported schema version`);
    }
    const eventId = requireNonEmptyString(event, 'event_id', `Thread event ${index}`);
    if (eventIds.has(eventId)) throw new Error(`Thread event ${index} duplicates event_id`);
    eventIds.add(eventId);
    if (requireNonEmptyString(event, 'thread_id', `Thread event ${index}`) !== threadId) {
      throw new Error(`Thread event ${index} has inconsistent thread_id`);
    }
    const turnId = requireNonEmptyString(event, 'turn_id', `Thread event ${index}`);
    if (requireNonEmptyString(event, 'item_id', `Thread event ${index}`) !== `${turnId}:${index}`) {
      throw new Error(`Thread event ${index} has inconsistent item_id`);
    }
    if (event['seq'] !== index) throw new Error(`Thread event ${index} sequence is not contiguous`);
    const timestamp = requireNonEmptyString(event, 'ts', `Thread event ${index}`);
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Thread event ${index} has invalid timestamp`);
    const kind = requireNonEmptyString(event, 'kind', `Thread event ${index}`);
    assertThreadEventPayload(event, kind, index);
  }
}

function assertThreadEventPayload(event: Record<string, unknown>, kind: string, index: number): void {
  const context = `Thread event ${index}`;
  switch (kind) {
    case 'turn_started':
      for (const key of ['task', 'model', 'provider', 'projectRoot', 'policyPreset']) {
        requireString(event, key, context);
      }
      for (const key of ['verifier', 'taskClass', 'gatePolicy']) requireOptionalString(event, key, context);
      requireOptionalInteger(event, 'submissionIndex', context);
      requireOptionalBoolean(event, 'continuedTask', context);
      return;
    case 'user_message':
    case 'assistant_message':
      requireString(event, 'content', context);
      return;
    case 'assistant_tool_calls':
      requireString(event, 'content', context);
      if (!Array.isArray(event['tool_calls'])) throw new Error(`${context} tool_calls must be an array`);
      event['tool_calls'].forEach((rawCall, callIndex) => {
        const call = requireRecord(rawCall, `${context} tool_call ${callIndex}`);
        requireNonEmptyString(call, 'id', `${context} tool_call ${callIndex}`);
        if (call['type'] !== 'function') throw new Error(`${context} tool_call ${callIndex} has invalid type`);
        const fn = requireRecord(call['function'], `${context} tool_call ${callIndex} function`);
        requireNonEmptyString(fn, 'name', `${context} tool_call ${callIndex} function`);
        requireString(fn, 'arguments', `${context} tool_call ${callIndex} function`);
      });
      return;
    case 'tool_result':
      for (const key of ['tool_call_id', 'tool_name', 'content']) requireString(event, key, context);
      requireOptionalFiniteNumber(event, 'exit_code', context);
      return;
    case 'compaction_capsule':
      requireString(event, 'content', context);
      if (!Array.isArray(event['preserved_tool_call_ids']) || !event['preserved_tool_call_ids'].every((id) => typeof id === 'string')) {
        throw new Error(`${context} preserved_tool_call_ids must be a string array`);
      }
      return;
    case 'policy_decision':
      for (const key of ['source', 'action', 'message']) requireString(event, key, context);
      return;
    case 'approval':
      requireString(event, 'request_id', context);
      if (!['deny', 'allow_once', 'allow_session', 'narrow_rule'].includes(String(event['decision']))) {
        throw new Error(`${context} has invalid approval decision`);
      }
      requireOptionalString(event, 'scope', context);
      return;
    case 'progress':
      if (typeof event['hasDelta'] !== 'boolean' || !Array.isArray(event['deltas']) || !event['deltas'].every((delta) => typeof delta === 'string')) {
        throw new Error(`${context} has invalid progress payload`);
      }
      return;
    case 'turn_ended':
      if (typeof event['outcome'] !== 'string' || !TERMINAL_OUTCOMES.has(event['outcome'] as TerminalOutcome)) {
        throw new Error(`${context} has invalid terminal outcome`);
      }
      requireString(event, 'status', context);
      return;
    case 'repo_identity':
      requireString(event, 'projectRoot', context);
      requireOptionalString(event, 'gitHead', context);
      return;
    default:
      throw new Error(`${context} has unknown kind ${kind}`);
  }
}

const TERMINAL_OUTCOMES = new Set<TerminalOutcome>([
  'VERIFIED_COMPLETE', 'UNVERIFIED_PATCH', 'BLOCKED_EXTERNAL', 'BLOCKED_POLICY',
  'BUDGET_EXHAUSTED', 'CANCELLED', 'INFRA_FAILURE', 'AGENT_FAILURE',
  'NO_CHANGE_REQUIRED', 'INVALID_TASK', 'NEEDS_HUMAN_DECISION',
]);

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  if (typeof record[key] !== 'string') throw new Error(`${context} ${key} must be a string`);
  return record[key] as string;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, context: string): string {
  const value = requireString(record, key, context);
  if (!value) throw new Error(`${context} ${key} must be nonempty`);
  return value;
}

function requireOptionalString(record: Record<string, unknown>, key: string, context: string): void {
  if (record[key] !== undefined) requireString(record, key, context);
}

function requireOptionalInteger(record: Record<string, unknown>, key: string, context: string): void {
  if (record[key] !== undefined && !Number.isInteger(record[key])) throw new Error(`${context} ${key} must be an integer`);
}

function requireOptionalBoolean(record: Record<string, unknown>, key: string, context: string): void {
  if (record[key] !== undefined && typeof record[key] !== 'boolean') throw new Error(`${context} ${key} must be a boolean`);
}

function requireOptionalFiniteNumber(record: Record<string, unknown>, key: string, context: string): void {
  if (record[key] !== undefined && (typeof record[key] !== 'number' || !Number.isFinite(record[key]))) {
    throw new Error(`${context} ${key} must be a finite number`);
  }
}

/** Persist event log next to transcript for kill/restart resume. */
export async function persistThreadEventLog(
  runDir: string,
  log: ThreadEventLog,
): Promise<string> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, THREAD_EVENT_LOG_FILENAME);
  await writeFile(path, serializeThreadEventLog(log), 'utf-8');
  return path;
}

/** Load a persisted event log; null only when it is genuinely absent. */
export function loadThreadEventLogFromDir(runDir: string): ThreadEventLog | null {
  const path = join(runDir, THREAD_EVENT_LOG_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return parseThreadEventLog(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new ThreadEventLogRestoreError(path, error);
  }
}

/** Stable hash of event ids for migration / integrity checks. */
export function eventLogIntegrityHash(log: ThreadEventLog): string {
  const h = createHash('sha256');
  for (const e of log.events) {
    h.update(e.event_id);
    h.update(e.kind);
    h.update(String(e.seq));
  }
  return h.digest('hex').slice(0, 16);
}
