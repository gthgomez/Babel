/**
 * In-process runtime coordinator — one narrow lifecycle facade over the
 * existing mode controllers.
 *
 * P03. The coordinator:
 *   - selects exactly one mode adapter per turn;
 *   - reuses P02 `PreparedTurn` for preparation;
 *   - enforces one controller owning a turn (stale finalizers cannot release a
 *     successor, mirroring the P01 ownership contract);
 *   - exposes renderer-independent submission so CLI and protocol surfaces can
 *     share it;
 *   - never decides completion, verifies, mutates policy or compiles prompts.
 *
 * Existing kernel, ChatEngine, mode policies, Prompt OS and evidence stores
 * remain authoritative. This module coordinates them.
 */

import { randomUUID } from 'node:crypto';

import type { ChatEvent } from '../agent/chatEngine.js';
import type { BabelMode, SessionDescriptor } from '../executor/contracts.js';
import {
  buildPreparedTurn,
  resolveModeCapability,
  type ModeCapability,
  type PreparedTurn,
} from '../executor/modeAdapters.js';
import {
  RuntimeExecutionSettledError,
  RuntimeModeUnsupportedError,
  RuntimeTurnOwnedError,
  RUNTIME_COORDINATOR_ENV,
  RUNTIME_COORDINATOR_VERSION,
  type RuntimeCoordinator,
  type RuntimeCoordinatorDependencies,
  type RuntimeExecution,
  type RuntimeModeAdapter,
  type RuntimeTurnRequest,
} from './contracts.js';
import {
  createChatRuntimeAdapter,
  createDeepRuntimeAdapter,
  createPlanRuntimeAdapter,
} from './adapters/index.js';

export {
  RUNTIME_COORDINATOR_ENV,
  RUNTIME_COORDINATOR_VERSION,
  RuntimeExecutionSettledError,
  RuntimeModeUnsupportedError,
  RuntimeSubjectUnavailableError,
  RuntimeTurnOwnedError,
} from './contracts.js';

/** Injectable construction options. Adapters/clock/ids are overridable for tests. */
export interface RuntimeCoordinatorOptions {
  /** Mode adapters to register. Defaults to the built-in chat/plan/deep set. */
  adapters?: readonly RuntimeModeAdapter[];
  now?: RuntimeCoordinatorDependencies['now'];
  newId?: RuntimeCoordinatorDependencies['newId'];
  resolveSubject?: RuntimeCoordinatorDependencies['resolveSubject'];
}

interface ActiveOwner {
  generation: number;
  token: string;
}

interface ExecutionRecord {
  execution: RuntimeExecution;
  adapter: RuntimeModeAdapter;
  request: RuntimeTurnRequest;
  submitted: boolean;
}

/**
 * Compatibility switch for the P03 extraction.
 *
 * Default is enabled. Set `BABEL_RUNTIME_COORDINATOR=legacy` (or `0`/`false`/
 * `off`) to route a surface through its pre-P03 direct adapter while traces are
 * compared. This is a temporary seam, not a second runtime.
 */
export function isRuntimeCoordinatorEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RUNTIME_COORDINATOR_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'legacy');
}

function defaultAdapters(): RuntimeModeAdapter[] {
  return [
    createChatRuntimeAdapter(),
    createPlanRuntimeAdapter(),
    createDeepRuntimeAdapter(),
  ];
}

/** Create the shared coordinator. Pure in-memory; no durable state yet (P05 owns that). */
export function createRuntimeCoordinator(
  options: RuntimeCoordinatorOptions = {},
): RuntimeCoordinator {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const resolveSubject = options.resolveSubject;

  const registry = new Map<BabelMode, RuntimeModeAdapter>();
  for (const adapter of options.adapters ?? defaultAdapters()) {
    registry.set(adapter.mode, adapter);
  }

  /** threadId → current owner for keyed turns only. */
  const active = new Map<string, ActiveOwner>();
  /** threadId → monotonic generation counter (never reset). */
  const generations = new Map<string, number>();
  /** token → live execution record. Pruned when the execution settles. */
  const records = new Map<string, ExecutionRecord>();

  function capabilityFor(mode: BabelMode): ModeCapability {
    // Registered adapters carry the authoritative capability; an unknown mode
    // still defers to P02 resolution so callers get an explicit answer.
    return registry.get(mode)?.capability ?? resolveModeCapability(mode);
  }

  function beginTurn(request: RuntimeTurnRequest): RuntimeExecution {
    const mode = request.prepared.mode;
    const adapter = registry.get(mode);
    if (!adapter) {
      throw new RuntimeModeUnsupportedError(mode);
    }
    if (!adapter.capability.submission) {
      throw new RuntimeModeUnsupportedError(mode, adapter.capability.reason);
    }

    const keyed = request.threadId.length > 0;
    if (keyed && active.has(request.threadId)) {
      throw new RuntimeTurnOwnedError(request.threadId);
    }
    const generation = keyed
      ? (generations.get(request.threadId) ?? 0) + 1
      : 1;
    if (keyed) generations.set(request.threadId, generation);

    const token = newId();
    let resolvedRequest = request;
    if (request.subject === undefined && resolveSubject !== undefined) {
      const subject = resolveSubject(request);
      if (subject) resolvedRequest = { ...request, subject };
    }

    const execution: RuntimeExecution = {
      version: RUNTIME_COORDINATOR_VERSION,
      token,
      threadId: request.threadId,
      turnId: request.turnId,
      mode,
      controller: adapter.controller,
      generation,
      startedAt: now().toISOString(),
    };

    records.set(token, {
      execution,
      adapter,
      request: resolvedRequest,
      submitted: false,
    });
    if (keyed) {
      active.set(request.threadId, { generation, token });
    }
    return execution;
  }

  function submit(execution: RuntimeExecution): AsyncIterable<ChatEvent> {
    const record = records.get(execution.token);
    if (!record) {
      throw new RuntimeExecutionSettledError(execution.token, 'unknown or already settled');
    }
    if (record.submitted) {
      throw new RuntimeExecutionSettledError(execution.token, 'already submitted');
    }
    if (execution.threadId.length > 0) {
      const current = active.get(execution.threadId);
      if (!current || current.token !== execution.token) {
        throw new RuntimeTurnOwnedError(execution.threadId);
      }
    }
    record.submitted = true;
    return record.adapter.submit(record.request);
  }

  async function cancel(execution: RuntimeExecution): Promise<void> {
    const record = records.get(execution.token);
    if (!record) return;
    // Cancellation is a request; ownership is released by `settle` so a stale
    // finalizer cannot clear a successor's ownership (P01 contract).
    await record.adapter.cancel(record.request);
  }

  function settle(execution: RuntimeExecution): boolean {
    const record = records.get(execution.token);
    if (!record) return false;
    if (execution.threadId.length === 0) {
      records.delete(execution.token);
      return false;
    }
    const current = active.get(execution.threadId);
    records.delete(execution.token);
    if (!current || current.token !== execution.token) {
      return false;
    }
    active.delete(execution.threadId);
    return true;
  }

  return {
    version: RUNTIME_COORDINATOR_VERSION,
    capabilities: capabilityFor,
    prepare(descriptor: SessionDescriptor): PreparedTurn {
      return buildPreparedTurn(descriptor);
    },
    beginTurn,
    submit,
    cancel,
    settle,
    activeCount: () => active.size,
  };
}
