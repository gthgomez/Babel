/**
 * Durable versioned event log and exact resume.
 *
 * Persist all agent events with thread_id, turn_id, item_id, and tool_call_id.
 * Resume rebuilds ProviderMessage[] from typed events + compaction capsules
 * so no tool result is dropped and tools are not re-executed for lost history.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProviderMessage, ProviderToolCall } from '../runners/base.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';
import { writeCheckpointFileSync } from '../utils/atomicCheckpointFile.js';

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
  | 'compaction_summary'
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
  | (ThreadEventBase & {
      kind: 'assistant_message';
      content: string;
      name?: string;
      provenance?: 'controller' | 'model' | 'mixed';
      authoritative?: boolean;
    })
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
      kind: 'compaction_summary';
      content: string;
      provenance: 'model';
      authoritative: false;
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
      /** Omitted when the cause is not established. */
      outcome?: TerminalOutcome;
      status: string;
      /** D03: structured terminal reason survives thread-log persistence/replay. */
      reason_code?: string;
      cause_class?: string | null;
    })
  | (ThreadEventBase & {
      kind: 'repo_identity';
      projectRoot: string;
      gitHead?: string;
      /**
       * R0-4: advisory filesystem fingerprint of the repository root directory,
       * when the platform exposes one. A DIFFERENCE is strong evidence of a
       * different directory and fails closed; a MATCH is not proof of the same
       * physical repository, because filesystems may reuse an inode after a
       * delete/recreate. The authoritative claim remains canonical-root
       * continuity, not physical identity.
       */
      rootDevice?: number;
      rootInode?: number;
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
  const rootFingerprint = repoRootFingerprint(input.projectRoot);
  appendThreadEvent(log, {
    kind: 'repo_identity',
    turn_id: turnId,
    projectRoot: input.projectRoot,
    ...(rootFingerprint !== null
      ? { rootDevice: rootFingerprint.device, rootInode: rootFingerprint.inode }
      : {}),
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
  outcome: TerminalOutcome | undefined,
  status: string,
  reason?: { code: string; cause_class: string | null },
): void {
  appendThreadEvent(log, {
    kind: 'turn_ended',
    turn_id: turnId,
    ...(outcome !== undefined ? { outcome } : {}),
    status,
    ...(reason !== undefined
      ? { reason_code: reason.code, cause_class: reason.cause_class }
      : {}),
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

export function recordUserMessage(
  log: ThreadEventLog,
  turnId: string,
  content: string,
): void {
  appendThreadEvent(log, {
    kind: 'user_message',
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
 * Compaction capsules replace prior history when present (after the capsule),
 * while complete retained tool cycles that were not re-appended after the
 * capsule are projected from their original durable identities.
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
  let summaryContent: string | null = null;
  let lastCapsuleEvent: Extract<ThreadEvent, { kind: 'compaction_capsule' }> | null = null;
  let lastCapsuleIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.kind === 'compaction_capsule') {
      startIdx = i + 1;
      lastCapsuleIdx = i;
      lastCapsuleEvent = events[i] as Extract<ThreadEvent, { kind: 'compaction_capsule' }>;
      capsuleContent = lastCapsuleEvent.content;
    }
  }

  // New logs carry the summary as a sibling advisory event. Legacy logs may
  // contain the old combined marker; split it into assistant context so old
  // model text is never re-promoted to system authority on resume.
  const summaryEvent = events
    .slice(lastCapsuleIdx + 1)
    .find((event): event is Extract<ThreadEvent, { kind: 'compaction_summary' }> => event.kind === 'compaction_summary');
  if (summaryEvent) {
    summaryContent = summaryEvent.content;
  } else if (capsuleContent?.includes('\n\n--- compaction_summary ---\n')) {
    const marker = '\n\n--- compaction_summary ---\n';
    const splitAt = capsuleContent.indexOf(marker);
    summaryContent = capsuleContent.slice(splitAt + marker.length);
    capsuleContent = capsuleContent.slice(0, splitAt);
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
      provenance: 'controller',
      authoritative: true,
    });
  }
  if (summaryContent) {
    messages.push({
      role: 'assistant',
      content: summaryContent,
      name: 'compaction_summary',
      provenance: 'model',
      authoritative: false,
    });
  }

  // Legacy logs may record preserved_tool_call_ids without re-appending the
  // kept cycles after the capsule. Project those cycles from before the
  // capsule using each assistant's own tool_calls — never the remaining suffix.
  if (lastCapsuleEvent && lastCapsuleIdx >= 0) {
    const postCapsuleToolIds = new Set<string>();
    for (let i = startIdx; i < events.length; i++) {
      const event = events[i]!;
      if (event.kind === 'tool_result' && event.tool_call_id) {
        postCapsuleToolIds.add(event.tool_call_id);
      }
    }
    const missingPreservedIds = new Set(
      (lastCapsuleEvent.preserved_tool_call_ids ?? []).filter((id) => !postCapsuleToolIds.has(id)),
    );
    if (missingPreservedIds.size > 0) {
      const preCapsuleEvents = events.slice(0, lastCapsuleIdx);
      for (const event of preCapsuleEvents) {
        if (event.kind === 'assistant_tool_calls') {
          const matchingCalls = event.tool_calls.filter((call) => missingPreservedIds.has(call.id));
          if (matchingCalls.length > 0) {
            messages.push({
              role: 'assistant',
              content: event.content || 'Using tools…',
              name: 'tool_calls',
              tool_calls: matchingCalls,
            });
          }
        } else if (event.kind === 'tool_result' && missingPreservedIds.has(event.tool_call_id)) {
          messages.push({
            role: 'tool',
            content: event.content,
            tool_call_id: event.tool_call_id,
            name: event.tool_name,
          });
        }
      }
    }
  }

  for (let i = startIdx; i < events.length; i++) {
    const e = events[i]!;
    switch (e.kind) {
      case 'user_message':
        messages.push({ role: 'user', content: e.content });
        break;
      case 'assistant_message':
        messages.push({
          role: 'assistant',
          content: e.content,
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.provenance !== undefined ? { provenance: e.provenance } : {}),
          ...(e.authoritative !== undefined ? { authoritative: e.authoritative } : {}),
        });
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

/** Windows filesystems are case-insensitive; POSIX is (normally) case-sensitive. */
const CASE_INSENSITIVE_FS = process.platform === 'win32';

/**
 * Physical identity of a repository root, or `null` when it cannot be
 * established (missing, dangling symlink, permission error, race).
 */
function physicalRootIdentity(path: string): string | null {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return null;
  try {
    const real = realpathSync(resolved);
    return CASE_INSENSITIVE_FS ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/**
 * R0-4: filesystem fingerprint of the repository root directory.
 *
 * Returns `dev`/`ino` of the resolved root when the platform exposes a stable
 * value. Windows and some network filesystems report inode 0 / unstable values;
 * those return null so the caller falls back to canonical-path continuity
 * rather than claiming a stronger proof than it has.
 */
export function repoRootFingerprint(
  path: string,
): { device: number; inode: number } | null {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return null;
  try {
    const real = realpathSync(resolved);
    const stat = statSync(real);
    if (CASE_INSENSITIVE_FS) return null;
    if (!Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.ino === 0) {
      return null;
    }
    return { device: stat.dev, inode: stat.ino };
  } catch {
    return null;
  }
}

/**
 * D04 resume-identity outcome.
 *
 * - `verified`: the saved and current roots resolve to the same canonical root
 *   (and, when a durable filesystem fingerprint exists, it matches). This is
 *   canonical-root CONTINUITY, not proof of the same physical repository — an
 *   inode can be reused after a delete/recreate.
 * - `mismatch`: a durable identity exists and provably points at a different
 *   repository (or only one side resolves); callers must fail closed.
 * - `unknown`: no durable identity was recorded, or neither root could be
 *   resolved physically. Identity is NOT proven — never treat as verified.
 */
export type RepoIdentityResumeResult =
  | { ok: true; status: 'verified' }
  | { ok: false; status: 'mismatch'; reason: string; savedRoot: string }
  | { ok: false; status: 'unknown'; reason: string; savedRoot: string | null };

const IDENTITY_UNPROVEN_REASON =
  'No durable repository identity was recorded for this session; physical repository identity is unproven and resume requires confirmation';
const IDENTITY_CHANGED_REASON = 'Repository root changed since last turn; confirm before resume';
const IDENTITY_UNRESOLVABLE_REASON =
  'Repository root changed or could not be verified since last turn; physical identity cannot be established, so identity is not claimed (confirm before resume)';
const IDENTITY_REPLACED_REASON =
  'The repository at the recorded root appears to have been replaced since last turn (filesystem identity changed); confirm before resume';

/** Last durable repository root recorded in the thread event log, or null. */
export function resolveSavedRepoRootFromLog(log: ThreadEventLog | null): string | null {
  if (!log) return null;
  const last = [...log.events]
    .reverse()
    .find(
      (e): e is Extract<ThreadEvent, { kind: 'repo_identity' | 'turn_started' }> =>
        e.kind === 'repo_identity' || e.kind === 'turn_started',
    );
  return last ? last.projectRoot : null;
}

/**
 * Physical-identity check for a saved root against the current root.
 *
 * D04: compare physical identity, not case-folded strings. Two distinct
 * case-sensitive directories (`.../Repo` vs `.../repo`) are different
 * repositories. A saved root that cannot be established is never assumed
 * equal: one-sided resolution fails closed as a mismatch, and two-sided
 * non-resolution returns `unknown` rather than falling back to lexical
 * equality (which would falsely claim physical identity).
 */
export function resolveRepoIdentityOnResume(
  savedRoot: string | null,
  currentRoot: string,
  savedFingerprint: { device?: number; inode?: number } | null = null,
): RepoIdentityResumeResult {
  if (savedRoot === null) {
    return { ok: false, status: 'unknown', reason: IDENTITY_UNPROVEN_REASON, savedRoot: null };
  }
  const savedIdentity = physicalRootIdentity(savedRoot);
  const currentIdentity = physicalRootIdentity(currentRoot);
  if (savedIdentity !== null && currentIdentity !== null) {
    if (savedIdentity !== currentIdentity) {
      return {
        ok: false,
        status: 'mismatch',
        reason: IDENTITY_CHANGED_REASON,
        savedRoot,
      };
    }
    // R0-4: the canonical path matches. When a durable filesystem fingerprint
    // was recorded, a DIFFERENCE fails closed (a different directory). A match
    // is only advisory: an inode can be reused after delete/recreate, so the
    // `verified` status here means canonical-root continuity, NOT proven
    // physical-repository identity.
    if (
      savedFingerprint &&
      (savedFingerprint.device !== undefined || savedFingerprint.inode !== undefined)
    ) {
      const currentFingerprint = repoRootFingerprint(currentRoot);
      if (currentFingerprint === null) {
        return {
          ok: false,
          status: 'unknown',
          reason: IDENTITY_UNRESOLVABLE_REASON,
          savedRoot,
        };
      }
      if (
        currentFingerprint.device !== savedFingerprint.device ||
        currentFingerprint.inode !== savedFingerprint.inode
      ) {
        return {
          ok: false,
          status: 'mismatch',
          reason: IDENTITY_REPLACED_REASON,
          savedRoot,
        };
      }
    }
    return { ok: true, status: 'verified' };
  }
  if (savedIdentity === null && currentIdentity === null) {
    return {
      ok: false,
      status: 'unknown',
      reason: IDENTITY_UNRESOLVABLE_REASON,
      savedRoot,
    };
  }
  // Exactly one side resolved: identity cannot be established -> fail closed.
  return {
    ok: false,
    status: 'mismatch',
    reason: IDENTITY_CHANGED_REASON,
    savedRoot,
  };
}

/**
 * Validate repository identity on resume. The saved root is read from the
 * durable thread event log, falling back to a caller-supplied root (e.g.
 * `session-events.jsonl` `user_submitted.project_root`) for cells-only or
 * legacy transcript sessions whose event log is absent.
 */
export function validateRepoIdentityOnResume(
  log: ThreadEventLog | null,
  currentRoot: string,
  fallbackSavedRoot: string | null = null,
): RepoIdentityResumeResult {
  const savedRoot = resolveSavedRepoRootFromLog(log) ?? fallbackSavedRoot;
  return resolveRepoIdentityOnResume(savedRoot, currentRoot, resolveSavedRepoFingerprintFromLog(log));
}

/**
 * R0-4: last durable filesystem fingerprint recorded in the thread event log,
 * or null when none was recorded (legacy session / platform without one).
 */
export function resolveSavedRepoFingerprintFromLog(
  log: ThreadEventLog | null,
): { device?: number; inode?: number } | null {
  if (!log) return null;
  const last = [...log.events]
    .reverse()
    .find(
      (e): e is Extract<ThreadEvent, { kind: 'repo_identity' }> =>
        e.kind === 'repo_identity',
    );
  if (!last) return null;
  if (last.rootDevice === undefined && last.rootInode === undefined) return null;
  return {
    ...(last.rootDevice !== undefined ? { device: last.rootDevice } : {}),
    ...(last.rootInode !== undefined ? { inode: last.rootInode } : {}),
  };
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
      requireOptionalString(event, 'name', context);
      requireOptionalString(event, 'provenance', context);
      requireOptionalBoolean(event, 'authoritative', context);
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
    case 'compaction_summary':
      requireString(event, 'content', context);
      if (event['provenance'] !== 'model' || event['authoritative'] !== false) {
        throw new Error(`${context} model summary must remain non-authoritative`);
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
      if (event['outcome'] !== undefined) {
        if (typeof event['outcome'] !== 'string' || !TERMINAL_OUTCOMES.has(event['outcome'] as TerminalOutcome)) {
          throw new Error(`${context} has invalid terminal outcome`);
        }
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
  const path = join(runDir, THREAD_EVENT_LOG_FILENAME);
  // Complete before returning the Promise: strict multi-artifact checkpoints
  // must never race an outstanding async writer holding this primary open.
  writeCheckpointFileSync(path, serializeThreadEventLog(log));
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
