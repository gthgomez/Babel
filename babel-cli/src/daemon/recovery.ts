/**
 * daemon/recovery.ts — Crash recovery and orphan detection (Phase 6)
 *
 * On daemon startup, detects and cleans up stale state from a previous
 * crash: stale PID files, orphaned IPC sockets, abandoned running jobs.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_DIR, DAEMON_PID_FILE, DAEMON_IPC_PATH } from './constants.js';
import { listAgentJobs, updateAgentJob } from '../services/agentJobs.js';
import type { AgentJob } from '../services/agentJobs.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CrashRecoveryReport {
  stalePidCleaned: boolean;
  orphanSocketCleaned: boolean;
  abandonedJobsReturned: number;
  tmpFilesCleaned: number;
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export function runCrashRecovery(): CrashRecoveryReport {
  const report: CrashRecoveryReport = {
    stalePidCleaned: false,
    orphanSocketCleaned: false,
    abandonedJobsReturned: 0,
    tmpFilesCleaned: 0,
  };

  // 1. Clean stale PID file
  if (existsSync(DAEMON_PID_FILE)) {
    try {
      const pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0); // Check if process exists
      } catch {
        // Process not alive — stale PID
        unlinkSync(DAEMON_PID_FILE);
        report.stalePidCleaned = true;
      }
    } catch {
      // Corrupt PID file — remove it
      try {
        unlinkSync(DAEMON_PID_FILE);
      } catch {
        /* best effort */
      }
      report.stalePidCleaned = true;
    }
  }

  // 2. Clean orphan socket on Unix
  if (process.platform !== 'win32' && existsSync(DAEMON_IPC_PATH)) {
    if (!existsSync(DAEMON_PID_FILE)) {
      try {
        unlinkSync(DAEMON_IPC_PATH);
      } catch {
        /* best effort */
      }
      report.orphanSocketCleaned = true;
    }
  }

  // 3. Recover abandoned jobs (status=running but not updated in >5 min)
  try {
    const { jobs } = listAgentJobs();
    const abandonedThreshold = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      const updatedAt = new Date(job.updated_at).getTime();
      if (updatedAt < abandonedThreshold) {
        try {
          updateAgentJob(job.id, {
            status: 'queued',
            error: 'Abandoned by crashed daemon. Re-enqueued for retry.',
          });
          report.abandonedJobsReturned++;
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* registry may not exist yet */
  }

  // 4. Clean .tmp files from partial writes
  try {
    if (existsSync(DAEMON_DIR)) {
      for (const entry of readdirSync(DAEMON_DIR)) {
        if (entry.endsWith('.tmp')) {
          try {
            unlinkSync(join(DAEMON_DIR, entry));
          } catch {
            /* best effort */
          }
          report.tmpFilesCleaned++;
        }
      }
    }
  } catch {
    /* directory may not exist */
  }

  return report;
}
