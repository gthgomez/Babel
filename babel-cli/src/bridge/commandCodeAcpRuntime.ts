import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { mapCommandCodeAcpUpdate } from './commandCodeAcpEventMap.js';
import { probeCommandCodeInstallation } from './commandCodeCliDiscovery.js';
import {
  CommandCodeAcpTransport,
  resolveCommandCodeAcpLaunch,
  type CommandCodePermissionHandler,
} from './commandCodeAcpTransport.js';

export interface CommandCodeRuntimeSession {
  threadId: string;
  nativeSessionId: string;
  projectRoot: string;
  processGeneration: number;
  providerProfile: string;
  modelProfile: string;
  pendingEvents: ChatEvent[];
  wake: (() => void) | null;
  permissionHandler: CommandCodePermissionHandler | null;
  turnState: {
    textBuffer: string[];
    cancelRequested: boolean;
    usage?: {
      totalCostUSD: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      modelBreakdown: Record<string, unknown>;
    };
  };
}

interface ProjectRuntime {
  projectRoot: string;
  transport: CommandCodeAcpTransport;
  generation: number;
  sessions: Map<string, CommandCodeRuntimeSession>;
}

export class CommandCodeAcpRuntimeRegistry {
  private readonly projects = new Map<string, ProjectRuntime>();

  private canonicalProjectRoot(projectRoot: string): string {
    try {
      return realpathSync(resolve(projectRoot));
    } catch {
      return resolve(projectRoot);
    }
  }

  private async projectRuntime(projectRoot: string): Promise<ProjectRuntime> {
    const key = this.canonicalProjectRoot(projectRoot);
    const existing = this.projects.get(key);
    if (existing) return existing;
    const probe = await probeCommandCodeInstallation();
    if (probe.state !== 'verified' || !probe.executable) {
      throw new Error('COMMAND_CODE_UNAVAILABLE');
    }
    const launch =
      process.env['BABEL_COMMAND_CODE_ACP_COMMAND']?.trim()
        ? resolveCommandCodeAcpLaunch()
        : { command: probe.executable, args: ['acp'] as string[] };
    const transport = new CommandCodeAcpTransport(
      {
        command: launch.command,
        args: launch.args,
        cwd: key,
      },
      (update) => this.dispatchSessionUpdate(key, update),
      (input) => this.dispatchPermissionRequest(key, input),
    );
    await transport.start();
    const runtime: ProjectRuntime = {
      projectRoot: key,
      transport,
      generation: transport.processGeneration,
      sessions: new Map(),
    };
    this.projects.set(key, runtime);
    return runtime;
  }

  private sessionByNativeId(
    projectKey: string,
    nativeSessionId: string,
  ): CommandCodeRuntimeSession | undefined {
    const runtime = this.projects.get(projectKey);
    if (!runtime) return undefined;
    for (const session of runtime.sessions.values()) {
      if (session.nativeSessionId === nativeSessionId) return session;
    }
    return undefined;
  }

  private dispatchSessionUpdate(
    projectKey: string,
    update: { sessionId: string; update: Record<string, unknown> },
  ): void {
    const session = this.sessionByNativeId(projectKey, update.sessionId);
    if (!session) return;
    for (const event of mapCommandCodeAcpUpdate(update.update, session.turnState)) {
      session.pendingEvents.push(event);
    }
    session.wake?.();
  }

  private dispatchPermissionRequest(
    projectKey: string,
    input: {
      sessionId: string;
      requestId: string | number;
      params: Record<string, unknown>;
    },
  ): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }> {
    const session = this.sessionByNativeId(projectKey, input.sessionId);
    if (!session?.permissionHandler) {
      return Promise.resolve({ outcome: 'cancelled' });
    }
    return session.permissionHandler(input);
  }

  async ensureSession(descriptor: SessionDescriptor): Promise<CommandCodeRuntimeSession> {
    if (descriptor.harness_adapter_id !== 'command-code') {
      throw new Error('COMMAND_CODE_SESSION_ADAPTER_MISMATCH');
    }
    const runtime = await this.projectRuntime(descriptor.projectRoot);
    const existing = runtime.sessions.get(descriptor.threadId);
    if (existing) return existing;

    if (descriptor.harness_native_session_id) {
      const resumed = await runtime.transport.call('session/resume', {
        sessionId: descriptor.harness_native_session_id,
        cwd: runtime.projectRoot,
      });
      const sessionId = String(resumed.sessionId ?? descriptor.harness_native_session_id);
      const record: CommandCodeRuntimeSession = {
        threadId: descriptor.threadId,
        nativeSessionId: sessionId,
        projectRoot: runtime.projectRoot,
        processGeneration: runtime.generation,
        providerProfile: descriptor.harness_provider_profile ?? descriptor.provider,
        modelProfile: descriptor.harness_model_profile ?? descriptor.model,
        pendingEvents: [],
        wake: null,
        permissionHandler: null,
        turnState: { textBuffer: [], cancelRequested: false },
      };
      runtime.sessions.set(descriptor.threadId, record);
      return record;
    }

    const created = await runtime.transport.call('session/new', { cwd: runtime.projectRoot });
    const sessionId = String(created.sessionId ?? '');
    if (!sessionId) throw new Error('COMMAND_CODE_SESSION_NEW_MISSING_ID');
    const record: CommandCodeRuntimeSession = {
      threadId: descriptor.threadId,
      nativeSessionId: sessionId,
      projectRoot: runtime.projectRoot,
      processGeneration: runtime.generation,
      providerProfile: descriptor.harness_provider_profile ?? descriptor.provider,
      modelProfile: descriptor.harness_model_profile ?? descriptor.model,
      pendingEvents: [],
      wake: null,
      permissionHandler: null,
      turnState: { textBuffer: [], cancelRequested: false },
    };
    runtime.sessions.set(descriptor.threadId, record);
    descriptor.harness_native_session_id = sessionId;
    descriptor.harness_process_generation = runtime.generation;
    descriptor.harness_provider_profile = record.providerProfile;
    descriptor.harness_model_profile = record.modelProfile;
    return record;
  }

  async listSessions(projectRoot: string): Promise<Array<{ sessionId: string; title?: string }>> {
    const runtime = await this.projectRuntime(projectRoot);
    const result = await runtime.transport.call('session/list', { cwd: runtime.projectRoot });
    const sessions = result.sessions;
    if (!Array.isArray(sessions)) return [];
    return sessions
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const sessionId = String((row as { sessionId?: unknown }).sessionId ?? '');
        if (!sessionId) return null;
        const title = (row as { title?: unknown }).title;
        return {
          sessionId,
          ...(typeof title === 'string' ? { title } : {}),
        };
      })
      .filter((row): row is { sessionId: string; title?: string } => row !== null);
  }

  getBoundSession(descriptor: SessionDescriptor): CommandCodeRuntimeSession | undefined {
    const key = this.canonicalProjectRoot(descriptor.projectRoot);
    const runtime = this.projects.get(key);
    return runtime?.sessions.get(descriptor.threadId);
  }

  transportForThread(descriptor: SessionDescriptor): CommandCodeAcpTransport {
    const key = this.canonicalProjectRoot(descriptor.projectRoot);
    const runtime = this.projects.get(key);
    if (!runtime) throw new Error('COMMAND_CODE_RUNTIME_NOT_STARTED');
    const session = runtime.sessions.get(descriptor.threadId);
    if (!session) throw new Error('COMMAND_CODE_SESSION_NOT_BOUND');
    if (session.processGeneration !== runtime.generation) {
      throw new Error('COMMAND_CODE_PROCESS_GENERATION_STALE');
    }
    return runtime.transport;
  }

  async cancelPrompt(descriptor: SessionDescriptor): Promise<void> {
    const session = await this.ensureSession(descriptor);
    const transport = this.transportForThread(descriptor);
    await transport.call('session/cancel', { sessionId: session.nativeSessionId });
  }

  async closeAll(): Promise<void> {
    for (const runtime of this.projects.values()) {
      await runtime.transport.stop();
    }
    this.projects.clear();
  }

  /** Test helper: drop a project runtime without touching unrelated workspaces. */
  async evictProject(projectRoot: string): Promise<void> {
    const key = this.canonicalProjectRoot(projectRoot);
    const runtime = this.projects.get(key);
    if (!runtime) return;
    await runtime.transport.stop();
    this.projects.delete(key);
  }
}

export const globalCommandCodeAcpRuntime = new CommandCodeAcpRuntimeRegistry();
