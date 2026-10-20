export type ProgressSignal =
  | 'production_mutation'
  | 'new_localization'
  | 'changed_hypothesis'
  | 'new_reproducer'
  | 'new_error_signature'
  | 'reduced_failing_tests'
  | 'verifier_attempted'
  | 'verifier_advanced'
  | 'env_blocker_resolved'
  | 'workspace_target_changed'
  | 'changed_recovery_approach'
  | 'text_only_turn'
  | 'repeated_unchanged_read'
  | 'repeated_identical_action'
  | 'gate_rejection'
  | 'external_blocker_verified';

export type ProgressInterventionLevel =
  | 'none'
  | 'nudge'
  | 'restricted_tools'
  | 'last_chance_repair'
  | 'terminal_blocked';

export type CapabilityHealthState = 'AVAILABLE' | 'SUSPECT' | 'DEGRADED' | 'UNAVAILABLE';

export interface CapabilityHealth {
  capability: string;
  state: CapabilityHealthState;
  failureCount: number;
  lastFailureReason?: string | undefined;
  preferredAlternative?: string | undefined;
  /** Class of the most recent observed failure (never itself changes state). */
  lastOutcome?: CapabilityFailureClass | undefined;
}

/**
 * Why an observed non-zero/empty outcome happened. Only a genuine
 * `capability` outcome may disable a tool family: a bad command, a missing
 * target, a permission denial, a cancelled turn, an empty success or an
 * unclassifiable ambiguity are ordinary diagnostics and must not degrade the
 * environment-scoped capability.
 */
export type CapabilityFailureClass =
  | 'capability'
  | 'bad_command'
  | 'missing_target'
  | 'permission'
  | 'empty_success'
  | 'cancelled'
  | 'ambiguous';

export interface FailureSignature {
  tool: string;
  commandSnippet?: string | undefined;
  exitCode?: number | undefined;
  emptyStdout?: boolean | undefined;
  /** Captured stderr, used only for conservative outcome classification. */
  stderr?: string | undefined;
  /** Explicit caller classification; wins over every inferred signal. */
  outcome?: CapabilityFailureClass | undefined;
  /** Explicitly observed cancellation (abort/timeout/SIGINT/SIGTERM). */
  cancelled?: boolean | undefined;
  signal?: string | undefined;
  /** Explicit permission/authority denial, including governed policy blocks. */
  permissionDenied?: boolean | undefined;
  policyBlocked?: boolean | undefined;
  /** Explicit usage/argument error. */
  badCommand?: boolean | undefined;
  /** Explicit missing file/directory/pattern target. */
  missingTarget?: boolean | undefined;
  /**
   * Explicit trusted positive evidence that the tool family itself failed to
   * execute. The dispatcher sets this only from the executor's structured
   * host-origin launch failure; it is never inferred from child output, tool
   * arguments or a model-supplied label. Required before an outcome may be
   * classified `capability`.
   */
  capabilityFailure?: boolean | undefined;
}

const CANCELLED_RE = /\b(?:(?:operation|request) was aborted|aborted|sigint|sigterm|cancelled|canceled|interrupted)\b/i;
const PERMISSION_RE = /\b(?:permission denied|access is denied|eacces|eperm|operation not permitted|not permitted|autonomy_denied|policy_denied|denied by policy)\b/i;
const BAD_COMMAND_RE = /\b(?:command not found|not recognized as an internal or external command|unknown (?:option|command|flag)|unrecognized arguments?|invalid (?:option|argument)|usage:)\b/i;
// Missing-target diagnostics across POSIX and Windows shells. PowerShell reports
// "Cannot find path '...' because it does not exist."; cmd reports "The system
// cannot find the file specified.". Both are missing targets, not capability
// failures. Deliberately narrow: these phrases only ever downgrade a failure to
// a benign class, so a wider match can never over-degrade a family.
const MISSING_TARGET_RE = /\b(?:enoent|no such file or directory|cannot find (?:the )?(?:path|file)|the system cannot find the (?:file|path)|path not found)\b/i;

/**
 * Classify an observed outcome.
 *
 * Precedence is deliberate and two-tiered:
 *
 *  1. An explicit `outcome` wins outright (caller owns the classification).
 *  2. Structured signals supplied by trusted code — the dispatcher, translating
 *     the executor's typed result — in a fixed order: cancellation, permission,
 *     empty success, bad command, missing target, then capability. A genuine
 *     permission or cancellation therefore always beats capability evidence;
 *     capability never masks them.
 *  3. Text inference last, and only for the *benign* classes (cancellation,
 *     permission, bad command, missing target). Text can only downgrade an
 *     outcome away from capability, so a hostile or merely chatty child cannot
 *     promote its own failure into a capability judgement.
 *
 * A `capability` outcome is therefore never inferred from child text. It
 * requires an explicit trusted classification, and everything unclassified is
 * reported as `ambiguous` — never degrading a tool family.
 */
export function classifyCapabilityFailure(sig: FailureSignature): CapabilityFailureClass {
  if (sig.outcome) return sig.outcome;
  if (sig.cancelled === true || sig.signal === 'SIGINT' || sig.signal === 'SIGTERM') return 'cancelled';
  if (sig.permissionDenied === true || sig.policyBlocked === true) return 'permission';
  if (sig.exitCode === 0) return 'empty_success';
  if (sig.badCommand === true) return 'bad_command';
  if (sig.missingTarget === true) return 'missing_target';
  if (sig.capabilityFailure === true) return 'capability';
  const stderr = sig.stderr ?? '';
  if (CANCELLED_RE.test(stderr)) return 'cancelled';
  if (PERMISSION_RE.test(stderr)) return 'permission';
  if (BAD_COMMAND_RE.test(stderr)) return 'bad_command';
  if (MISSING_TARGET_RE.test(stderr)) return 'missing_target';
  return 'ambiguous';
}

export interface ProgressControllerSnapshot {
  level: ProgressInterventionLevel;
  totalScore: number;
  strikes: number;
  noProgressStreak: number;
  lastSignals: ProgressSignal[];
  capabilities?: Record<string, CapabilityHealth> | undefined;
  /** Consumed bounded-recovery probe keys; preserved verbatim across restore. */
  consumedRecoveryProbes?: string[] | undefined;
}

/** A bounded recovery probe scope: capability × task × trusted environment. */
export interface CapabilityRecoveryProbeRequest {
  capability: string;
  taskId: string;
  environmentIdentity: string;
}

export interface ShellCapabilityClassification {
  isShellTool: boolean;
  isRecursiveEnum: boolean;
  capability: string;
  preferredAlternative?: string;
}

export function classifyShellCapability(
  tool: string,
  commandSnippet?: string,
): ShellCapabilityClassification {
  const isShellTool =
    tool === 'run_shell_command' ||
    tool === 'run_command' ||
    tool === 'test_run' ||
    tool === 'shell_exec';

  if (!isShellTool) {
    return {
      isShellTool: false,
      isRecursiveEnum: false,
      capability: 'tool.' + tool,
    };
  }

  const cmd = (commandSnippet ?? '').trim();
  let isRecursiveEnum = false;

  // PowerShell / Windows: Get-ChildItem with -Recurse or -r
  if (/\bGet-ChildItem\b/i.test(cmd) && /\s-(r|recurse)\b/i.test(cmd)) {
    isRecursiveEnum = true;
  } else if (/\bdir\b/i.test(cmd) && /\s\/s\b/i.test(cmd)) {
    // Windows: dir /s
    isRecursiveEnum = true;
  } else if (/\bfindstr\b/i.test(cmd) && /\s\/s\b/i.test(cmd)) {
    // Windows: findstr /s
    isRecursiveEnum = true;
  } else if (/\bls\b/.test(cmd) && /\s-[a-zA-Z]*R[a-zA-Z]*\b/.test(cmd)) {
    // POSIX: ls -R (case sensitive uppercase R; ls -r is reverse sort, not recursive)
    isRecursiveEnum = true;
  } else if (/\bfind\s+(\.|\/|[a-zA-Z0-9_\-\.\/]+)/.test(cmd) && !/\bfindstr\b/i.test(cmd)) {
    // POSIX: find . or find <path>
    isRecursiveEnum = true;
  }

  if (isRecursiveEnum) {
    return {
      isShellTool: true,
      isRecursiveEnum: true,
      capability: 'shell.recursive_enumeration',
      preferredAlternative: 'list_dir / directory_list tool',
    };
  }

  return {
    isShellTool: true,
    isRecursiveEnum: false,
    capability: 'shell.execution',
  };
}

export class ProgressController {
  private level: ProgressInterventionLevel = 'none';
  private totalScore: number = 0;
  private strikes: number = 0;
  private noProgressStreak = 0;
  private lastSignals: ProgressSignal[] = [];
  private capabilities: Map<string, CapabilityHealth> = new Map();
  private consumedRecoveryProbes: Set<string> = new Set();
  private trustedEnvironmentIdentity: string | null = null;

  public get InterventionLevel(): ProgressInterventionLevel {
    return this.level;
  }

  /** Trusted environment identity scoping bounded recovery probes, when set. */
  public get TrustedEnvironmentIdentity(): string | null {
    return this.trustedEnvironmentIdentity;
  }

  /**
   * Bind the trusted environment identity used to scope bounded recovery
   * probes. This value must come from host/engine state, never from model
   * output, so a model-supplied label cannot mint a fresh probe budget.
   */
  public setTrustedEnvironmentIdentity(identity: string | null): void {
    const trimmed = typeof identity === 'string' ? identity.trim() : '';
    this.trustedEnvironmentIdentity = trimmed.length > 0 ? trimmed : null;
  }

  public get TotalScore(): number {
    return this.totalScore;
  }

  public getCapabilityState(capability: string): CapabilityHealthState {
    return this.capabilities.get(capability)?.state ?? 'AVAILABLE';
  }

  public getDegradedCapabilities(): CapabilityHealth[] {
    return Array.from(this.capabilities.values()).filter(
      (c) => c.state === 'DEGRADED' || c.state === 'UNAVAILABLE',
    );
  }

  public recordSuccess(capability: string): void {
    const existing = this.capabilities.get(capability);
    if (existing) {
      existing.state = 'AVAILABLE';
      existing.failureCount = 0;
      existing.lastOutcome = undefined;
    }
  }

  /**
   * Atomically reserve the single bounded recovery probe for a
   * capability × task × trusted-environment key. Reserves before dispatch so
   * concurrent contenders cannot both win, and the reservation is consumed
   * even when the probe throws. Returns false — without reserving anything —
   * on an empty key or a caller-supplied environment identity that disagrees
   * with the bound trusted identity (a spoofed or model-invented scope).
   */
  public admitCapabilityRecoveryProbe(request: CapabilityRecoveryProbeRequest): boolean {
    const capability = typeof request?.capability === 'string' ? request.capability.trim() : '';
    const taskId = typeof request?.taskId === 'string' ? request.taskId.trim() : '';
    const environmentIdentity =
      typeof request?.environmentIdentity === 'string' ? request.environmentIdentity.trim() : '';
    if (!capability || !taskId || !environmentIdentity) return false;
    if (
      this.trustedEnvironmentIdentity !== null &&
      environmentIdentity !== this.trustedEnvironmentIdentity
    ) {
      return false;
    }
    const key = `${capability}\u0000${taskId}\u0000${environmentIdentity}`;
    if (this.consumedRecoveryProbes.has(key)) return false;
    this.consumedRecoveryProbes.add(key);
    return true;
  }

  public hasConsumedCapabilityRecoveryProbe(request: CapabilityRecoveryProbeRequest): boolean {
    const capability = typeof request?.capability === 'string' ? request.capability.trim() : '';
    const taskId = typeof request?.taskId === 'string' ? request.taskId.trim() : '';
    const environmentIdentity =
      typeof request?.environmentIdentity === 'string' ? request.environmentIdentity.trim() : '';
    if (!capability || !taskId || !environmentIdentity) return false;
    return this.consumedRecoveryProbes.has(`${capability}\u0000${taskId}\u0000${environmentIdentity}`);
  }

  public getConsumedCapabilityRecoveryProbes(): string[] {
    return [...this.consumedRecoveryProbes];
  }

  public recordFailure(sig: FailureSignature): {
    capability: string;
    state: CapabilityHealthState;
    outcome: CapabilityFailureClass;
    notice?: string | undefined;
  } {
    const classification = classifyShellCapability(sig.tool, sig.commandSnippet);
    const capability = classification.capability;
    const preferredAlternative = classification.preferredAlternative;
    const outcome = classifyCapabilityFailure(sig);

    const current = this.capabilities.get(capability) ?? {
      capability,
      state: 'AVAILABLE' as CapabilityHealthState,
      failureCount: 0,
    };

    current.lastOutcome = outcome;

    // Only a genuine capability outcome may degrade the environment-scoped
    // family. A bad command, missing target, permission denial, cancellation,
    // empty success or ambiguity is diagnostic: it neither escalates state nor
    // accumulates toward the degrade threshold.
    if (outcome !== 'capability') {
      this.capabilities.set(capability, current);
      return { capability, state: current.state, outcome };
    }

    current.failureCount += 1;
    current.preferredAlternative = preferredAlternative;

    let notice: string | undefined;
    if (capability === 'shell.recursive_enumeration') {
      if (current.failureCount >= 2) {
        current.state = 'DEGRADED';
        current.lastFailureReason = 'repeated exit failure / empty output for recursive enumeration';
        notice = '! Shell enumeration unavailable; switched to filesystem tools';
      } else {
        current.state = 'SUSPECT';
      }
    } else {
      if (current.failureCount >= 3) {
        current.state = 'DEGRADED';
        notice = `! Tool capability ${capability} degraded after repeated failures`;
      } else {
        current.state = 'SUSPECT';
      }
    }

    this.capabilities.set(capability, current);
    return { capability, state: current.state, outcome, notice };
  }

  public snapshot(): ProgressControllerSnapshot {
    const caps: Record<string, CapabilityHealth> = {};
    for (const [k, v] of this.capabilities.entries()) {
      caps[k] = { ...v };
    }
    return {
      level: this.level,
      totalScore: this.totalScore,
      strikes: this.strikes,
      noProgressStreak: this.noProgressStreak,
      lastSignals: [...this.lastSignals],
      capabilities: caps,
      consumedRecoveryProbes: [...this.consumedRecoveryProbes],
    };
  }

  public restore(snapshot: ProgressControllerSnapshot): void {
    this.level = snapshot.level;
    this.totalScore = snapshot.totalScore;
    this.strikes = snapshot.strikes;
    this.noProgressStreak = snapshot.noProgressStreak;
    this.lastSignals = [...snapshot.lastSignals];
    this.capabilities.clear();
    if (snapshot.capabilities) {
      for (const [k, v] of Object.entries(snapshot.capabilities)) {
        this.capabilities.set(k, { ...v });
      }
    }
    // A same-task restore preserves probe consumption; only a new task or a
    // genuinely changed trusted environment yields a fresh capability×task×env
    // key. Restoring therefore never re-arms a consumed probe.
    this.consumedRecoveryProbes = new Set(snapshot.consumedRecoveryProbes ?? []);
  }

  /**
   * Clear task-local recovery punishment for a fresh, non-continued submission.
   *
   * Deliberately preserves `capabilities`: capability health describes the
   * environment/provider, not the task, so it may survive a task boundary.
   * Capability health is never blanked here; it changes only through
   * recordSuccess/recordFailure, so recovery of a degraded capability requires a
   * genuinely successful operation of that capability, not a new task boundary.
   * Prefer this over replacing the controller so environment health is not
   * silently blanked and recovery stays reachable.
   *
   * Bounded-probe consumption is likewise preserved: the scope key embeds the
   * task id, so a fresh task transparently receives a fresh budget while a
   * continuation or a same-task restore cannot re-arm a consumed probe.
   */
  public resetTaskLocal(): void {
    this.level = 'none';
    this.totalScore = 0;
    this.strikes = 0;
    this.noProgressStreak = 0;
    this.lastSignals = [];
  }

  public scoreTurn(
    signals: ProgressSignal[],
    textOnlyTurn: boolean,
    gateStrikes: number
  ): {
    intervention: ProgressInterventionLevel;
    transitioned: boolean;
    score: number;
  } {
    this.lastSignals = [...signals];
    let turnScore = 0;
    if (signals.includes('production_mutation')) turnScore += 10;
    if (signals.includes('new_localization')) turnScore += 4;
    if (signals.includes('changed_hypothesis')) turnScore += 5;
    if (signals.includes('new_reproducer')) turnScore += 8;
    if (signals.includes('new_error_signature')) turnScore += 5;
    if (signals.includes('reduced_failing_tests')) turnScore += 15;
    if (signals.includes('verifier_attempted')) turnScore += 4;
    if (signals.includes('verifier_advanced')) turnScore += 10;
    if (signals.includes('env_blocker_resolved')) turnScore += 20;
    if (signals.includes('workspace_target_changed')) turnScore += 4;
    if (signals.includes('changed_recovery_approach')) turnScore += 6;

    this.totalScore += turnScore;

    if (turnScore > 0) {
      this.noProgressStreak = 0;
      // Recovery! Reduce strikes
      this.strikes = Math.max(0, this.strikes - 2);
    } else {
      this.noProgressStreak += 1;
      let penalty = 1;
      if (textOnlyTurn || signals.includes('text_only_turn')) penalty += 2;
      if (gateStrikes > 0) penalty += gateStrikes;
      if (signals.includes('repeated_unchanged_read')) penalty += 1;
      if (signals.includes('repeated_identical_action')) penalty += 2;
      if (signals.includes('gate_rejection')) penalty += 1;

      // Soften text-only and gate-strike behavior when progress signals show investigation/localization is advancing
      if (this.totalScore > 10) {
        // If we have some totalScore, we can forgive some penalties.
        penalty = Math.max(0, penalty - 1);
      }

      this.strikes += penalty;
    }

    const oldLevel = this.level;

    if (this.strikes >= 12) {
      this.level = 'terminal_blocked';
    } else if (this.strikes >= 9) {
      this.level = 'last_chance_repair';
    } else if (this.strikes >= 6) {
      this.level = 'restricted_tools';
    } else if (this.strikes >= 3) {
      this.level = 'nudge';
    } else {
      this.level = 'none';
    }

    return {
      intervention: this.level,
      transitioned: oldLevel !== this.level,
      score: this.totalScore
    };
  }
}
