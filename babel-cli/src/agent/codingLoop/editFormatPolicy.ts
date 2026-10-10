/**
 * Packet D2: per-model edit-format selection.
 *
 * Model-aware choice between the edit formats the chat loop already exposes
 * (str_replace exact edit, apply_patch hunk diff, write_file whole-file).
 * Format success is model-dependent, so the ladder — which format is
 * preferred and in what fallback order — is resolved from the model family
 * and adjusted per session by observed outcomes.
 *
 * Hard rules:
 * - Selection is DETERMINISTIC given model identity + telemetry state. No
 *   randomness, no hidden provider switches.
 * - The registry default reproduces CURRENT behavior exactly: every seeded
 *   family maps to the same ladder, and selection never removes a tool from
 *   the advertised inventory — it only orders preference and records which
 *   format is active so the preamble/telemetry can show it.
 * - Demotion is per-session and configurable (failure streak threshold);
 *   a successful outcome promotes the format back, and the whole tracker
 *   resets with the session.
 */

/** The edit formats the chat loop can apply file mutations with. */
export type EditFormatId = 'str_replace' | 'apply_patch' | 'write_file';

/** Current-behavior ladder: all three formats available, str_replace preferred. */
export const DEFAULT_EDIT_FORMAT_LADDER: readonly EditFormatId[] = [
  'str_replace',
  'apply_patch',
  'write_file',
];

/**
 * Conservative seed: model family → preferred format + fallback order.
 * Every entry is seeded to the current-behavior ladder so unknown and known
 * families behave identically until telemetry-driven differentiation lands.
 */
export const EDIT_FORMAT_REGISTRY: Readonly<Record<string, readonly EditFormatId[]>> = {
  default: DEFAULT_EDIT_FORMAT_LADDER,
  deepseek: DEFAULT_EDIT_FORMAT_LADDER,
  glm: DEFAULT_EDIT_FORMAT_LADDER,
  claude: DEFAULT_EDIT_FORMAT_LADDER,
  openai: DEFAULT_EDIT_FORMAT_LADDER,
  ollama: DEFAULT_EDIT_FORMAT_LADDER,
};

/** Inputs used to derive a registry family key from model identity. */
export interface EditFormatModelIdentity {
  /** Model-policy family (ResolvedModelPolicy.family), if known. */
  policyFamily?: string | null;
  /** Provider id (ResolvedModelPolicy.provider), if known. */
  provider?: string | null;
  /** Concrete provider model id (ResolvedModelPolicy.providerModelId), if known. */
  modelId?: string | null;
}

/** Deterministically lowercase a family candidate or null when unusable. */
function normalizeFamilyCandidate(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Map model identity to a registry family key. Deterministic: checks the
 * concrete model id first (most specific), then the policy family, then the
 * provider; anything unmatched resolves to the conservative `default`.
 */
export function resolveEditFormatFamily(identity: EditFormatModelIdentity): string {
  const knownFamilies = Object.keys(EDIT_FORMAT_REGISTRY).filter((k) => k !== 'default');
  for (const candidate of [identity.modelId, identity.policyFamily, identity.provider]) {
    const normalized = normalizeFamilyCandidate(candidate);
    if (!normalized) continue;
    const direct = knownFamilies.find((family) => normalized === family);
    if (direct) return direct;
    const contained = knownFamilies.find((family) => normalized.includes(family));
    if (contained) return contained;
  }
  return 'default';
}

/** Resolve the preference ladder for a family. Always returns a fresh copy. */
export function resolveEditFormatLadder(family: string): EditFormatId[] {
  const entry = EDIT_FORMAT_REGISTRY[family] ?? EDIT_FORMAT_REGISTRY['default']!;
  return [...entry];
}

/** Consecutive failures before a format is demoted for the rest of the session. */
export const DEFAULT_EDIT_FORMAT_FAILURE_STREAK = 3;

/** Read the configurable demotion threshold (env override, min 1). */
export function resolveEditFormatFailureStreakThreshold(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env['BABEL_EDIT_FORMAT_FAILURE_STREAK'];
  if (!raw) return DEFAULT_EDIT_FORMAT_FAILURE_STREAK;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_EDIT_FORMAT_FAILURE_STREAK;
}

/** Immutable telemetry/session state for edit-format selection. */
export interface EditFormatSessionState {
  readonly family: string;
  readonly ladder: readonly EditFormatId[];
  readonly demoted: ReadonlySet<EditFormatId>;
  readonly failureStreaks: Readonly<Record<EditFormatId, number>>;
  readonly threshold: number;
}

/** An outcome observation for one edit-format attempt. */
export interface EditFormatOutcome {
  /** Whether the mutation was confirmed applied on disk. */
  readonly applied: boolean;
  /** Policy gate blocks are gate decisions, not format failures. */
  readonly policyBlocked?: boolean;
}

/** Snapshot of the live selection state (telemetry surface). */
export interface EditFormatTelemetrySnapshot {
  readonly family: string;
  readonly activeFormat: EditFormatId;
  readonly ladder: readonly EditFormatId[];
  readonly demoted: readonly EditFormatId[];
  readonly failureStreaks: Readonly<Record<EditFormatId, number>>;
  readonly threshold: number;
}

/**
 * Pure: active format is the highest-preference format not currently
 * demoted. If every format is demoted, all demotions are cleared (a write
 * format must always exist — capability is never removed) and the ladder
 * head is active. Deterministic given model + telemetry state.
 */
export function resolveActiveEditFormat(state: EditFormatSessionState): {
  format: EditFormatId;
  state: EditFormatSessionState;
} {
  const remaining = state.ladder.filter((format) => !state.demoted.has(format));
  if (remaining.length > 0) {
    return { format: remaining[0]!, state };
  }
  const cleared: EditFormatSessionState = {
    ...state,
    demoted: new Set(),
    failureStreaks: createEmptyStreaks(),
  };
  return { format: cleared.ladder[0]!, state: cleared };
}

function createEmptyStreaks(): Record<EditFormatId, number> {
  return { str_replace: 0, apply_patch: 0, write_file: 0 };
}

/** Result of applying one outcome to the session state. */
export interface EditFormatOutcomeResult {
  readonly state: EditFormatSessionState;
  /** Format demoted by this outcome (streak threshold reached). */
  readonly demotedNow: EditFormatId | null;
  /** Format promoted back by a successful outcome. */
  readonly promotedNow: EditFormatId | null;
}

/**
 * Pure outcome transition: a policy block is not format evidence; a failure
 * extends the streak and demotes at the threshold (streak then resets so the
 * format can be re-promoted by one success); a success clears the streak and
 * any demotion for that format.
 */
export function applyEditFormatOutcome(
  state: EditFormatSessionState,
  format: EditFormatId,
  outcome: EditFormatOutcome,
): EditFormatOutcomeResult {
  if (outcome.policyBlocked) {
    return { state, demotedNow: null, promotedNow: null };
  }
  if (outcome.applied) {
    const wasDemoted = state.demoted.has(format);
    const demoted = new Set(state.demoted);
    demoted.delete(format);
    return {
      state: {
        ...state,
        demoted,
        failureStreaks: { ...state.failureStreaks, [format]: 0 },
      },
      demotedNow: null,
      promotedNow: wasDemoted ? format : null,
    };
  }
  const streak = (state.failureStreaks[format] ?? 0) + 1;
  if (streak < state.threshold) {
    return {
      state: { ...state, failureStreaks: { ...state.failureStreaks, [format]: streak } },
      demotedNow: null,
      promotedNow: null,
    };
  }
  const demoted = new Set(state.demoted);
  demoted.add(format);
  return {
    state: {
      ...state,
      demoted,
      failureStreaks: { ...state.failureStreaks, [format]: 0 },
    },
    demotedNow: state.demoted.has(format) ? null : format,
    promotedNow: null,
  };
}

/** Per-session edit-format tracker: deterministic selection + streak demotion. */
export interface EditFormatSession {
  /** Registry family this session was resolved for. */
  getFamily(): string;
  /** Retarget the family (only valid before outcomes are recorded). */
  setFamily(family: string): void;
  /** Currently active format (head of the effective ladder). */
  activeFormat(): EditFormatId;
  /** Record one format outcome; returns demotion/promotion events. */
  recordOutcome(
    format: EditFormatId,
    outcome: EditFormatOutcome,
  ): { demotedNow: EditFormatId | null; promotedNow: EditFormatId | null };
  /** Telemetry snapshot asserting the active format. */
  snapshot(): EditFormatTelemetrySnapshot;
  /** Reset all telemetry state (session/branch resync). */
  reset(): void;
}

/** Create a per-session tracker for a model family. */
export function createEditFormatSession(options: {
  family?: string;
  threshold?: number;
} = {}): EditFormatSession {
  let family = options.family ?? 'default';
  let state: EditFormatSessionState = {
    family,
    ladder: resolveEditFormatLadder(family),
    demoted: new Set(),
    failureStreaks: createEmptyStreaks(),
    threshold: options.threshold ?? resolveEditFormatFailureStreakThreshold(),
  };
  return {
    getFamily: () => family,
    setFamily(next) {
      family = next;
      state = { ...state, family: next, ladder: resolveEditFormatLadder(next) };
    },
    activeFormat() {
      const resolved = resolveActiveEditFormat(state);
      state = resolved.state;
      return resolved.format;
    },
    recordOutcome(format, outcome) {
      const result = applyEditFormatOutcome(state, format, outcome);
      state = result.state;
      return { demotedNow: result.demotedNow, promotedNow: result.promotedNow };
    },
    snapshot() {
      const resolved = resolveActiveEditFormat(state);
      state = resolved.state;
      return {
        family: state.family,
        activeFormat: resolved.format,
        ladder: [...state.ladder],
        demoted: [...state.demoted],
        failureStreaks: { ...state.failureStreaks },
        threshold: state.threshold,
      };
    },
    reset() {
      state = {
        family,
        ladder: resolveEditFormatLadder(family),
        demoted: new Set(),
        failureStreaks: createEmptyStreaks(),
        threshold: state.threshold,
      };
    },
  };
}

/** Deterministic one-line telemetry summary for preamble / fact surfaces. */
export function formatEditFormatTelemetryLine(
  snapshot: EditFormatTelemetrySnapshot,
): string {
  const streaks = snapshot.ladder
    .map((format) => `${format}:${snapshot.failureStreaks[format] ?? 0}`)
    .join(',');
  const demoted = snapshot.demoted.length > 0 ? snapshot.demoted.join(',') : 'none';
  return (
    `[BABEL EDIT FORMAT] active=${snapshot.activeFormat} ` +
    `family=${snapshot.family} ` +
    `ladder=${snapshot.ladder.join('>')} ` +
    `demoted=${demoted} failure_streak_threshold=${snapshot.threshold} ` +
    `streaks=${streaks}`
  );
}
