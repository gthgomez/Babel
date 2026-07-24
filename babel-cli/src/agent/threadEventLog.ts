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
  const data = JSON.parse(raw) as ThreadEventLog;
  if (data.schema_version !== THREAD_EVENT_LOG_VERSION) {
    throw new Error(
      `Unsupported thread event log version: ${String(data.schema_version)} (expected ${THREAD_EVENT_LOG_VERSION})`,
    );
  }
  return {
    schema_version: THREAD_EVENT_LOG_VERSION,
    thread_id: data.thread_id,
    events: data.events ?? [],
    nextSeq: data.nextSeq ?? (data.events?.length ?? 0),
  };
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

/** Load persisted event log if present; null when missing/corrupt. */
export function loadThreadEventLogFromDir(runDir: string): ThreadEventLog | null {
  try {
    const path = join(runDir, THREAD_EVENT_LOG_FILENAME);
    if (!existsSync(path)) return null;
    return parseThreadEventLog(readFileSync(path, 'utf-8'));
  } catch {
    return null;
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
