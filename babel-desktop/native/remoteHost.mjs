import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {productionNodeCliArgv} from './cli-launch.mjs';

// The listen host is configuration-derived (`BABEL_BRIDGE_HOST` may be
// `localhost`, `LocalHost` or `::1`) while the socket itself always binds
// 127.0.0.1, so the announcement is matched on any loopback spelling.
const LISTENING_RE =
  /Babel Remote (?:acceptance bridge )?listening on http:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):(\d+)/i;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 2_000;

function terminateChildTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe');
    try {
      spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', timeout: 1500});
    } catch {
      /* close handler still reports exit */
    }
  }
  try {
    child.kill();
  } catch {
    /* already exited */
  }
}

/** Build argv for `babel remote serve` without shell interpolation. */
/** Build argv for `babel remote acceptance-bridge` (test-owned deterministic seam). */
export function buildAcceptanceBridgeArgs(entry, projectRoot, {port = 4545, sharedSession = false} = {}) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) throw new TypeError('CLI entry must be an absolute path');
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new TypeError('Project root must be an absolute path');
  }
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    throw new TypeError('Invalid remote listen port');
  }
  const args = [entry, 'remote', 'acceptance-bridge', '--port', String(listenPort), '--project', projectRoot];
  if (sharedSession) args.push('--shared-session');
  return args;
}

export function buildRemoteServeArgs(entry, projectRoot, {port = 4545, sharedSession = false} = {}) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) throw new TypeError('CLI entry must be an absolute path');
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new TypeError('Project root must be an absolute path');
  }
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    throw new TypeError('Invalid remote listen port');
  }
  const args = [entry, 'remote', 'serve', '--port', String(listenPort), '--project', projectRoot];
  if (sharedSession) args.push('--shared-session');
  return args;
}

/** Payload of a Babel bridge /health response, or null when it is not one. */
function bridgeHealthPayload(value) {
  if (!value || typeof value !== 'object') return null;
  return value.ok === true ? value : null;
}

/**
 * Decide whether an observed /health response belongs to the child this host
 * started.
 *
 * The instance label is the strong identity: the host injects it into the
 * child's environment and the bridge echoes it. A peer that predates the label
 * is accepted only when this launch's own child announced a loopback listener
 * — the bridge prints that only after a successful bind — and never from an
 * arbitrary HTTP success on the port.
 */
function healthBelongsToLaunch(payload, instance, announcedPort) {
  if (!payload) return false;
  const echoed = payload.instance;
  if (typeof echoed === 'string' && echoed.length > 0) return echoed === instance;
  return announcedPort !== null;
}

async function waitForOwnedBridgeHealth({port, instance, readAnnouncedPort, timeoutMs}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const announcedPort = readAnnouncedPort();
    const probedPort = announcedPort ?? port;
    try {
      const response = await fetch(`http://127.0.0.1:${probedPort}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const payload = bridgeHealthPayload(await response.json().catch(() => null));
        if (healthBelongsToLaunch(payload, instance, announcedPort)) return probedPort;
      }
    } catch {
      /* retry until deadline */
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

/**
 * Identity-guarded release for a caller-held bridge reference.
 *
 * A start that is superseded while it suspends rejects later; releasing the
 * reference unconditionally would then drop a newer bridge that a successor
 * attempt already owns, orphaning its child and leaving its port bound.
 */
export function releaseBridgeIfCurrent(current, candidate) {
  return current === candidate ? null : current;
}

/**
 * Owns one loopback `babel remote serve` child — the shared protocol host for Desktop + phone.
 */
export class RemoteBridgeChild {
  #child = null;
  #port = null;
  #state = 'stopped';
  #generation = 0;
  #stopTimer = null;
  #desktopClientId = null;
  #desktopProofKey = null;
  #sharedSession = false;

  /**
   * @param {object} options
   * @param {typeof spawn} [options.spawnChild] Process factory. Defaults to the
   *   real `spawn`; tests inject a scripted child so ownership rules (state,
   *   port, timers, close wiring) can be exercised deterministically without
   *   racing a real process exit.
   */
  constructor({executable, entry, projectRoot, env = {}, inheritEnv = true, spawnChild = spawn}) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute');
    this.executable = executable;
    this.entry = entry;
    this.projectRoot = projectRoot;
    this.env = env;
    this.inheritEnv = inheritEnv;
    this.spawnChild = spawnChild;
  }

  get state() {
    return this.#state;
  }

  get running() {
    return this.#state === 'starting' || this.#state === 'ready';
  }

  get port() {
    return this.#port;
  }

  get sharedSession() {
    return this.#sharedSession;
  }

  get desktopClientId() {
    return this.#desktopClientId;
  }

  get desktopProofKey() {
    return this.#desktopProofKey;
  }

  async start({port = 4545, onLine, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS, sharedSession = true, desktopClientId} = {}) {
    if (this.running) throw new Error('Remote bridge is already running');
    const generation = ++this.#generation;
    this.#state = 'starting';
    this.#port = port;

    const instance = randomUUID();
    const useSharedSession = sharedSession === true;
    const controllerId = useSharedSession
      ? (typeof desktopClientId === 'string' && desktopClientId.startsWith('desktop:')
          ? desktopClientId
          : `desktop:${randomUUID().replace(/-/g, '')}`)
      : null;
    const proofKey = useSharedSession ? randomBytes(32).toString('base64url') : null;
    this.#sharedSession = useSharedSession;
    this.#desktopClientId = controllerId;
    this.#desktopProofKey = proofKey;
    const useAcceptanceBridge = this.env.BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE === '1';
    const serveCliArgs = useAcceptanceBridge
      ? buildAcceptanceBridgeArgs(this.entry, this.projectRoot, {
          port,
          sharedSession: useSharedSession,
        })
      : buildRemoteServeArgs(this.entry, this.projectRoot, {
          port,
          sharedSession: useSharedSession,
        });
    const child = this.spawnChild(
      this.executable,
      productionNodeCliArgv(this.entry, serveCliArgs.slice(1)),
      {
      cwd: this.projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...(this.inheritEnv ? process.env : {}),
        ...this.env,
        BABEL_DESKTOP_IPC: '1',
        // Per-launch identity the bridge echoes on /health. Not a credential.
        BABEL_BRIDGE_INSTANCE: instance,
        ...(controllerId && proofKey
          ? {
              BABEL_BRIDGE_SHARED_SESSION: '1',
              BABEL_BRIDGE_DESKTOP_CLIENT_ID: controllerId,
              BABEL_BRIDGE_DESKTOP_PROOF_KEY: proofKey,
            }
          : {}),
        ...(useAcceptanceBridge ? { BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE: '1' } : {}),
      },
    },
    );
    this.#child = child;

    let announcedPort = null;
    let stdoutBuffer = '';
    let stdoutSeen = false;
    let stderrSeen = false;
    const diagnostic = code => {
      if (typeof onLine === 'function') {
        onLine({
          stream: 'status',
          phase: 'remote_start',
          code,
          diagnosticAvailable: true,
          text: 'Remote bridge startup output is withheld because it may contain sensitive diagnostics.',
        });
      }
    };
    const onStdout = chunk => {
      const text = chunk.toString('utf8');
      if (!stdoutSeen) {
        stdoutSeen = true;
        diagnostic('REMOTE_STDOUT_AVAILABLE');
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const candidate of [...lines, stdoutBuffer]) {
        const match = candidate.match(LISTENING_RE);
        if (match?.[1]) announcedPort = Number(match[1]);
      }
    };
    const onStderr = () => {
      if (!stderrSeen) {
        stderrSeen = true;
        diagnostic('REMOTE_STDERR_AVAILABLE');
      }
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    const earlyExit = new Promise((_, reject) => {
      child.once('error', () => {
        reject(new Error('Could not start the remote bridge. Check the selected CLI and local execution prerequisites.'));
      });
      child.once('close', (code, signal) => {
        reject(new Error(`Remote bridge exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      });
    });

    try {
      const readyPort = await Promise.race([
        waitForOwnedBridgeHealth({
          port,
          instance,
          readAnnouncedPort: () => announcedPort,
          timeoutMs: readyTimeoutMs,
        }),
        earlyExit,
      ]);
      if (readyPort === null) {
        throw new Error(
          `Remote bridge did not report readiness for this launch within ${readyTimeoutMs}ms`,
        );
      }
      if (generation !== this.#generation) {
        throw new Error('Remote bridge start was superseded');
      }
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      child.on('close', () => {
        if (generation !== this.#generation) return;
        this.#resetChild();
        this.#state = 'stopped';
      });
      this.#state = 'ready';
      this.#port = readyPort;
      if (typeof onLine === 'function') {
        onLine({
          stream: 'status',
          phase: 'remote_start',
          code: 'REMOTE_READY',
          diagnosticAvailable: stdoutSeen || stderrSeen,
          text: 'Remote bridge is ready on the requested loopback port.',
        });
      }
      return {
        port: readyPort,
        url: `http://127.0.0.1:${readyPort}`,
        uiPath: '/ui',
        sharedSession: useSharedSession,
        desktopClientId: controllerId,
      };
    } catch (error) {
      if (generation === this.#generation) {
        this.#state = 'failed';
        terminateChildTree(child);
        this.#resetChild();
      }
      throw error;
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.stdout.resume();child.stderr.resume();
    }
  }

  stop() {
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    const child = this.#child;
    if (!child) {
      this.#state = 'stopped';
      this.#port = null;
      return;
    }
    this.#state = 'stopping';
    this.#generation += 1;
    terminateChildTree(child);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, STOP_GRACE_MS);
    this.#stopTimer = timer;
    child.once('close', () => {
      // This child's own escalation timer is always mine to clear; the shared
      // bridge state is not. A successor may already own the bridge, so this
      // late close must not reset its child, port, state or timer.
      clearTimeout(timer);
      if (this.#stopTimer === timer) this.#stopTimer = null;
      if (this.#child !== child) return;
      this.#resetChild();
      this.#state = 'stopped';
    });
  }

  #resetChild() {
    this.#child = null;
    this.#port = null;
    this.#desktopClientId = null;
    this.#desktopProofKey = null;
    this.#sharedSession = false;
  }
}
