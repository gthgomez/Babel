/**
 * P1-B — Progress-aware control: ProgressReceipt after each model/tool cycle.
 *
 * Policy intervenes on repeated no-delta receipts, not raw turns-without-write.
 * Correct localization counts as progress; repeated reads of the same unchanged
 * target do not. A failed patch followed by a changed hypothesis resets stall.
 */

export type ProgressDeltaKind =
  | 'localization'
  | 'hypothesis_change'
  | 'reproducer'
  | 'target_change'
  | 'patch_attempt'
  | 'patch_changed'
  | 'verifier_change'
  | 'external_blocker'
  | 'no_progress';

export interface ProgressReceipt {
  cycle: number;
  at_turn: number;
  deltas: ProgressDeltaKind[];
  /** Human-readable evidence snippets (capped). */
  evidence: string[];
  /** Explicit reason when deltas is only no_progress. */
  noProgressReason?: string;
  /** Targets observed this cycle (for same-target-read detection). */
  targetsRead: string[];
  /** Hypothesis fingerprint after this cycle (empty if unknown). */
  hypothesisKey: string;
  hasDelta: boolean;
}

export interface ProgressLedger {
  receipts: ProgressReceipt[];
  /** Targets already read with identical content hash. */
  readFingerprints: Map<string, string>;
  /** Paths already counted as localization (do not re-score as progress). */
  localizedPaths: Set<string>;
  lastHypothesisKey: string;
  consecutiveNoProgress: number;
  lastPatchFailed: boolean;
}

export function createProgressLedger(): ProgressLedger {
  return {
    receipts: [],
    readFingerprints: new Map(),
    localizedPaths: new Set(),
    lastHypothesisKey: '',
    consecutiveNoProgress: 0,
    lastPatchFailed: false,
  };
}

export interface CycleObservation {
  at_turn: number;
  /** Paths newly identified as task-relevant (localization). */
  localizedPaths?: string[];
  /** Changed hypothesis / plan key. */
  hypothesisKey?: string;
  /** Reproducer or failing test command discovered. */
  reproducer?: string;
  /** Target file/symbol change relative to prior focus. */
  targetChanged?: boolean;
  /** Patch was attempted this cycle. */
  patchAttempted?: boolean;
  /** Patch content fingerprint changed vs prior attempt. */
  patchChanged?: boolean;
  /** Patch attempt failed (old_str miss, apply error, etc.). */
  patchFailed?: boolean;
  /** Verifier exit code changed or first verifier run. */
  verifierChanged?: boolean;
  /** External blocker with evidence. */
  externalBlocker?: string;
  /** Read targets this cycle with optional content hash. */
  reads?: Array<{ path: string; contentHash?: string }>;
}

/**
 * Build a ProgressReceipt for one model/tool cycle and update the ledger.
 */
export function recordProgressCycle(
  ledger: ProgressLedger,
  observation: CycleObservation,
): ProgressReceipt {
  const deltas: ProgressDeltaKind[] = [];
  const evidence: string[] = [];
  const targetsRead: string[] = [];

  // Localization only for paths never seen before (re-reads are not progress).
  if (observation.localizedPaths && observation.localizedPaths.length > 0) {
    const novel = observation.localizedPaths.filter(
      (p) => !ledger.localizedPaths.has(p) && !ledger.readFingerprints.has(p),
    );
    if (novel.length > 0) {
      deltas.push('localization');
      evidence.push(`localized:${novel.slice(0, 3).join(',')}`);
      for (const p of novel) ledger.localizedPaths.add(p);
    }
  }

  const hyp = observation.hypothesisKey?.trim() ?? '';
  if (hyp && hyp !== ledger.lastHypothesisKey) {
    deltas.push('hypothesis_change');
    evidence.push(`hypothesis:${hyp.slice(0, 80)}`);
    // Failed patch + new hypothesis resets stall (P1-B acceptance).
    if (ledger.lastPatchFailed) {
      ledger.consecutiveNoProgress = 0;
      ledger.lastPatchFailed = false;
    }
    ledger.lastHypothesisKey = hyp;
  }

  if (observation.reproducer) {
    deltas.push('reproducer');
    evidence.push(`repro:${observation.reproducer.slice(0, 80)}`);
  }

  if (observation.targetChanged) {
    deltas.push('target_change');
    evidence.push('target_changed');
  }

  if (observation.patchAttempted) {
    deltas.push('patch_attempt');
    evidence.push('patch_attempted');
  }
  if (observation.patchChanged) {
    deltas.push('patch_changed');
    evidence.push('patch_changed');
  }
  if (observation.patchFailed) {
    ledger.lastPatchFailed = true;
  }

  if (observation.verifierChanged) {
    deltas.push('verifier_change');
    evidence.push('verifier_changed');
  }

  if (observation.externalBlocker) {
    deltas.push('external_blocker');
    evidence.push(`blocker:${observation.externalBlocker.slice(0, 80)}`);
  }

  // Same-target repeated reads of unchanged content do NOT count as progress.
  for (const read of observation.reads ?? []) {
    targetsRead.push(read.path);
    const prev = ledger.readFingerprints.get(read.path);
    if (read.contentHash !== undefined) {
      if (prev === undefined) {
        // First read of a path can contribute to localization if not already.
        if (!deltas.includes('localization') && !ledger.localizedPaths.has(read.path)) {
          deltas.push('localization');
          evidence.push(`first_read:${read.path}`);
          ledger.localizedPaths.add(read.path);
        }
        ledger.readFingerprints.set(read.path, read.contentHash);
      } else if (prev !== read.contentHash) {
        // Content changed under us — meaningful.
        deltas.push('target_change');
        evidence.push(`content_changed:${read.path}`);
        ledger.readFingerprints.set(read.path, read.contentHash);
      }
      // else: same hash → no progress delta from this read
    } else if (prev === undefined) {
      // No content hash: first encounter only (cannot detect re-read fidelity).
      ledger.readFingerprints.set(read.path, '');
      if (!deltas.includes('localization') && !ledger.localizedPaths.has(read.path)) {
        deltas.push('localization');
        evidence.push(`first_read:${read.path}`);
        ledger.localizedPaths.add(read.path);
      }
    }
    // else: path already fingerprinted without hash → re-read is no-progress
  }

  const hasDelta = deltas.length > 0;
  if (!hasDelta) {
    deltas.push('no_progress');
  }

  const receipt: ProgressReceipt = {
    cycle: ledger.receipts.length,
    at_turn: observation.at_turn,
    deltas,
    evidence: evidence.slice(0, 12),
    targetsRead,
    hypothesisKey: ledger.lastHypothesisKey,
    hasDelta,
    ...(hasDelta
      ? {}
      : {
          noProgressReason:
            targetsRead.length > 0
              ? 'repeated_unchanged_reads'
              : 'no_semantic_delta',
        }),
  };

  ledger.receipts.push(receipt);
  if (hasDelta) {
    ledger.consecutiveNoProgress = 0;
  } else {
    ledger.consecutiveNoProgress += 1;
  }
  return receipt;
}

/** Intervention preference after no-progress (P1-B: prefer recovery over kill). */
export type ProgressIntervention =
  | { action: 'continue' }
  | { action: 'nudge'; message: string }
  | { action: 'recover'; strategy: 'summarize' | 'ask_user' | 'narrow_scope' | 'run_verifier' }
  | { action: 'terminal'; reason: string };

/**
 * Score consecutive no-delta receipts. Does NOT terminal-stop solely because
 * no file was written — only after recovery attempts exhaust.
 */
export function scoreProgressIntervention(
  ledger: ProgressLedger,
  options: {
    /** Max no-progress cycles before recovery. Default 3. */
    nudgeAfter?: number;
    /** Max no-progress cycles after which recovery is required. Default 5. */
    recoverAfter?: number;
    /** Max no-progress after recovery before terminal. Default 8. */
    terminalAfter?: number;
    recoveryAlreadyTried?: boolean;
    hardCeiling?: boolean;
    hardCeilingReason?: string;
    explicitPolicyDenial?: boolean;
    verifiedExternalBlocker?: string;
  } = {},
): ProgressIntervention {
  if (options.hardCeiling) {
    return {
      action: 'terminal',
      reason: options.hardCeilingReason ?? 'Hard resource ceiling',
    };
  }
  if (options.explicitPolicyDenial) {
    return { action: 'terminal', reason: 'Explicit policy denial' };
  }
  if (options.verifiedExternalBlocker) {
    return {
      action: 'terminal',
      reason: options.verifiedExternalBlocker,
    };
  }

  const n = ledger.consecutiveNoProgress;
  const nudgeAfter = options.nudgeAfter ?? 3;
  const recoverAfter = options.recoverAfter ?? 5;
  const terminalAfter = options.terminalAfter ?? 8;

  if (n < nudgeAfter) return { action: 'continue' };
  if (n < recoverAfter) {
    return {
      action: 'nudge',
      message:
        'No semantic progress detected. Summarize evidence, change hypothesis, or mutate the target — do not re-read unchanged files.',
    };
  }
  if (!options.recoveryAlreadyTried && n < terminalAfter) {
    return { action: 'recover', strategy: 'summarize' };
  }
  if (n >= terminalAfter && options.recoveryAlreadyTried) {
    return {
      action: 'terminal',
      reason: `Repeated no-progress after recovery (${n} cycles)`,
    };
  }
  return { action: 'recover', strategy: 'narrow_scope' };
}
