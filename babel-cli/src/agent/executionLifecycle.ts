import * as fs from "node:fs";
import * as path from "node:path";

import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";

export const EXECUTION_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export type ExecutionLifecycleState =
  | "CREATED"
  | "ASSIGNED"
  | "RUNNING"
  | "EVIDENCE_SUBMITTED"
  | "VERIFYING"
  | "REVIEWING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface ExecutionLifecycleSnapshotV1 {
  schema_version: typeof EXECUTION_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  run_id: string;
  contract_hash: string;
  assignment_id: string;
  state: ExecutionLifecycleState;
  revision: number;
  updated_at: string;
  state_hash: string;
}

const transitions: Record<
  ExecutionLifecycleState,
  readonly ExecutionLifecycleState[]
> = {
  CREATED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["RUNNING", "CANCELLED"],
  RUNNING: ["EVIDENCE_SUBMITTED", "FAILED", "BLOCKED", "CANCELLED"],
  EVIDENCE_SUBMITTED: ["VERIFYING", "BLOCKED", "FAILED"],
  VERIFYING: ["REVIEWING", "BLOCKED", "FAILED"],
  REVIEWING: ["COMPLETED", "BLOCKED", "FAILED"],
  BLOCKED: ["RUNNING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

function stateBody(
  snapshot: Omit<ExecutionLifecycleSnapshotV1, "state_hash">,
): Omit<ExecutionLifecycleSnapshotV1, "state_hash"> {
  return snapshot;
}

function hashState(
  snapshot: Omit<ExecutionLifecycleSnapshotV1, "state_hash">,
): string {
  return sha256Canonical(stateBody(snapshot));
}

function assertIdentity(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Lifecycle ${name} is required.`);
}

function freezeSnapshot(
  snapshot: ExecutionLifecycleSnapshotV1,
): ExecutionLifecycleSnapshotV1 {
  return Object.freeze(snapshot);
}

export interface ExecutionLifecycleControllerV1 {
  readonly snapshot: ExecutionLifecycleSnapshotV1;
  transition(
    next: ExecutionLifecycleState,
    updatedAt?: string,
  ): ExecutionLifecycleSnapshotV1;
  serialize(): string;
  save(filePath: string): void;
}

class LifecycleController implements ExecutionLifecycleControllerV1 {
  private current: ExecutionLifecycleSnapshotV1;

  constructor(initial: ExecutionLifecycleSnapshotV1) {
    const { state_hash: _stateHash, ...body } = initial;
    if (initial.state_hash !== hashState(body))
      throw new Error("Lifecycle state hash mismatch.");
    this.current = freezeSnapshot({ ...initial });
  }

  get snapshot(): ExecutionLifecycleSnapshotV1 {
    return freezeSnapshot({ ...this.current });
  }

  transition(
    next: ExecutionLifecycleState,
    updatedAt = new Date().toISOString(),
  ): ExecutionLifecycleSnapshotV1 {
    if (!transitions[this.current.state].includes(next))
      throw new Error(
        `Illegal lifecycle transition: ${this.current.state} -> ${next}`,
      );
    const body: Omit<ExecutionLifecycleSnapshotV1, "state_hash"> = {
      schema_version: this.current.schema_version,
      task_id: this.current.task_id,
      run_id: this.current.run_id,
      contract_hash: this.current.contract_hash,
      assignment_id: this.current.assignment_id,
      state: next,
      revision: this.current.revision + 1,
      updated_at: updatedAt,
    };
    this.current = freezeSnapshot({ ...body, state_hash: hashState(body) });
    return this.snapshot;
  }

  serialize(): string {
    return `${canonicalJson(this.current)}\n`;
  }

  save(filePath: string): void {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(fd, this.serialize(), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, resolved);
  }
}

/** Create a lifecycle controller with a single immutable task/run/contract binding. */
export function createExecutionLifecycleV1(input: {
  task_id: string;
  run_id: string;
  contract_hash: string;
  assignment_id: string;
  updated_at?: string;
}): ExecutionLifecycleControllerV1 {
  assertIdentity(input.task_id, "task_id");
  assertIdentity(input.run_id, "run_id");
  assertIdentity(input.contract_hash, "contract_hash");
  assertIdentity(input.assignment_id, "assignment_id");
  const body: Omit<ExecutionLifecycleSnapshotV1, "state_hash"> = {
    schema_version: EXECUTION_LIFECYCLE_SCHEMA_VERSION,
    task_id: input.task_id,
    run_id: input.run_id,
    contract_hash: input.contract_hash,
    assignment_id: input.assignment_id,
    state: "CREATED",
    revision: 0,
    updated_at: input.updated_at ?? new Date().toISOString(),
  };
  return new LifecycleController({ ...body, state_hash: hashState(body) });
}

/** Reload a lifecycle snapshot and reject corruption, rollback, or wrong bindings. */
export function loadExecutionLifecycleV1(
  filePath: string,
  expected?: Partial<
    Pick<
      ExecutionLifecycleSnapshotV1,
      "task_id" | "run_id" | "contract_hash" | "assignment_id"
    >
  >,
): ExecutionLifecycleControllerV1 {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(
      `Lifecycle state cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Lifecycle state must be an object.");
  const snapshot = value as ExecutionLifecycleSnapshotV1;
  if (
    snapshot.schema_version !== EXECUTION_LIFECYCLE_SCHEMA_VERSION ||
    !transitions[snapshot.state]
  )
    throw new Error("Lifecycle state schema invalid.");
  for (const key of [
    "task_id",
    "run_id",
    "contract_hash",
    "assignment_id",
  ] as const) {
    assertIdentity(snapshot[key], key);
    if (expected?.[key] !== undefined && snapshot[key] !== expected[key])
      throw new Error(`Lifecycle state ${key} binding mismatch.`);
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0)
    throw new Error("Lifecycle revision invalid.");
  const { state_hash: _stateHash, ...body } = snapshot;
  if (
    typeof snapshot.state_hash !== "string" ||
    snapshot.state_hash !== hashState(body)
  )
    throw new Error("Lifecycle state is tampered.");
  return new LifecycleController(snapshot);
}
