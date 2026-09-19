/**
 * S03/#213 — one effective child spec at dispatch.
 *
 * The native `sub_agent` declaration advertises `max_rounds`, `instructions`
 * and a model default, but the executor historically ignored or silently
 * clamped them differently per path. This pure resolver is the single source of
 * truth: every declared option is honored, explicitly rejected, or clamped with
 * a reason, for both read and mutation children. Docs/schema/receipts must
 * derive their semantics from these constants.
 *
 * It deliberately does not import ChatEngine (or any lane) so it is a leaf.
 */

/** Bounds shared by the schema description and the runtime clamp. */
export const CHILD_ROUNDS_MIN = 1;
export const CHILD_ROUNDS_MAX = 20;
/** Read-only children default to 4 rounds. */
export const CHILD_READ_DEFAULT_ROUNDS = 4;
/** Mutation children default to 8 rounds (matches DEFAULT_MUTATION_LOOP_MAX_ROUNDS). */
export const CHILD_MUTATION_DEFAULT_ROUNDS = 8;

export type RoundsDisposition = 'default' | 'honored' | 'clamped';
export type RoundsClampReason =
  | 'below_floor_1'
  | 'above_ceiling_20'
  | 'non_integer_truncated';
export type InstructionsDisposition = 'forwarded' | 'absent' | 'unsupported';
export type ModelDisposition = 'override' | 'parent_default';

export interface ResolveChildSpecInput {
  mutation: boolean;
  writeScope: string[];
  instructions?: string | null;
  model?: string | null;
  maxRounds?: number | null;
  parentModel: string | null;
}

export interface EffectiveChildSpec {
  mutation: boolean;
  writeScope: string[];
  requestedRounds: number | null;
  effectiveRounds: number;
  roundsDisposition: RoundsDisposition;
  roundsClampReason: RoundsClampReason | null;
  instructions: string | null;
  instructionsDisposition: InstructionsDisposition;
  requestedModel: string | null;
  resolvedModel: string | null;
  modelDisposition: ModelDisposition;
}

function resolveRounds(
  raw: number | null | undefined,
  mutation: boolean,
): Pick<EffectiveChildSpec, 'requestedRounds' | 'effectiveRounds' | 'roundsDisposition' | 'roundsClampReason'> {
  const fallback = mutation ? CHILD_MUTATION_DEFAULT_ROUNDS : CHILD_READ_DEFAULT_ROUNDS;
  const requested = raw ?? null;
  if (raw === undefined || raw === null || !Number.isFinite(raw)) {
    return {
      requestedRounds: requested,
      effectiveRounds: fallback,
      roundsDisposition: 'default',
      roundsClampReason: null,
    };
  }
  const truncated = Math.trunc(raw);
  let effective = truncated;
  let reason: RoundsClampReason | null = null;
  if (truncated < CHILD_ROUNDS_MIN) {
    effective = CHILD_ROUNDS_MIN;
    reason = 'below_floor_1';
  } else if (truncated > CHILD_ROUNDS_MAX) {
    effective = CHILD_ROUNDS_MAX;
    reason = 'above_ceiling_20';
  } else if (truncated !== raw) {
    reason = 'non_integer_truncated';
  }
  return {
    requestedRounds: requested,
    effectiveRounds: effective,
    roundsDisposition: reason === null ? 'honored' : 'clamped',
    roundsClampReason: reason,
  };
}

export function resolveChildSpec(input: ResolveChildSpecInput): EffectiveChildSpec {
  const mutation = input.mutation === true;
  const writeScope = Array.isArray(input.writeScope) ? [...input.writeScope] : [];

  const instructions =
    typeof input.instructions === 'string' && input.instructions.trim().length > 0
      ? input.instructions
      : null;

  const requestedModel =
    typeof input.model === 'string' && input.model.trim().length > 0 ? input.model : null;
  const resolvedModel = requestedModel ?? input.parentModel ?? null;

  return {
    mutation,
    writeScope,
    ...resolveRounds(input.maxRounds, mutation),
    instructions,
    // Both read and mutation paths are wired to forward the string (slice 1).
    instructionsDisposition: instructions === null ? 'absent' : 'forwarded',
    requestedModel,
    resolvedModel,
    modelDisposition: requestedModel === null ? 'parent_default' : 'override',
  };
}

/**
 * Compact receipt string derived from the same resolved spec, for findings /
 * onSubAgentStart payloads. Never contains user/model-controlled newlines.
 */
export function formatChildSpecReceipt(spec: EffectiveChildSpec): string {
  const clamp = spec.roundsClampReason ? `:${spec.roundsClampReason}` : '';
  return [
    `rounds=${spec.effectiveRounds}(${spec.roundsDisposition}${clamp})`,
    `model=${spec.resolvedModel ?? 'parent'}(${spec.modelDisposition})`,
    `instructions=${spec.instructionsDisposition}`,
    `write_scope=${spec.writeScope.length}`,
  ].join(' ');
}
