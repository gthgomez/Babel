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
}

export interface FailureSignature {
  tool: string;
  commandSnippet?: string | undefined;
  exitCode?: number | undefined;
  emptyStdout?: boolean | undefined;
}

export interface ProgressControllerSnapshot {
  level: ProgressInterventionLevel;
  totalScore: number;
  strikes: number;
  noProgressStreak: number;
  lastSignals: ProgressSignal[];
  capabilities?: Record<string, CapabilityHealth> | undefined;
}

export class ProgressController {
  private level: ProgressInterventionLevel = 'none';
  private totalScore: number = 0;
  private strikes: number = 0;
  private noProgressStreak = 0;
  private lastSignals: ProgressSignal[] = [];
  private capabilities: Map<string, CapabilityHealth> = new Map();

  public get InterventionLevel(): ProgressInterventionLevel {
    return this.level;
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
    }
  }

  public recordFailure(sig: FailureSignature): {
    capability: string;
    state: CapabilityHealthState;
    notice?: string | undefined;
  } {
    let capability = 'tool.' + sig.tool;
    let preferredAlternative: string | undefined;

    const cmd = (sig.commandSnippet ?? '').toLowerCase();
    const isRecursiveEnum =
      cmd.includes('get-childitem') ||
      cmd.includes('dir /s') ||
      cmd.includes('findstr /s') ||
      cmd.includes('ls -r') ||
      cmd.includes('find .');

    if (sig.tool === 'run_shell_command' && isRecursiveEnum) {
      capability = 'shell.recursive_enumeration';
      preferredAlternative = 'filesystem/list API';
    } else if (sig.tool === 'run_shell_command') {
      capability = 'shell.execution';
    }

    const current = this.capabilities.get(capability) ?? {
      capability,
      state: 'AVAILABLE' as CapabilityHealthState,
      failureCount: 0,
    };

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
    return { capability, state: current.state, notice };
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
