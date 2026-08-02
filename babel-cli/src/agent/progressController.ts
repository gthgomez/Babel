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

export interface ProgressControllerSnapshot {
  level: ProgressInterventionLevel;
  totalScore: number;
  strikes: number;
  noProgressStreak: number;
  lastSignals: ProgressSignal[];
}

export class ProgressController {
  private level: ProgressInterventionLevel = 'none';
  private totalScore: number = 0;
  private strikes: number = 0;
  private noProgressStreak = 0;
  private lastSignals: ProgressSignal[] = [];

  public get InterventionLevel(): ProgressInterventionLevel {
    return this.level;
  }

  public get TotalScore(): number {
    return this.totalScore;
  }

  public snapshot(): ProgressControllerSnapshot {
    return {
      level: this.level,
      totalScore: this.totalScore,
      strikes: this.strikes,
      noProgressStreak: this.noProgressStreak,
      lastSignals: [...this.lastSignals],
    };
  }

  public restore(snapshot: ProgressControllerSnapshot): void {
    this.level = snapshot.level;
    this.totalScore = snapshot.totalScore;
    this.strikes = snapshot.strikes;
    this.noProgressStreak = snapshot.noProgressStreak;
    this.lastSignals = [...snapshot.lastSignals];
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
