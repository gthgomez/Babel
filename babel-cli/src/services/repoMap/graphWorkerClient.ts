import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { RepoMapGraphOptions, RepoMapGraphOutcome } from './graph.js';

const DEFAULT_DURATION_MS = 2_000;
const MAX_DURATION_MS = 30_000;
const IDLE_DURATION_MS = 60_000;
const TERMINATION_GRACE_MS = 1_000;
const MAX_QUEUED_JOBS = 16;

type WorkerOptions = Omit<RepoMapGraphOptions, 'signal' | 'maxDurationMs'>;
interface Job {
  id: number;
  root: string;
  options: WorkerOptions;
  signal: AbortSignal | undefined;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: RepoMapGraphOutcome) => void;
  settled: boolean;
  started: boolean;
}

let worker: ChildProcess | undefined;
let active: Job | undefined;
let terminating = false;
let terminatingJob: Job | undefined;
let terminationPromise: Promise<void> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
const queue: Job[] = [];

function finish(job: Job, outcome: RepoMapGraphOutcome): void {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  job.signal?.removeEventListener('abort', job.abort);
  job.resolve(outcome);
}

function terminateOwnedWorker(target: ChildProcess, job?: Job, outcome?: RepoMapGraphOutcome): Promise<void> {
  if (worker !== target) return terminationPromise ?? Promise.resolve();
  worker = undefined;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  terminating = true;
  terminatingJob = job;
  if (active === job) active = undefined;

  const exited = new Promise<void>((resolve) => {
    if (target.pid === undefined || target.exitCode !== null || target.signalCode !== null) resolve();
    else target.once('exit', () => resolve());
  });
  // Unlike a worker thread, the operating system can terminate a process
  // even while its native parser is not returning to the JavaScript event loop.
  try { if (target.pid !== undefined) target.kill('SIGKILL'); } catch { /* Wait for observed exit. */ }
  target.unref();
  target.channel?.unref();

  // A broken OS/process handle must not hold provider dispatch forever. Keep
  // the worker quarantined and do not start a replacement until exit is seen.
  const grace = job && outcome ? setTimeout(() => finish(job, outcome), TERMINATION_GRACE_MS) : undefined;
  const completion = exited.then(() => {
    if (grace) clearTimeout(grace);
    if (job && outcome) finish(job, outcome);
    terminatingJob = undefined;
    terminating = false;
    terminationPromise = undefined;
    pump();
  });
  terminationPromise = completion;
  return completion;
}

function cancel(job: Job, reason: 'aborted' | 'deadline'): void {
  if (job.settled || terminatingJob === job) return;
  const outcome: RepoMapGraphOutcome = { status: 'cancelled', reason };
  if (active === job && worker) {
    void terminateOwnedWorker(worker, job, outcome);
    return;
  }
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  finish(job, outcome);
}

function scheduleIdle(target: ChildProcess): void {
  target.unref();
  target.channel?.unref();
  idleTimer = setTimeout(() => {
    if (worker === target && !active) void terminateOwnedWorker(target);
  }, IDLE_DURATION_MS);
  idleTimer.unref();
}

/** The indexer only needs OS launch settings, never provider keys or project env. */
function indexerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // Harmless for Node, and necessary when a development Electron executable
  // hosts the CLI. Do not inherit NODE_OPTIONS or provider credentials.
  env['ELECTRON_RUN_AS_NODE'] = '1';
  return env;
}

function getWorker(): ChildProcess {
  if (worker) return worker;
  const source = import.meta.url.endsWith('.ts');
  const extension = source ? 'ts' : 'js';
  const target = spawn(process.execPath, [
    '--max-old-space-size=192', ...(source ? ['--import', 'tsx'] : []),
    fileURLToPath(new URL(`./graphWorker.${extension}`, import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: indexerEnvironment(),
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  worker = target;
  target.on('message', (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const message = value as { id?: number; started?: boolean; outcome?: RepoMapGraphOutcome };
    const job = active;
    if (worker !== target || !job || message.id !== job.id) return;
    if (message.started) { job.started = true; return; }
    if (!message.outcome) return;
    active = undefined;
    finish(job, message.outcome);
    if (queue.length) pump();
    else scheduleIdle(target);
  });
  const failed = (): void => {
    if (worker !== target) return;
    void terminateOwnedWorker(target, active, { status: 'failed', reason: 'worker_failure' });
  };
  target.on('error', failed);
  target.on('exit', failed);
  return target;
}

function pump(): void {
  if (active || terminating || queue.length === 0) return;
  const job = queue.shift()!;
  if (job.settled) { pump(); return; }
  try {
    const target = getWorker();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    active = job;
    target.ref();
    target.channel?.ref();
    if (!target.connected || !target.send) throw new Error('Indexer IPC is unavailable');
    target.send({ type: 'build', id: job.id, root: job.root, options: job.options }, (error) => {
      if (error && worker === target) void terminateOwnedWorker(target, job, { status: 'failed', reason: 'worker_failure' });
    });
  } catch {
    if (worker) void terminateOwnedWorker(worker, job, { status: 'failed', reason: 'worker_failure' });
    else { active = undefined; finish(job, { status: 'failed', reason: 'worker_failure' }); pump(); }
  }
}

export function runRepoMapWorker(root: string, options: RepoMapGraphOptions): Promise<RepoMapGraphOutcome> {
  if (options.signal?.aborted) return Promise.resolve({ status: 'cancelled', reason: 'aborted' });
  const requested = options.maxDurationMs ?? DEFAULT_DURATION_MS;
  if (!Number.isFinite(requested) || requested <= 0) return Promise.resolve({ status: 'cancelled', reason: 'deadline' });
  if (queue.length >= MAX_QUEUED_JOBS) return Promise.resolve({ status: 'failed', reason: 'worker_failure' });
  const duration = Math.min(requested, MAX_DURATION_MS);
  const { signal, maxDurationMs: _maxDurationMs, seedFiles, mentionedIdents, ...limits } = options;
  const seeds = seedFiles?.slice(0, 64).filter((value) => typeof value === 'string' && value.length <= 4_096);
  const mentions = new Set<string>();
  if (mentionedIdents) {
    let visited = 0;
    for (const value of mentionedIdents) {
      if (++visited > 512) break;
      if (typeof value === 'string' && value.length <= 128) mentions.add(value);
    }
  }
  const workerOptions: WorkerOptions = {
    ...limits,
    ...(seeds ? { seedFiles: seeds } : {}),
    ...(mentionedIdents ? { mentionedIdents: mentions } : {}),
  };
  return new Promise((resolve) => {
    const job: Job = {
      id: ++nextId, root, options: workerOptions, signal,
      abort: () => cancel(job, 'aborted'),
      timer: setTimeout(() => cancel(job, 'deadline'), duration),
      resolve, settled: false, started: false,
    };
    queue.push(job);
    signal?.addEventListener('abort', job.abort, { once: true });
    if (signal?.aborted) cancel(job, 'aborted');
    else pump();
  });
}

export function invalidateWorkerCache(file?: string): void {
  try { worker?.send?.({ type: 'invalidate', ...(file ? { file } : {}) }); } catch { /* A retired process cannot retain trusted cache. */ }
}

/** Non-sensitive lifecycle information for diagnostics and regression tests. */
export function repoMapWorkerState(): { processId: number | null; active: boolean; started: boolean; queued: number; terminating: boolean } {
  return { processId: worker?.pid ?? null, active: !!active, started: !!active?.started, queued: queue.length, terminating };
}

/** Release the owned cache process and cancel any queued work. */
export async function shutdownRepoMapWorker(): Promise<void> {
  for (const job of queue.splice(0)) finish(job, { status: 'cancelled', reason: 'aborted' });
  if (worker) await terminateOwnedWorker(worker, active, { status: 'cancelled', reason: 'aborted' });
  else if (terminationPromise) await terminationPromise;
}
