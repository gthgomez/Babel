/**
 * daemon/scheduler.ts — Cron schedule evaluator (Phase 8)
 *
 * Extends the existing schedules.ts registry with cron support.
 * The daemon ticks every 60s, evaluates which schedules are due,
 * and creates AgentJobs from them. No external cron-parser dependency
 * needed for basic 5-field cron matching.
 */

import { createAgentJob, listAgentJobs } from '../services/agentJobs.js';
import { listSchedules } from '../services/schedules.js';
import type { ScheduleDefinition } from '../services/schedules.js';
import type { ValidMode } from '../cli/constants.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchedulerStatus {
  totalSchedules: number;
  enabledSchedules: number;
  dueNow: number;
  lastTick: string | null;
}

// ── Cron matching ────────────────────────────────────────────────────────────

const CRON_FIELD_MAX: Record<number, number> = {
  0: 59,
  1: 23,
  2: 31,
  3: 12,
  4: 6,
};

/** Match a 5-field cron expression against a Date. */
function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];

  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i]!, values[i]!, i)) return false;
  }
  return true;
}

function fieldMatches(field: string, value: number, fieldIdx: number): boolean {
  if (field === '*') return true;

  if (field.includes(',')) {
    return field.split(',').some((f) => fieldMatches(f.trim(), value, fieldIdx));
  }

  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr!, 10);
    if (isNaN(step) || step < 1) return false;

    const maxVal = CRON_FIELD_MAX[fieldIdx] ?? 59;
    let min: number, max: number;
    if (range === '*' || !range) {
      min = 0;
      max = maxVal;
    } else if (range.includes('-')) {
      [min, max] = range.split('-').map((n) => parseInt(n, 10)) as [number, number];
    } else {
      min = parseInt(range, 10);
      max = maxVal;
    }
    if (isNaN(min) || isNaN(max)) return false;
    return value >= min && value <= max && (value - min) % step === 0;
  }

  if (field.includes('-')) {
    const [minStr, maxStr] = field.split('-');
    const min = parseInt(minStr!, 10);
    const max = parseInt(maxStr!, 10);
    if (isNaN(min) || isNaN(max)) return false;
    return value >= min && value <= max;
  }

  return value === parseInt(field, 10);
}

/**
 * Compute the next trigger time for a cron expression.
 * Simple forward-search: increments by 1 minute up to 366 days.
 */
function nextCronTime(expr: string, from: Date): Date | null {
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const deadline = new Date(from);
  deadline.setFullYear(deadline.getFullYear() + 1);

  while (candidate <= deadline) {
    if (cronMatches(expr, candidate)) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export class DaemonScheduler {
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _lastTick: string | null = null;

  constructor(private tickIntervalMs: number = 60_000) {}

  /** Start the scheduler tick loop. */
  start(): void {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[daemon:scheduler] tick error:', err.message);
      });
    }, this.tickIntervalMs);
    // Initial tick
    this.tick().catch((err) => {
      console.error('[daemon:scheduler] initial tick error:', err.message);
    });
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  /** Evaluate all schedules and create jobs for due ones. */
  async tick(): Promise<void> {
    this._lastTick = new Date().toISOString();
    const now = new Date();

    let schedules: ScheduleDefinition[];
    try {
      schedules = listSchedules().schedules;
    } catch (err: any) {
      console.error('[daemon:scheduler] Failed to list schedules:', err.message);
      return;
    }

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const cronExpr = (schedule as any).cron_expression as string | undefined;
      if (!cronExpr) continue;

      const nextTrigger = (schedule as any).next_trigger_at
        ? new Date((schedule as any).next_trigger_at)
        : nextCronTime(cronExpr, now);

      if (!nextTrigger || nextTrigger > now) continue;

      // Schedule is due — create a job
      const taskText =
        (schedule as any).schedule_task ??
        schedule.description ??
        `Scheduled job: ${schedule.job_type}`;

      const mode: ValidMode = (schedule as any).schedule_mode ?? 'deep';

      try {
        const job = createAgentJob({
          task: taskText,
          mode,
          projectRoot: schedule.project_root,
          tags: ['scheduler', `schedule:${schedule.id}`],
        });
        console.log(`[daemon:scheduler] Created job ${job.id} from schedule ${schedule.id}`);

        // Update schedule trigger times
        const { updateSchedule } = await import('../services/schedules.js');
        const newNextTrigger = nextCronTime(cronExpr, now);
        updateSchedule(schedule.id, {
          last_triggered_at: now.toISOString(),
          next_trigger_at: newNextTrigger?.toISOString() ?? null,
        } as any);
      } catch (err: any) {
        console.error(
          `[daemon:scheduler] Failed to create job for schedule ${schedule.id}:`,
          err.message,
        );
      }
    }
  }

  getStatus(): SchedulerStatus {
    let schedules: ScheduleDefinition[];
    try {
      schedules = listSchedules().schedules;
    } catch {
      schedules = [];
    }

    const enabled = schedules.filter((s) => s.enabled);
    const now = new Date();
    const dueNow = enabled.filter((s) => {
      const cronExpr = (s as any).cron_expression as string | undefined;
      if (!cronExpr) return false;
      return cronMatches(cronExpr, now);
    });

    return {
      totalSchedules: schedules.length,
      enabledSchedules: enabled.length,
      dueNow: dueNow.length,
      lastTick: this._lastTick,
    };
  }
}
