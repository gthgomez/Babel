import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";

export const TASK_EVENT_SCHEMA_VERSION = 1 as const;
export const TASK_EVENTS_FILENAME = "task-events.jsonl";
export const TASK_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;

export const TASK_EVENT_TYPES = [
  "task.created",
  "contract.created",
  "contract.frozen",
  "plan.created",
  "agent.assigned",
  "execution.started",
  "execution.completed",
  "tool.called",
  "artifact.created",
  "claim.created",
  "verification.started",
  "verification.passed",
  "verification.failed",
  "challenge.created",
  "failure.recorded",
  "task.completed",
  "task.failed",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export interface TaskEventV1 {
  event_version: typeof TASK_EVENT_SCHEMA_VERSION;
  event_id: string;
  task_id: string;
  sequence: number;
  timestamp: string;
  actor: string;
  event_type: TaskEventType;
  payload: Record<string, unknown>;
  payload_hash: string;
  previous_event_hash: string | null;
  event_hash: string;
}

export interface TaskEventJournalState {
  task_id: string;
  events: TaskEventV1[];
}

const SECRET_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE =
  /(?:^|\b)(?:sk|rk)-[A-Za-z0-9_-]{12,}|(?:bearer\s+)[A-Za-z0-9._-]{12,}/i;

function assertSafePayload(
  value: unknown,
  path = "payload",
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key))
      throw new Error(`${path}.${key} is not allowed in task events`);
    if (typeof child === "string" && SECRET_VALUE.test(child)) {
      throw new Error(`${path}.${key} looks like a credential`);
    }
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        child.forEach((item, index) => {
          if (typeof item === "string" && SECRET_VALUE.test(item))
            throw new Error(`${path}.${key}[${index}] looks like a credential`);
          if (item && typeof item === "object")
            assertSafePayload(item, `${path}.${key}[${index}]`);
        });
      } else {
        assertSafePayload(child, `${path}.${key}`);
      }
    }
  }
  const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (bytes > TASK_EVENT_PAYLOAD_MAX_BYTES)
    throw new Error(
      `Task event payload exceeds ${TASK_EVENT_PAYLOAD_MAX_BYTES} bytes`,
    );
}

function hashEvent(value: Omit<TaskEventV1, "event_hash">): string {
  return sha256Canonical(value);
}

function eventWithoutHash(event: TaskEventV1): Omit<TaskEventV1, "event_hash"> {
  const { event_hash: _eventHash, ...withoutHash } = event;
  return withoutHash;
}

function checkEvent(
  event: TaskEventV1,
  previous: TaskEventV1 | undefined,
  expectedTaskId: string,
  expectedSequence: number,
): string[] {
  const errors: string[] = [];
  if (event.event_version !== TASK_EVENT_SCHEMA_VERSION)
    errors.push("event_version");
  if (!event.event_id || !event.task_id || event.task_id !== expectedTaskId)
    errors.push("identity");
  if (event.sequence !== expectedSequence) errors.push("sequence");
  if (!event.timestamp || Number.isNaN(Date.parse(event.timestamp)))
    errors.push("timestamp");
  if (!event.actor || typeof event.actor !== "string") errors.push("actor");
  if (!TASK_EVENT_TYPES.includes(event.event_type)) errors.push("event_type");
  try {
    assertSafePayload(event.payload);
  } catch {
    errors.push("payload");
  }
  if (
    !/^[0-9a-f]{64}$/.test(event.payload_hash) ||
    event.payload_hash !== sha256Canonical(event.payload)
  )
    errors.push("payload_hash");
  const previousHash = previous?.event_hash ?? null;
  if (event.previous_event_hash !== previousHash)
    errors.push("previous_event_hash");
  if (
    !/^[0-9a-f]{64}$/.test(event.event_hash) ||
    event.event_hash !== hashEvent(eventWithoutHash(event))
  )
    errors.push("event_hash");
  return errors;
}

export function validateTaskEventJournal(
  value: TaskEventJournalState,
): string[] {
  const errors: string[] = [];
  if (!value.task_id.trim()) errors.push("task_id");
  const ids = new Set<string>();
  let previous: TaskEventV1 | undefined;
  value.events.forEach((event, index) => {
    if (ids.has(event.event_id))
      errors.push(`events.${index}.event_id_duplicate`);
    ids.add(event.event_id);
    errors.push(
      ...checkEvent(event, previous, value.task_id, index).map(
        (error) => `events.${index}.${error}`,
      ),
    );
    previous = event;
  });
  return errors;
}

export class TaskEventJournal {
  private readonly state: TaskEventJournalState;

  constructor(taskId: string, events: readonly TaskEventV1[] = []) {
    this.state = { task_id: taskId, events: [...events] };
    const errors = validateTaskEventJournal(this.state);
    if (errors.length > 0)
      throw new Error(`Invalid task event journal: ${errors.join(", ")}`);
  }

  get taskId(): string {
    return this.state.task_id;
  }
  get events(): readonly TaskEventV1[] {
    return this.state.events;
  }

  append(input: {
    event_type: TaskEventType;
    actor: string;
    payload?: Record<string, unknown>;
    event_id?: string;
    timestamp?: string;
  }): TaskEventV1 {
    const payload = { ...(input.payload ?? {}) };
    assertSafePayload(payload);
    const withoutHash: Omit<TaskEventV1, "event_hash"> = {
      event_version: TASK_EVENT_SCHEMA_VERSION,
      event_id: input.event_id ?? randomUUID(),
      task_id: this.state.task_id,
      sequence: this.state.events.length,
      timestamp: input.timestamp ?? new Date().toISOString(),
      actor: input.actor,
      event_type: input.event_type,
      payload,
      payload_hash: sha256Canonical(payload),
      previous_event_hash: this.state.events.at(-1)?.event_hash ?? null,
    };
    const event = { ...withoutHash, event_hash: hashEvent(withoutHash) };
    const errors = checkEvent(
      event,
      this.state.events.at(-1),
      this.state.task_id,
      this.state.events.length,
    );
    if (errors.length > 0)
      throw new Error(`Invalid task event: ${errors.join(", ")}`);
    this.state.events.push(event);
    return event;
  }

  serialize(): string {
    const errors = validateTaskEventJournal(this.state);
    if (errors.length > 0)
      throw new Error(`Invalid task event journal: ${errors.join(", ")}`);
    return this.state.events
      .map((event) => `${canonicalJson(event)}\n`)
      .join("");
  }

  save(path: string): void {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(temporaryPath, this.serialize(), "utf8");
      renameSync(temporaryPath, path);
    } finally {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        /* preserve the original I/O error */
      }
    }
  }
}

export function createTaskEventJournal(taskId: string): TaskEventJournal {
  if (!taskId.trim()) throw new Error("Task event journal requires a task_id");
  return new TaskEventJournal(taskId);
}

export function parseTaskEventJournal(
  raw: string,
  expectedTaskId?: string,
): TaskEventJournal {
  const events: TaskEventV1[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid task event JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid task event at line ${index + 1}`);
    events.push(value as TaskEventV1);
  }
  const taskId = expectedTaskId ?? events[0]?.task_id;
  if (!taskId) throw new Error("Task event journal has no task_id");
  return new TaskEventJournal(taskId, events);
}

export function loadTaskEventJournal(
  path: string,
  expectedTaskId?: string,
): TaskEventJournal {
  return parseTaskEventJournal(readFileSync(path, "utf8"), expectedTaskId);
}
