/**
 * Small runtime invariant registry for high-value controller assertions.
 *
 * It deliberately owns no lifecycle or persistence: controllers provide the
 * authoritative inputs and decide where a violation is surfaced.  Shadow
 * mode keeps production diagnostics content-free while development and CI can
 * fail at the actual boundary being protected.
 */

import { createHash } from 'node:crypto';
import type { ProviderToolCall } from '../runners/base.js';

export type RuntimeInvariantMode = 'enforce' | 'shadow' | 'off';

export interface RuntimeInvariantViolation {
  invariantId: string;
  message: string;
  expectedHash: string;
  actualHash: string;
  expectedShape: readonly ProviderMessageShape[];
  actualShape: readonly ProviderMessageShape[];
}

export interface RuntimeInvariantEvaluation {
  invariantId: string;
  passed: boolean;
  violation?: RuntimeInvariantViolation;
}

export class RuntimeInvariantViolationError extends Error {
  readonly violation: RuntimeInvariantViolation;

  constructor(violation: RuntimeInvariantViolation) {
    super(`[runtime-invariant:${violation.invariantId}] ${violation.message}`);
    this.name = 'RuntimeInvariantViolationError';
    this.violation = violation;
  }
}

export interface RuntimeInvariant<TContext> {
  id: string;
  evaluate: (context: TContext) => RuntimeInvariantViolation | null;
}

/** Register and evaluate a deliberately small set of controller invariants. */
export class RuntimeInvariantRegistry<TContext> {
  private readonly invariants = new Map<string, RuntimeInvariant<TContext>>();
  private readonly violationCounts = new Map<string, number>();

  constructor(readonly mode: RuntimeInvariantMode) {}

  register(invariant: RuntimeInvariant<TContext>): void {
    if (this.invariants.has(invariant.id)) {
      throw new Error(`Runtime invariant already registered: ${invariant.id}`);
    }
    this.invariants.set(invariant.id, invariant);
  }

  evaluate(id: string, context: TContext): RuntimeInvariantEvaluation {
    const invariant = this.invariants.get(id);
    if (!invariant) throw new Error(`Unknown runtime invariant: ${id}`);
    if (this.mode === 'off') return { invariantId: id, passed: true };

    const violation = invariant.evaluate(context);
    if (!violation) return { invariantId: id, passed: true };

    this.violationCounts.set(id, (this.violationCounts.get(id) ?? 0) + 1);
    if (this.mode === 'enforce') throw new RuntimeInvariantViolationError(violation);
    return { invariantId: id, passed: false, violation };
  }

  getViolationCount(id: string): number {
    return this.violationCounts.get(id) ?? 0;
  }
}

export const MODEL_VISIBLE_EQUALS_PERSISTED = 'model_visible_equals_persisted';

/** Provider-neutral or final wire message shape safe to compare at dispatch. */
export interface ModelVisibleMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: ProviderToolCall[];
  name?: string;
}

export interface ProviderMessageShape {
  role: string;
  contentBytes: number;
  contentHash: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ReadonlyArray<{
    id: string;
    type: string;
    name: string;
    argumentsHash: string;
  }>;
}

export interface RequestReconstructionContext {
  /** Exact serialized message sequence the native runner will post. */
  outbound: readonly ModelVisibleMessage[];
  /** Independently rebuilt and serialized durable sequence. */
  reconstructed: readonly ModelVisibleMessage[];
}

/**
 * Resolve the rollout mode.  Explicit option/config wins; production defaults
 * to shadow while non-production and CI fail loud.
 */
export function resolveRuntimeInvariantMode(
  explicit?: RuntimeInvariantMode,
): RuntimeInvariantMode {
  if (explicit) return explicit;
  const configured = process.env['BABEL_RUNTIME_INVARIANTS'];
  if (configured === 'enforce' || configured === 'shadow' || configured === 'off') {
    return configured;
  }
  return process.env['NODE_ENV'] === 'production' && !process.env['CI']
    ? 'shadow'
    : 'enforce';
}

/** Create C1's stable, content-free diagnostic for model-visible messages. */
export function summarizeProviderMessages(
  messages: readonly ModelVisibleMessage[],
): ProviderMessageShape[] {
  return messages.map((message) => ({
    role: message.role,
    contentBytes: Buffer.byteLength(message.content, 'utf8'),
    contentHash: sha256(message.content),
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(message.tool_calls?.length
      ? {
          toolCalls: message.tool_calls.map((call) => ({
            id: call.id,
            type: call.type,
            name: call.function.name,
            argumentsHash: sha256(call.function.arguments),
          })),
        }
      : {}),
  }));
}

/** Register the C1 durable reconstruction equality check. */
export function createRequestReconstructionInvariant(): RuntimeInvariant<RequestReconstructionContext> {
  return {
    id: MODEL_VISIBLE_EQUALS_PERSISTED,
    evaluate: ({ outbound, reconstructed }) => {
      const actualShape = summarizeProviderMessages(outbound);
      const expectedShape = summarizeProviderMessages(reconstructed);
      const actualHash = stableHash(outbound);
      const expectedHash = stableHash(reconstructed);
      if (actualHash === expectedHash) return null;
      return {
        invariantId: MODEL_VISIBLE_EQUALS_PERSISTED,
        message: 'Outbound provider messages differ from durable reconstruction',
        expectedHash,
        actualHash,
        expectedShape,
        actualShape,
      };
    },
  };
}

function stableHash(value: unknown): string {
  return sha256(stableSerialize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}
