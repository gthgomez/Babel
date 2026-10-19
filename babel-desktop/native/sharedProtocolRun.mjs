import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { JsonlDecoder } from './stream.mjs';
import {scopedApproval,scopedApprovalReply} from '../src/core.mjs';
import {productionNodeCliArgv} from './cli-launch.mjs';

const sharedSessionTrace = process.env.BABEL_TEST_SHARED_SESSION_TRACE === '1';
function emitSharedSessionTrace(stage, detail = {}) {
  if (!sharedSessionTrace) return;
  const safe = { stage };
  for (const key of ['runId', 'eventType', 'kind', 'phase']) {
    if (detail[key] !== undefined && detail[key] !== null) safe[key] = String(detail[key]);
  }
  console.error(`[shared-session-trace] ${JSON.stringify(safe)}`);
}

function terminateChildTree(child) {
  try { child.kill(); } catch { /* already exited */ }
}

/** CLI execution entry for shared protocol-host chat (ADR-010 on loopback bridge). */
export function buildHostRunArgs(entry, projectRoot, request) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) throw new TypeError('CLI entry must be absolute');
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw new TypeError('Project root must be absolute');
  if (typeof request.runId !== 'string' || !/^[\w-]{1,100}$/.test(request.runId)) throw new TypeError('Invalid run ID');
  if (request.mode !== 'chat') throw new TypeError('Shared protocol host runs support chat mode only');
  const args = [
    entry,
    'remote',
    'host-run',
    '--project-root',
    projectRoot,
    '--run-id',
    request.runId,
    '--output-format',
    'stream-json',
  ];
  if (request.sessionId) args.push('--resume-thread', request.sessionId);
  if (typeof request.model === 'string' && request.model) args.push('--model', request.model);
  if (typeof request.provider === 'string' && request.provider) args.push('--provider', request.provider);
  args.push('--', request.task);
  return args;
}

/**
 * Owns one `babel remote host-run` child — same IPC surface as BabelChild.
 */
export class SharedProtocolRun {
  #child = null;
  #approval = null;
  #runId = null;
  #approvalClosed = true;

  constructor({executable, entry, projectRoot, port, desktopClientId, desktopProofKey, env = {}, inheritEnv = true}) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute');
    this.executable = executable;
    this.entry = entry;
    this.projectRoot = projectRoot;
    this.port = port;
    this.desktopClientId = desktopClientId;
    this.desktopProofKey = desktopProofKey;
    this.env = env;
    this.inheritEnv = inheritEnv;
  }

  get busy() { return this.#child !== null; }

  get awaitingApproval() {
    return !this.#approvalClosed && Boolean(this.#approval && Date.parse(this.#approval.expires_at) > Date.now());
  }

  start(request, onPacket) {
    if (this.busy) throw new Error('A shared protocol run is already active');
    const hostArgs = buildHostRunArgs(this.entry, this.projectRoot, request);
    const args = productionNodeCliArgv(this.entry, hostArgs.slice(1));
    const send = packet => onPacket({runId: request.runId, ...packet});
    this.#approval = null;
    this.#runId = request.runId;
    this.#approvalClosed = false;
    let turnSettled = false;
    let transportLost = false;
    const decoder = new JsonlDecoder(event => {
      emitSharedSessionTrace('host-run:event', { runId: request.runId, eventType: event.type });
      if (event.type === 'approval.required' && !this.#approvalClosed) {
        const binding = scopedApproval(event.item?.approval);
        this.#approval = binding?.run_id === request.runId ? binding : null;
      }
      if (event.type === 'approval.pending' && event.item?.approval && !this.#approvalClosed) {
        const binding = scopedApproval(event.item.approval);
        this.#approval = binding?.run_id === request.runId ? binding : this.#approval;
      }
      if (event.type === 'approval.reconciled' && event.item?.approval && !this.#approvalClosed) {
        const binding = scopedApproval(event.item.approval);
        if (binding?.run_id === request.runId) this.#approval = binding;
      }
      if (event.type === 'control.rejected') {
        send({ kind: 'event', event });
        if (
          event.operation === 'cancel' &&
          child.stdin &&
          !child.stdin.destroyed
        ) {
          try {
            child.stdin.write(`${JSON.stringify({ decision: 'reconcile_pending_approval' })}\n`);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (event.type === 'transport.disconnected') {
        send({ kind: 'event', event });
        return;
      }
      if (['run_complete', 'run_error', 'turn.completed', 'turn.failed', 'cancelled', 'emergency_stop'].includes(event.type)) {
        if (event.type === 'run_error' && transportLost) {
          send({kind: 'event', event});
          return;
        }
        turnSettled = true;
        this.#approval = null;
        this.#approvalClosed = true;
      }
      send({kind: 'event', event});
    }, error => send({kind: 'transport-error', error}));
    emitSharedSessionTrace('host-run:spawn', { runId: request.runId, phase: 'child' });
    const child = spawn(this.executable, args, {
      cwd: this.projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...(this.inheritEnv ? process.env : {}),
        ...this.env,
        BABEL_DESKTOP_IPC: '1',
        BABEL_DESKTOP_RUN_ID: request.runId,
        BABEL_BRIDGE_PORT: String(this.port),
        BABEL_BRIDGE_DESKTOP_CLIENT_ID: this.desktopClientId,
        BABEL_BRIDGE_DESKTOP_PROOF_KEY: this.desktopProofKey,
        BABEL_DAEMON_ENABLED: 'false',
      },
    });
    this.#child = child;
    child.stdout.on('data', chunk => decoder.push(chunk));
    child.stderr.on('data', () => { /* withheld */ });
    child.on('close', (code, signal) => {
      decoder.end();
      this.#child = null;
      this.#approval = null;
      this.#runId = null;
      this.#approvalClosed = true;
      if (!turnSettled && !transportLost) {
        send({kind: 'event', event: {type: 'run_error', error: 'Shared protocol run ended before the turn settled'}});
        send({kind: 'exit', code: 1, signal});
        return;
      }
      send({kind: 'exit', code: transportLost ? 1 : code ?? 1, signal});
    });
  }

  reply(request) {
    if (this.#approvalClosed || !this.#child?.stdin || this.#child.stdin.destroyed || request?.runId !== this.#runId) return false;
    const reply = scopedApprovalReply(request, this.#approval);
    if (!reply) return false;
    this.#approval = null;
    try {
      this.#child.stdin.write(`${JSON.stringify(reply)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  whenIdle(callback) {
    if (typeof callback !== 'function') return;
    if (!this.#child) { callback(); return; }
    this.#child.once('close', callback);
  }

  /** End stdin and wait for the owned host-run child; force-terminate after timeoutMs. */
  disposeOwnedChild(timeoutMs = 8_000) {
    return new Promise((resolve) => {
      const child = this.#child;
      if (!child) {
        resolve({ forced: false });
        return;
      }
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        terminateChildTree(child);
        resolve({ forced: true });
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        resolve({ forced });
      };
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      child.once('close', finish);
    });
  }

  cancel() {
    const child = this.#child;
    if (!child || child.desktopCancelling) return;
    child.desktopCancelling = true;
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ decision: 'cancel' })}\n`);
      }
    } catch {
      terminateChildTree(child);
    }
  }

  /** Local-admin emergency stop — never used for ordinary cancel. */
  emergencyAdminStop(hostEmergencyToken) {
    const child = this.#child;
    if (!child?.stdin || child.stdin.destroyed || typeof hostEmergencyToken !== 'string' || !hostEmergencyToken) {
      return false;
    }
    try {
      child.stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: hostEmergencyToken })}\n`,
      );
      return true;
    } catch {
      return false;
    }
  }
}
