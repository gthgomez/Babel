import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { appendTurnCells, loadThreadCells } from '../services/threadStore/threadStore.js';
import { mapCommandCodeAcpUpdate, type AcpTurnMapState } from './commandCodeAcpEventMap.js';
import {
  applyAcpReplayUpdate,
  createCommandCodeReplayAccumulator,
  finalizeReplayCells,
  type CommandCodeReplayAccumulator,
} from './commandCodeAcpReplay.js';
import { probeCommandCodeInstallation, type CommandCodeInstallProbe } from './commandCodeCliDiscovery.js';
import { permissionActionFromAcpParams, selectAllowOnceOptionId } from './commandCodeAcpPermission.js';
import { CommandCodeAcpTransport } from './commandCodeAcpTransport.js';
import type { RemoteApprovalBroker } from './remoteApproval.js';

export interface CommandCodeTurnPermissionBinding {
  threadId: string;
  turnId: string;
  cwd: string;
  broker: RemoteApprovalBroker;
  notify?: (notification: unknown) => void;
}

export interface CommandCodeRuntimeSession {
  threadId: string;
  nativeSessionId: string;
  projectRoot: string;
  runtimeInstanceId: number;
  pendingEvents: ChatEvent[];
  wake: (() => void) | null;
  permissionBinding: CommandCodeTurnPermissionBinding | null;
  turnState: AcpTurnMapState;
  processDead: boolean;
  replayEvents: ChatEvent[];
  replayCapture: boolean;
  replayAccumulator: CommandCodeReplayAccumulator;
  pendingCancel: boolean;
  /** Last cumulative session cost observed from ACP usage updates (USD when known). */
  sessionCumulativeCostUSD?: number;
  sessionCostCurrencyKnown?: boolean;
}

interface ProjectRuntime {
  projectRoot: string;
  hostScopeId: string;
  transport: CommandCodeAcpTransport;
  runtimeInstanceId: number;
  sessions: Map<string, CommandCodeRuntimeSession>;
  nativeOwners: Map<string, string>;
  starting: Promise<ProjectRuntime> | null;
}

export interface CommandCodeAcpLaunchOverride {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface CommandCodeAcpRuntimeRegistryOptions {
  hostScopeId?: string;
  /** Test-only: injected ACP child launch (never read from ambient production env). */
  testLaunch?: CommandCodeAcpLaunchOverride;
  /** Test-only: replaces installation probe (does not select production launch binary). */
  installProbe?: () => Promise<CommandCodeInstallProbe>;
}

let nextRuntimeInstanceId = 1;

export class CommandCodeAcpRuntimeRegistry {
  private readonly hostScopeId: string;
  private readonly testLaunch: CommandCodeAcpLaunchOverride | undefined;
  private readonly installProbe: (() => Promise<CommandCodeInstallProbe>) | undefined;
  private readonly projects = new Map<string, ProjectRuntime>();
  private readonly projectStarts = new Map<string, Promise<ProjectRuntime>>();
  private readonly pendingThreadCancels = new Set<string>();
  private shuttingDown = false;

  constructor(options?: CommandCodeAcpRuntimeRegistryOptions) {
    this.hostScopeId = options?.hostScopeId ?? randomUUID();
    this.testLaunch = options?.testLaunch;
    this.installProbe = options?.installProbe;
  }

  private projectKey(hostScopeId: string, projectRoot: string): string {
    return `${hostScopeId}:${this.canonicalProjectRoot(projectRoot)}`;
  }

  private canonicalProjectRoot(projectRoot: string): string {
    try {
      return realpathSync(resolve(projectRoot));
    } catch {
      return resolve(projectRoot);
    }
  }

  private async projectRuntime(projectRoot: string): Promise<ProjectRuntime> {
    if (this.shuttingDown) throw new Error('COMMAND_CODE_SHUTTING_DOWN');
    const key = this.projectKey(this.hostScopeId, projectRoot);
    const existing = this.projects.get(key);
    if (existing) return existing;
    const inflight = this.projectStarts.get(key);
    if (inflight) return await inflight;
    const promise = this.createProjectRuntime(projectRoot, key);
    this.projectStarts.set(key, promise);
    try {
      const runtime = await promise;
      if (this.shuttingDown) {
        await runtime.transport.stop();
        throw new Error('COMMAND_CODE_SHUTTING_DOWN');
      }
      this.projects.set(key, runtime);
      return runtime;
    } finally {
      this.projectStarts.delete(key);
    }
  }

  private async createProjectRuntime(projectRoot: string, key: string): Promise<ProjectRuntime> {
    if (this.shuttingDown) throw new Error('COMMAND_CODE_SHUTTING_DOWN');
    const probe = this.installProbe
      ? await this.installProbe()
      : await probeCommandCodeInstallation();
    if (probe.state !== 'verified' || !probe.executable) {
      throw new Error('COMMAND_CODE_UNAVAILABLE');
    }
    const launch = this.testLaunch ?? { command: probe.executable, args: ['acp'] };
    const runtimeInstanceId = nextRuntimeInstanceId++;
    const canonical = this.canonicalProjectRoot(projectRoot);
    const transport = new CommandCodeAcpTransport(
      {
        command: launch.command,
        args: launch.args,
        cwd: canonical,
        ...(launch.env ? { env: launch.env } : {}),
      },
      runtimeInstanceId,
      (update) => this.dispatchSessionUpdate(key, update),
      (input) => this.dispatchPermissionRequest(key, input),
    );
    transport.setProcessExitHandler(() => {
      const runtime = this.projects.get(key);
      if (!runtime) return;
      for (const session of runtime.sessions.values()) {
        session.processDead = true;
        if (!session.turnState.terminalEmitted) {
          session.pendingEvents.push({
            type: 'failed',
            error: 'Command Code ACP process exited unexpectedly',
          });
          session.turnState.terminalEmitted = true;
        }
        session.wake?.();
      }
    });
    await transport.start();
    if (this.shuttingDown) {
      await transport.stop();
      throw new Error('COMMAND_CODE_SHUTTING_DOWN');
    }
    const runtime: ProjectRuntime = {
      projectRoot: canonical,
      hostScopeId: this.hostScopeId,
      transport,
      runtimeInstanceId,
      sessions: new Map(),
      nativeOwners: new Map(),
      starting: null,
    };
    return runtime;
  }

  private runtimeForKey(key: string): ProjectRuntime | undefined {
    return this.projects.get(key);
  }

  private dispatchSessionUpdate(
    key: string,
    update: { sessionId: string; update: Record<string, unknown> },
  ): void {
    const runtime = this.runtimeForKey(key);
    if (!runtime) return;
    const threadId = runtime.nativeOwners.get(update.sessionId);
    const session = threadId ? runtime.sessions.get(threadId) : undefined;
    if (!session) return;
    const codec = runtime.transport.negotiatedCodec();
    if (!codec) return;
    if (session.replayCapture) {
      applyAcpReplayUpdate(
        session.replayAccumulator,
        update.update,
        session.threadId,
        session.nativeSessionId,
      );
      return;
    }
    const events = mapCommandCodeAcpUpdate(update.update, session.turnState, codec.protocolVersion);
    for (const event of events) {
      session.pendingEvents.push(event);
    }
    session.wake?.();
  }

  private dispatchPermissionRequest(
    key: string,
    input: {
      sessionId: string;
      requestId: string | number;
      params: Record<string, unknown>;
    },
  ): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }> {
    const runtime = this.runtimeForKey(key);
    if (!runtime) return Promise.resolve({ outcome: 'cancelled' });
    const threadId = runtime.nativeOwners.get(input.sessionId);
    const session = threadId ? runtime.sessions.get(threadId) : undefined;
    const binding = session?.permissionBinding;
    if (!binding) return Promise.resolve({ outcome: 'cancelled' });
    return this.handlePermissionWithBinding(binding, input.params);
  }

  private async handlePermissionWithBinding(
    binding: CommandCodeTurnPermissionBinding,
    params: Record<string, unknown>,
  ): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }> {
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOnceId = selectAllowOnceOptionId(options);
    if (!allowOnceId) return { outcome: 'cancelled' };
    const action = permissionActionFromAcpParams(params, binding.cwd);
    if (!action) return { outcome: 'cancelled' };
    const allowed = await binding.broker.requestAllowOnce({
      action,
      thread_id: binding.threadId,
      turn_id: binding.turnId,
      cwd: binding.cwd,
      ...(binding.notify ? { notify: binding.notify } : {}),
    });
    if (!allowed) return { outcome: 'cancelled' };
    return { outcome: 'selected', optionId: allowOnceId };
  }

  claimNativeSession(
    runtime: ProjectRuntime,
    nativeSessionId: string,
    threadId: string,
  ): void {
    const owner = runtime.nativeOwners.get(nativeSessionId);
    if (owner && owner !== threadId) {
      throw new Error('COMMAND_CODE_NATIVE_SESSION_ALREADY_BOUND');
    }
    runtime.nativeOwners.set(nativeSessionId, threadId);
  }

  async ensureSession(descriptor: SessionDescriptor): Promise<CommandCodeRuntimeSession> {
    if (descriptor.harness_adapter_id !== 'command-code') {
      throw new Error('COMMAND_CODE_SESSION_ADAPTER_MISMATCH');
    }
    const runtime = await this.projectRuntime(descriptor.projectRoot);
    const existing = runtime.sessions.get(descriptor.threadId);
    if (existing) return existing;

    const codec = runtime.transport.negotiatedCodec();
    if (!codec) throw new Error('COMMAND_CODE_ACP_NOT_NEGOTIATED');

    assertCommandCodeProfilesSupported(descriptor, codec);

    const sessionRecord: CommandCodeRuntimeSession = {
      threadId: descriptor.threadId,
      nativeSessionId: descriptor.harness_native_session_id ?? '',
      projectRoot: runtime.projectRoot,
      runtimeInstanceId: runtime.runtimeInstanceId,
      pendingEvents: [],
      wake: null,
      permissionBinding: null,
      turnState: { textBuffer: [], terminalEmitted: false, promptAdmitted: false },
      processDead: false,
      replayEvents: [],
      replayCapture: false,
      replayAccumulator: createCommandCodeReplayAccumulator(),
      pendingCancel: this.pendingThreadCancels.has(descriptor.threadId),
    };

    try {
      if (descriptor.harness_native_session_id) {
        if (!codec.session.load) {
          throw new Error('COMMAND_CODE_SAVED_SESSION_UNSUPPORTED');
        }
        this.claimNativeSession(runtime, descriptor.harness_native_session_id, descriptor.threadId);
        sessionRecord.nativeSessionId = descriptor.harness_native_session_id;
        runtime.sessions.set(descriptor.threadId, sessionRecord);
        sessionRecord.replayCapture = true;
        const mcpServers: unknown[] = [];
        await runtime.transport.call('session/load', {
          sessionId: descriptor.harness_native_session_id,
          cwd: runtime.projectRoot,
          mcpServers,
        });
        sessionRecord.replayCapture = false;
        if (sessionRecord.pendingCancel && sessionRecord.nativeSessionId) {
          runtime.transport.notify('session/cancel', { sessionId: sessionRecord.nativeSessionId });
        }
        return sessionRecord;
      }

      runtime.sessions.set(descriptor.threadId, sessionRecord);
      const created = await runtime.transport.call('session/new', {
        cwd: runtime.projectRoot,
        mcpServers: [],
      });
      const sessionId = String(created.sessionId ?? '');
      if (!sessionId) throw new Error('COMMAND_CODE_SESSION_NEW_MISSING_ID');
      sessionRecord.nativeSessionId = sessionId;
      this.claimNativeSession(runtime, sessionId, descriptor.threadId);
      descriptor.harness_native_session_id = sessionId;
      descriptor.harness_process_generation = runtime.runtimeInstanceId;
      return sessionRecord;
    } catch (error) {
      runtime.sessions.delete(descriptor.threadId);
      if (descriptor.harness_native_session_id) {
        const owner = runtime.nativeOwners.get(descriptor.harness_native_session_id);
        if (owner === descriptor.threadId) {
          runtime.nativeOwners.delete(descriptor.harness_native_session_id);
        }
      }
      throw error;
    }
  }

  async listSessions(projectRoot: string): Promise<Array<{ sessionId: string; title?: string }>> {
    const runtime = await this.projectRuntime(projectRoot);
    const codec = runtime.transport.negotiatedCodec();
    if (!codec?.session.list) return [];
    const collected: Array<{ sessionId: string; title?: string }> = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error('COMMAND_CODE_SESSION_LIST_CURSOR_REPEATED');
        }
        seenCursors.add(cursor);
      }
      const result = await runtime.transport.call('session/list', {
        cwd: runtime.projectRoot,
        ...(cursor ? { cursor } : {}),
      });
      const sessions = result.sessions;
      if (Array.isArray(sessions)) {
        for (const row of sessions) {
          if (!row || typeof row !== 'object') continue;
          const sessionId = String((row as { sessionId?: unknown }).sessionId ?? '');
          if (!sessionId) continue;
          const title = (row as { title?: unknown }).title;
          collected.push({ sessionId, ...(typeof title === 'string' ? { title } : {}) });
        }
      }
      const next = result.nextCursor;
      cursor = typeof next === 'string' && next.length > 0 ? next : undefined;
      if (!cursor) break;
    }
    return collected;
  }

  async openSavedSession(descriptor: SessionDescriptor): Promise<{ cell_count: number }> {
    await this.ensureSession(descriptor);
    this.persistReplayHistory(descriptor);
    return { cell_count: loadThreadCells(descriptor.threadId).length };
  }

  getBoundSession(descriptor: SessionDescriptor): CommandCodeRuntimeSession | undefined {
    const key = this.projectKey(this.hostScopeId, descriptor.projectRoot);
    return this.projects.get(key)?.sessions.get(descriptor.threadId);
  }

  transportForThread(descriptor: SessionDescriptor): CommandCodeAcpTransport {
    const key = this.projectKey(this.hostScopeId, descriptor.projectRoot);
    const runtime = this.projects.get(key);
    if (!runtime) throw new Error('COMMAND_CODE_RUNTIME_NOT_STARTED');
    const session = runtime.sessions.get(descriptor.threadId);
    if (!session) throw new Error('COMMAND_CODE_SESSION_NOT_BOUND');
    if (session.runtimeInstanceId !== runtime.runtimeInstanceId) {
      throw new Error('COMMAND_CODE_RUNTIME_INSTANCE_STALE');
    }
    return runtime.transport;
  }

  markCancelPending(descriptor: SessionDescriptor): void {
    this.pendingThreadCancels.add(descriptor.threadId);
    const session = this.getBoundSession(descriptor);
    if (session) session.pendingCancel = true;
  }

  isCancelPending(descriptor: SessionDescriptor): boolean {
    if (this.pendingThreadCancels.has(descriptor.threadId)) return true;
    const session = this.getBoundSession(descriptor);
    return Boolean(session?.pendingCancel);
  }

  clearCancelPending(descriptor: SessionDescriptor): void {
    this.pendingThreadCancels.delete(descriptor.threadId);
    const session = this.getBoundSession(descriptor);
    if (session) session.pendingCancel = false;
  }

  requestCancel(descriptor: SessionDescriptor): boolean {
    this.markCancelPending(descriptor);
    const session = this.getBoundSession(descriptor);
    if (!session?.nativeSessionId) return false;
    try {
      const transport = this.transportForThread(descriptor);
      transport.notify('session/cancel', { sessionId: session.nativeSessionId });
      return true;
    } catch {
      return false;
    }
  }

  persistReplayHistory(descriptor: SessionDescriptor): void {
    const session = this.getBoundSession(descriptor);
    if (!session) return;
    const cells = finalizeReplayCells(session.replayAccumulator);
    if (cells.length === 0) return;
    const existingIds = new Set(loadThreadCells(descriptor.threadId).map((cell) => cell.cell_id));
    const novel = cells.filter((cell) => !existingIds.has(cell.cell_id));
    if (novel.length === 0) return;
    appendTurnCells(descriptor.threadId, 0, novel);
  }

  async forceStopForThread(descriptor: SessionDescriptor): Promise<void> {
    const key = this.projectKey(this.hostScopeId, descriptor.projectRoot);
    const runtime = this.projects.get(key);
    if (!runtime) return;
    await runtime.transport.stop();
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    const inflight = [...this.projectStarts.values()];
    await Promise.all(inflight.map((start) => start.catch(() => undefined)));
    const runtimes = [...this.projects.values()];
    for (const runtime of runtimes) {
      await runtime.transport.stop();
    }
    this.projects.clear();
    this.projectStarts.clear();
  }

  async evictProject(projectRoot: string): Promise<void> {
    const key = this.projectKey(this.hostScopeId, projectRoot);
    const runtime = this.projects.get(key);
    if (!runtime) return;
    await runtime.transport.stop();
    this.projects.delete(key);
  }
}

/** @deprecated Use per-bridge registry from sessionServer. Tests may still construct directly. */
function assertCommandCodeProfilesSupported(
  descriptor: SessionDescriptor,
  codec: { session: { modelSelection: boolean } },
): void {
  if (descriptor.mode && descriptor.mode !== 'chat') {
    throw new Error('COMMAND_CODE_MODE_UNSUPPORTED');
  }
  const model = descriptor.harness_model_profile ?? descriptor.model;
  const provider = descriptor.harness_provider_profile ?? descriptor.provider;
  const nonDefaultModel = model && model !== 'default';
  const nonDefaultProvider = provider && provider !== 'default';
  if ((nonDefaultModel || nonDefaultProvider) && !codec.session.modelSelection) {
    throw new Error('COMMAND_CODE_PROFILE_SELECTION_UNSUPPORTED');
  }
}

export const globalCommandCodeAcpRuntime = new CommandCodeAcpRuntimeRegistry();
