import type { SessionDescriptor } from '../executor/contracts.js';
import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import { claudeAdmittedWithNativeSession, type ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import { buildClaudeCodeChildEnv } from './claudeCodeChildEnv.js';
import { resolveClaudeCodeHarnessCredentialEnv } from './claudeCodeCredentialResolver.js';
import { buildClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import type { ClaudeCodeHostProfileBindingV1 } from './claudeCodeHostLaunchRegistry.js';
import { claudeCodeSessionKey } from './claudeCodeQueryHandle.js';
import type { ClaudeCodeSdkPort } from './claudeCodeSdkPort.js';
import { createClaudeCodeLiveSdkPort } from './claudeCodeLiveSdkPort.js';
import { bridgeClaudeCanUseTool } from './claudeCodePermissionBridge.js';
import type { RemoteApprovalBroker } from './remoteApproval.js';

export interface ClaudeCodeRuntimeSession {
  threadId: string;
  admitted: ClaudeCodeAdmittedSession;
  generation: number;
  processGeneration: number;
  pendingEvents: ChatEvent[];
  pendingCancel: boolean;
  turnInFlight: boolean;
  interruptRequested: boolean;
  sessionCostBaselineUSD?: number;
  sessionCumulativeCostUSD?: number;
  sessionCostCurrencyKnown?: boolean;
  nativeSessionId?: string;
  turnLock: Promise<void>;
}

export type ClaudeCodeCredentialResolver = (
  ref: string,
  admitted: ClaudeCodeAdmittedSession,
) => Promise<Record<string, string> | null>;

export interface ClaudeCodeAgentRuntimeRegistryOptions {
  sdkPort?: ClaudeCodeSdkPort;
  credentialResolver?: ClaudeCodeCredentialResolver;
  hostAuthBinding?: Pick<
    ClaudeCodeHostProfileBindingV1,
    'auth_host_env' | 'auth_child_env' | 'credential_ref'
  >;
}

export class ClaudeCodeAgentRuntimeRegistry {
  private readonly sessions = new Map<string, ClaudeCodeRuntimeSession>();
  private readonly admittedByThread = new Map<string, ClaudeCodeAdmittedSession>();
  private readonly sdkPort: ClaudeCodeSdkPort;
  private readonly credentialResolver: ClaudeCodeCredentialResolver;
  private readonly hostAuthBinding?: ClaudeCodeAgentRuntimeRegistryOptions['hostAuthBinding'];
  private nextProcessGeneration = 1;

  constructor(options?: ClaudeCodeAgentRuntimeRegistryOptions) {
    this.sdkPort = options?.sdkPort ?? createClaudeCodeLiveSdkPort();
    this.hostAuthBinding = options?.hostAuthBinding;
    this.credentialResolver =
      options?.credentialResolver ??
      (async (ref, admitted) => {
        try {
          return resolveClaudeCodeHarnessCredentialEnv(ref, admitted, process.env, {
            credential_ref: admitted.harness_credential_ref,
            auth_host_env: admitted.trusted_auth_host_env,
            auth_child_env: admitted.trusted_auth_child_env,
          });
        } catch {
          return null;
        }
      });
  }

  getAdmitted(threadId: string): ClaudeCodeAdmittedSession | undefined {
    return this.admittedByThread.get(threadId);
  }

  bindAdmitted(threadId: string, admitted: ClaudeCodeAdmittedSession): void {
    this.admittedByThread.set(threadId, admitted);
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, {
        threadId,
        admitted,
        generation: 1,
        processGeneration: this.nextProcessGeneration++,
        pendingEvents: [],
        pendingCancel: false,
        turnInFlight: false,
        interruptRequested: false,
        turnLock: Promise.resolve(),
        ...(admitted.harness_native_session_id
          ? { nativeSessionId: admitted.harness_native_session_id }
          : {}),
      });
    } else {
      const session = this.sessions.get(threadId)!;
      session.admitted = admitted;
      if (admitted.harness_native_session_id) {
        session.nativeSessionId = admitted.harness_native_session_id;
      }
    }
  }

  async ensureSession(descriptor: SessionDescriptor): Promise<ClaudeCodeRuntimeSession> {
    const admitted = this.admittedByThread.get(descriptor.threadId);
    if (!admitted) {
      throw new Error('CLAUDE_CODE_NOT_ADMITTED');
    }
    let session = this.sessions.get(descriptor.threadId);
    if (!session) {
      session = {
        threadId: descriptor.threadId,
        admitted,
        generation: 1,
        processGeneration: this.nextProcessGeneration++,
        pendingEvents: [],
        pendingCancel: false,
        turnInFlight: false,
        interruptRequested: false,
        turnLock: Promise.resolve(),
      };
      this.sessions.set(descriptor.threadId, session);
    }
    return session;
  }

  isCancelPending(descriptor: SessionDescriptor): boolean {
    return this.sessions.get(descriptor.threadId)?.pendingCancel === true;
  }

  markCancelPending(descriptor: SessionDescriptor): void {
    const session = this.sessions.get(descriptor.threadId);
    if (session) session.pendingCancel = true;
  }

  clearCancelPending(descriptor: SessionDescriptor): void {
    const session = this.sessions.get(descriptor.threadId);
    if (session) session.pendingCancel = false;
  }

  requestInterrupt(descriptor: SessionDescriptor, turnId: string): boolean {
    const session = this.sessions.get(descriptor.threadId);
    if (!session || !session.turnInFlight) return false;
    session.interruptRequested = true;
    session.pendingCancel = true;
    const key = claudeCodeSessionKey(descriptor.threadId, session.processGeneration, turnId);
    void this.sdkPort.interrupt(key);
    return true;
  }

  async forceStopForThread(descriptor: SessionDescriptor, turnId: string): Promise<void> {
    const session = this.sessions.get(descriptor.threadId);
    if (!session) return;
    session.generation += 1;
    session.pendingCancel = true;
    const key = claudeCodeSessionKey(descriptor.threadId, session.processGeneration, turnId);
    await this.sdkPort.interrupt(key);
    await this.sdkPort.close(key);
    await this.sdkPort.awaitTeardown(key);
    session.processGeneration = this.nextProcessGeneration++;
    session.turnInFlight = false;
    session.interruptRequested = false;
  }

  consumeNativeSessionId(threadId: string): string | undefined {
    const session = this.sessions.get(threadId);
    return session?.nativeSessionId;
  }

  async runTurn(input: {
    descriptor: SessionDescriptor;
    message: string;
    binding: {
      threadId: string;
      turnId: string;
      cwd: string;
      broker: RemoteApprovalBroker;
      notify?: (notification: unknown) => void;
    };
  }): Promise<void> {
    const session = await this.ensureSession(input.descriptor);
    const previousLock = session.turnLock;
    let releaseLock!: () => void;
    session.turnLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousLock;

    if (session.turnInFlight) {
      releaseLock();
      throw new Error('CLAUDE_CODE_TURN_ALREADY_IN_FLIGHT');
    }

    const turnGeneration = session.generation;
    const processGeneration = session.processGeneration;
    const sessionKey = claudeCodeSessionKey(
      input.binding.threadId,
      processGeneration,
      input.binding.turnId,
    );

    const stale = () =>
      session.generation !== turnGeneration || session.pendingCancel || session.interruptRequested;

    if (stale()) {
      session.pendingEvents.push({ type: 'cancelled' });
      releaseLock();
      return;
    }

    session.turnInFlight = true;
    session.interruptRequested = false;
    session.pendingCancel = false;
    const costBaseline =
      typeof session.sessionCumulativeCostUSD === 'number' ? session.sessionCumulativeCostUSD : 0;

    const policy = buildClaudeCodeLaunchPolicySpec(session.admitted.harness_provider_profile);
    const creds = await this.credentialResolver(
      session.admitted.harness_credential_ref,
      session.admitted,
    );
    if (stale()) {
      session.pendingEvents.push({ type: 'cancelled' });
      session.turnInFlight = false;
      releaseLock();
      return;
    }
    if (!creds) {
      session.pendingEvents.push({
        type: 'failed',
        error: 'Claude credential ref could not be resolved',
      });
      session.turnInFlight = false;
      releaseLock();
      return;
    }

    const admittedForTurn: ClaudeCodeAdmittedSession = {
      ...session.admitted,
      ...(session.nativeSessionId ? { harness_native_session_id: session.nativeSessionId } : {}),
    };

    const childEnv = buildClaudeCodeChildEnv({
      admitted: admittedForTurn,
      policy,
      credentialEnv: creds,
    });

    const stream = this.sdkPort.runTurn({
      sessionKey,
      admitted: admittedForTurn,
      policy,
      message: input.message,
      generation: turnGeneration,
      childEnv,
      canUseTool: (req) =>
        bridgeClaudeCanUseTool({
          req,
          cwd: input.binding.cwd,
          threadId: input.binding.threadId,
          turnId: input.binding.turnId,
          broker: input.binding.broker,
          generation: turnGeneration,
          activeGeneration: () => session.generation,
          ...(input.binding.notify ? { notify: input.binding.notify } : {}),
        }),
    });

    let textBuffer = '';
    try {
      for await (const msg of stream) {
        if (stale()) {
          session.pendingEvents.push({ type: 'cancelled' });
          break;
        }
        if (msg.type === 'assistant' && typeof (msg as { text?: string }).text === 'string') {
          textBuffer += (msg as { text: string }).text;
          session.pendingEvents.push({ type: 'answer_chunk', text: (msg as { text: string }).text });
        }
        if (msg.type === 'result') {
          const result = msg as {
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            session_id?: string;
            is_error?: boolean;
            turn_cost_usd?: number;
          };
          if (result.session_id) {
            session.nativeSessionId = result.session_id;
            const admitted = claudeAdmittedWithNativeSession(session.admitted, result.session_id);
            session.admitted = admitted;
            this.admittedByThread.set(session.threadId, admitted);
          }

          let turnCost: number | undefined;
          if (typeof result.total_cost_usd === 'number') {
            session.sessionCumulativeCostUSD = result.total_cost_usd;
            session.sessionCostCurrencyKnown = true;
            turnCost = Math.max(0, result.total_cost_usd - costBaseline);
          }

          const usage: SessionUsageSummary = {
            totalCostUSD: typeof turnCost === 'number' ? turnCost : 0,
            costComplete: typeof turnCost === 'number',
            unknownChargeCount: typeof turnCost === 'number' ? 0 : 1,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            modelBreakdown: {},
          };

          const failed = result.is_error === true || result.subtype === 'error';
          if (!failed && result.subtype === 'success') {
            session.pendingEvents.push({
              type: 'done',
              answer: result.result ?? textBuffer,
              status: 'completed',
              usage,
            });
          } else {
            session.pendingEvents.push({
              type: 'failed',
              error: result.result ?? 'Claude SDK turn failed',
            });
          }
        }
      }
      if (session.interruptRequested && session.generation === turnGeneration) {
        session.pendingEvents.push({ type: 'cancelled' });
      }
    } finally {
      session.turnInFlight = false;
      await this.sdkPort.awaitTeardown(sessionKey);
      releaseLock();
    }
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      const key = claudeCodeSessionKey(session.threadId, session.processGeneration, 'shutdown');
      await this.sdkPort.close(key);
      await this.sdkPort.awaitTeardown(key);
    }
    this.sessions.clear();
    this.admittedByThread.clear();
  }
}

export const globalClaudeCodeAgentRuntime = new ClaudeCodeAgentRuntimeRegistry();
