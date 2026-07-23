/**
 * daemon/main.ts — Babel production daemon entry point (Phases 0-7)
 *
 * Child process spawned by the CLI (or manually). Creates an IPC server
 * on the platform socket, registers method handlers, manages lifecycle
 * (PID file, crash recovery, file watcher, graceful shutdown with state
 * preservation).
 *
 * Usage: tsx src/daemon/main.ts
 *        (spawned automatically by daemonAutoSpawn in client.ts)
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { DaemonIpcServer } from './ipc.js';
import { DaemonQueue } from './queue.js';
import type { DrainResult } from './queue.js';
import { createAgentJob, listAgentJobs } from '../services/agentJobs.js';
import { listSchedules, updateSchedule, createSchedule } from '../services/schedules.js';
import { runCrashRecovery } from './recovery.js';
import { DaemonFileWatcher } from './fileWatcher.js';
import { DaemonScheduler } from './scheduler.js';
import type { WatchRule } from './fileWatcher.js';
import {
  DAEMON_DIR,
  DAEMON_PID_FILE,
  DAEMON_IPC_PATH,
  DAEMON_IPC_PORT,
  DAEMON_IPC_HOST,
  DAEMON_SHUTDOWN_GRACE_MS,
} from './constants.js';

// ── State ─────────────────────────────────────────────────────────────────────

let watcher: DaemonFileWatcher | null = null;
const WATCH_RULES_FILE = join(DAEMON_DIR, 'watch-rules.json');

function loadWatchRules(): WatchRule[] {
  try {
    if (existsSync(WATCH_RULES_FILE)) {
      return JSON.parse(readFileSync(WATCH_RULES_FILE, 'utf-8')) as WatchRule[];
    }
  } catch {
    /* empty or corrupt */
  }
  return [];
}

function saveWatchRules(rules: WatchRule[]): void {
  mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(WATCH_RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(
  ipc: DaemonIpcServer,
  queue: DaemonQueue,
  scheduler: DaemonScheduler,
  reason: string,
): Promise<void> {
  const shutdownStartedAt = new Date().toISOString();
  console.log(`[daemon] Shutting down (reason: ${reason})...`);

  // Stop scheduler
  scheduler.stop();

  // Stop file watcher
  if (watcher) {
    watcher.stop();
    watcher = null;
  }

  // Stop accepting new IPC connections
  await ipc.close();

  // Drain queue with grace period
  const drainResult: DrainResult = await queue.drain();
  const status = queue.getStatus();

  // Write shutdown log
  try {
    const shutdownLog = {
      shutdown_at: shutdownStartedAt,
      reason,
      uptime_seconds: ipc.uptimeSeconds,
      jobs_completed: status.totalCompleted,
      jobs_failed: status.totalFailed,
      jobs_retried: status.totalRetried,
      final_queue_depth: status.pending,
      active_job_abandoned: drainResult.abandonedJobId,
      drained_cleanly: drainResult.drained,
    };
    writeFileSync(
      join(DAEMON_DIR, `shutdown-${shutdownStartedAt.replace(/[:.]/g, '-')}.json`),
      JSON.stringify(shutdownLog, null, 2),
      'utf-8',
    );
    console.log('[daemon] Shutdown log written.');
  } catch {
    /* best effort */
  }

  // Remove PID file
  if (existsSync(DAEMON_PID_FILE)) {
    try {
      unlinkSync(DAEMON_PID_FILE);
    } catch {
      /* best effort */
    }
  }

  console.log('[daemon] Shutdown complete.');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Crash recovery before starting (Phase 6)
  const recovery = runCrashRecovery();
  if (
    recovery.stalePidCleaned ||
    recovery.orphanSocketCleaned ||
    recovery.abandonedJobsReturned > 0
  ) {
    console.log(
      `[daemon] Crash recovery: stalePid=${recovery.stalePidCleaned}, ` +
        `orphanSocket=${recovery.orphanSocketCleaned}, ` +
        `abandonedJobs=${recovery.abandonedJobsReturned}`,
    );
  }

  // Ensure daemon directory exists
  mkdirSync(DAEMON_DIR, { recursive: true });

  // Create IPC server
  const ipc = new DaemonIpcServer();

  // Create queue consumer
  const queue = new DaemonQueue(/* concurrency */ 1);

  // Active streaming pipeline state variables
  let activeAbortController: AbortController | null = null;
  let activeRequestId: string | null = null;
  const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; reject: (err: Error) => void }>();
  const pendingCostApprovals = new Map<string, { resolve: (approved: boolean) => void; reject: (err: Error) => void }>();

  // Register core handlers
  ipc.on('shutdown', async () => {
    console.log('[daemon] Shutdown requested via IPC.');
    await shutdown(ipc, queue, scheduler, 'ipc_request');
    return { shutdown: true };
  });

  // ── Queue IPC handlers (Phase 3) ──────────────────────────────────────

  ipc.on('queue.enqueue', async (params: any) => {
    const job = createAgentJob({
      task: String(params.task),
      mode: params.mode ?? 'deep',
      projectRoot: params.projectRoot ?? null,
      model: params.model ?? null,
      verifyCommands: params.verifyCommands ?? [],
      priority: typeof params.priority === 'number' ? params.priority : 0,
      maxRetries: typeof params.maxRetries === 'number' ? params.maxRetries : 0,
      tags: Array.isArray(params.tags) ? params.tags : [],
    });
    return { job_id: job.id, status: job.status, priority: job.priority };
  });

  ipc.on('queue.status', async () => {
    return queue.getStatus();
  });

  ipc.on('queue.list', async (params: any) => {
    const result = listAgentJobs();
    const targetStatus = params.status ?? null;
    const filteredJobs = targetStatus
      ? result.jobs.filter((j) => j.status === targetStatus)
      : result.jobs;
    return {
      jobs: filteredJobs.map((j) => ({
        id: j.id,
        status: j.status,
        task: j.task.slice(0, 120),
        priority: j.priority ?? 0,
        retry_count: j.retry_count ?? 0,
        max_retries: j.max_retries ?? 0,
        tags: j.tags ?? [],
        created_at: j.created_at,
        updated_at: j.updated_at,
      })),
      total: filteredJobs.length,
    };
  });

  // ── File watcher IPC handlers (Phase 4) ───────────────────────────────

  ipc.on('watcher.add', async (params: any) => {
    if (!watcher) {
      watcher = new DaemonFileWatcher(queue);
      watcher.start();
    }
    const rule: WatchRule = {
      id: String(params.id ?? `wr-${Date.now()}`),
      pattern: String(params.pattern),
      task: String(params.task),
      debounceMs: typeof params.debounceMs === 'number' ? params.debounceMs : 2000,
      enabled: true,
    };
    watcher.addRule(rule);
    const rules = watcher.listRules();
    saveWatchRules(rules);
    return { added: rule.id, total_rules: rules.length };
  });

  ipc.on('watcher.remove', async (params: any) => {
    if (watcher) {
      watcher.removeRule(String(params.id));
      saveWatchRules(watcher.listRules());
    }
    return { removed: params.id };
  });

  ipc.on('watcher.list', async () => {
    return { rules: watcher?.listRules() ?? loadWatchRules() };
  });

  // ── Scheduler IPC handlers (Phase 8) ──────────────────────────────────

  const scheduler = new DaemonScheduler(60_000);
  scheduler.start();

  ipc.on('schedule.list', async () => {
    const result = listSchedules();
    const status = scheduler.getStatus();
    return { schedules: result.schedules, ...status };
  });

  ipc.on('schedule.add-cron', async (params: any) => {
    const schedule = createSchedule({
      id: String(params.id ?? `cron-${Date.now()}`),
      jobType: params.jobType ?? 'ci_review',
      description: params.description ?? null,
      projectRoot: params.projectRoot ?? null,
    } as any);
    // Set cron fields via update
    updateSchedule(schedule.id, {
      cron_expression: params.cron_expression ?? null,
      schedule_task: params.schedule_task ?? null,
      schedule_mode: params.schedule_mode ?? 'deep',
    } as any);
    return { schedule_id: schedule.id, cron: params.cron_expression };
  });

  ipc.on('schedule.remove', async (params: any) => {
    const { deleteSchedule } = await import('../services/schedules.js');
    const result = deleteSchedule(String(params.id));
    return { deleted: result.deleted };
  });

  // ── Optimizer IPC handlers (Phase 11) ──────────────────────────────────

  ipc.on('optimizer.recommend', async (params: any) => {
    const { recommendModel } = await import('./resourceOptimizer.js');
    const rec = recommendModel({
      task: String(params.task ?? ''),
      tags: Array.isArray(params.tags) ? params.tags : [],
    } as any);
    return rec;
  });

  // ── Streaming Pipeline IPC handlers ───────────────────────────────────

  ipc.onStreaming('pipeline.run', async (params: any, socket: Socket) => {
    if (activeAbortController) {
      try {
        socket.write(
          JSON.stringify({
            type: 'pipeline_error',
            error: { code: -32001, message: 'Daemon is busy' },
          }) + '\n'
        );
      } catch {
        /* ignore */
      }
      socket.end();
      return;
    }

    const requestId = params.requestId ?? `req-${Date.now()}`;
    activeRequestId = requestId;
    activeAbortController = new AbortController();
    pendingApprovals.clear();
    pendingCostApprovals.clear();

    const writeSafeJson = (obj: any) => {
      try {
        socket.write(JSON.stringify(obj) + '\n');
      } catch {
        // Socket closed by client
        if (activeRequestId === requestId && activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
          activeRequestId = null;
        }
      }
    };

    // Listen for client disconnect
    const onDisconnect = () => {
      if (activeRequestId === requestId && activeAbortController) {
        console.log(`[daemon] Client disconnected. Aborting pipeline for request ${requestId}`);
        activeAbortController.abort();
        activeAbortController = null;
        activeRequestId = null;
      }
    };
    socket.on('close', onDisconnect);
    socket.on('error', onDisconnect);

    try {
      const { BabelEventBus, runBabelPipeline } = await import('../pipeline.js');
      const eventBus = new BabelEventBus();

      // Forward event bus events to the socket
      eventBus.on('stage', (idx) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'stage', data: { stage: idx } });
      });
      eventBus.on('agent_id', (id) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'agent_id', data: { id } });
      });
      eventBus.on('log', (line) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'log', data: { line } });
      });
      eventBus.on('runtime_event', (evt) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'runtime_event', data: { event: evt } });
      });
      eventBus.on('prompt_pause', (label) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'prompt_pause', data: { label } });
      });
      eventBus.on('prompt_resume', () => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'prompt_resume', data: {} });
      });
      eventBus.on('assistant_chunk', (payload) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'assistant_chunk', data: payload });
      });
      eventBus.on('assistant_thought', (thought) => {
        writeSafeJson({ type: 'pipeline_event', requestId, event: 'assistant_thought', data: { thought } });
      });

      // Handle JIT approval requests
      eventBus.on('jit_approval_request', (data: { id: string; req: any }) => {
        const timeout = setTimeout(() => {
          const pending = pendingApprovals.get(data.id);
          if (pending) {
            console.log(`[daemon] JIT approval timeout for request ${data.id}. Denying.`);
            pending.resolve(false);
            pendingApprovals.delete(data.id);
          }
        }, 300_000); // 5 minutes

        pendingApprovals.set(data.id, {
          resolve: (approved: boolean) => {
            clearTimeout(timeout);
            pendingApprovals.delete(data.id);
            eventBus.emit(`jit_approval_response:${data.id}`, { approved });
          },
          reject: (err: Error) => {
            clearTimeout(timeout);
            pendingApprovals.delete(data.id);
            eventBus.emit(`jit_approval_response:${data.id}`, { approved: false });
          },
        });

        writeSafeJson({
          type: 'jit_approval_required',
          requestId,
          id: data.id,
          req: data.req,
        });
      });

      // Handle Cost approval requests
      eventBus.on('cost_approval_request', (data: { id: string; estimatedCost: number; threshold: number; tokenCount: number; model: string }) => {
        const timeout = setTimeout(() => {
          const pending = pendingCostApprovals.get(data.id);
          if (pending) {
            console.log(`[daemon] Cost approval timeout for request ${data.id}. Denying.`);
            pending.resolve(false);
            pendingCostApprovals.delete(data.id);
          }
        }, 300_000); // 5 minutes

        pendingCostApprovals.set(data.id, {
          resolve: (approved: boolean) => {
            clearTimeout(timeout);
            pendingCostApprovals.delete(data.id);
            eventBus.emit(`cost_approval_response:${data.id}`, { approved });
          },
          reject: (err: Error) => {
            clearTimeout(timeout);
            pendingCostApprovals.delete(data.id);
            eventBus.emit(`cost_approval_response:${data.id}`, { approved: false });
          },
        });

        writeSafeJson({
          type: 'cost_approval_required',
          requestId,
          id: data.id,
          estimatedCost: data.estimatedCost,
          threshold: data.threshold,
          tokenCount: data.tokenCount,
          model: data.model,
        });
      });

      // Run pipeline within daemon context
      process.env['BABEL_DAEMON'] = 'true';
      const result = await runBabelPipeline(params.task, {
        ...params.options,
        eventBus,
        abortSignal: activeAbortController.signal,
      });

      writeSafeJson({ type: 'pipeline_result', requestId, result });
    } catch (err: any) {
      writeSafeJson({
        type: 'pipeline_error',
        requestId,
        error: { code: err.code ?? -32000, message: err.message ?? 'Unknown pipeline error' },
      });
    } finally {
      activeAbortController = null;
      activeRequestId = null;
      socket.off('close', onDisconnect);
      socket.off('error', onDisconnect);
      socket.end();
    }
  });

  // JIT response handler (separate connection)
  ipc.on('pipeline.jit_response', async (params: any) => {
    const pending = pendingApprovals.get(params.id);
    if (pending) {
      pending.resolve(params.approved === true);
      return { success: true };
    }
    return { success: false, error: 'No pending JIT approval found' };
  });

  // Cost response handler (separate connection)
  ipc.on('pipeline.cost_response', async (params: any) => {
    const pending = pendingCostApprovals.get(params.id);
    if (pending) {
      pending.resolve(params.approved === true);
      return { success: true };
    }
    return { success: false, error: 'No pending cost approval found' };
  });

  // Cancel handler (separate connection)
  ipc.on('pipeline.cancel', async (params: any) => {
    if (activeRequestId === params.requestId && activeAbortController) {
      console.log(`[daemon] Cancel requested for active pipeline request ${params.requestId}`);
      activeAbortController.abort();
      activeAbortController = null;
      activeRequestId = null;
      return { success: true };
    }
    return { success: false, error: 'No active pipeline found for request' };
  });

  // ── Doctor IPC handlers (Phase 5) ─────────────────────────────────────

  ipc.on('doctor.metrics', async () => {
    const status = queue.getStatus();
    const mem = process.memoryUsage();
    return {
      pid: process.pid,
      uptime_seconds: ipc.uptimeSeconds,
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      queue: {
        pending: status.pending,
        active: status.active,
        completed: status.totalCompleted,
        failed: status.totalFailed,
        retried: status.totalRetried,
        rate_limited: status.rateLimitActive,
      },
      watcher: {
        active_rules: watcher?.listRules().filter((r) => r.enabled).length ?? 0,
        total_rules: watcher?.listRules().length ?? 0,
      },
    };
  });

  // ── Start file watcher with persisted rules (Phase 4) ─────────────────

  const savedRules = loadWatchRules();
  if (savedRules.length > 0) {
    watcher = new DaemonFileWatcher(queue);
    for (const rule of savedRules) {
      if (rule.enabled) {
        watcher.addRule(rule);
      }
    }
    watcher.start();
    console.log(`[daemon] File watcher started with ${savedRules.length} rule(s).`);
  }

  // ── Start listening ────────────────────────────────────────────────────

  try {
    await ipc.listen();
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error('[daemon] IPC address already in use. Is another daemon running?');
      process.exit(1);
    }
    throw err;
  }

  // Write PID file AFTER IPC socket is ready
  writeFileSync(DAEMON_PID_FILE, String(process.pid), 'utf-8');

  // Start queue consumer
  queue.start();

  const ipcMethod = process.platform === 'win32'
    ? `${DAEMON_IPC_HOST}:${DAEMON_IPC_PORT}`
    : DAEMON_IPC_PATH;
  console.log(`[daemon] Started. PID: ${process.pid}, IPC: ${ipcMethod}`);

  // ── Signal handlers (Phase 7) ──────────────────────────────────────────

  let shuttingDown = false;
  const onSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] Received ${signal}. Shutting down...`);
    shutdown(ipc, queue, scheduler, signal).then(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[daemon] Fatal startup error:', err);
  process.exit(1);
});
