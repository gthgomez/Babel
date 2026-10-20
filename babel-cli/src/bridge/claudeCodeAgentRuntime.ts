import type { SessionDescriptor } from '../executor/contracts.js';
import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import { buildClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
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
}

export type ClaudeCodeCredentialResolver = (
  ref: string,
  admitted: ClaudeCodeAdmittedSession,
) => Promise<Record<string, string> | null>;

export interface ClaudeCodeAgentRuntimeRegistryOptions {
  sdkPort?: ClaudeCodeSdkPort;
  credentialResolver?: ClaudeCodeCredentialResolver;
}

export class ClaudeCodeAgentRuntimeRegistry {
  private readonly sessions = new Map<string, ClaudeCodeRuntimeSession>();
  private readonly admittedByThread = new Map<string, ClaudeCodeAdmittedSession>();
  private readonly sdkPort: ClaudeCodeSdkPort;
  private readonly credentialResolver: ClaudeCodeCredentialResolver | undefined;
  private nextProcessGeneration = 1;

  constructor(options?: ClaudeCodeAgentRuntimeRegistryOptions) {
    this.sdkPort = options?.sdkPort ?? createClaudeCodeLiveSdkPort();
    this.credentialResolver = options?.credentialResolver;
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
      });
    } else {
      const session = this.sessions.get(threadId)!;
      session.admitted = admitted;
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
      };
      this.sessions.set(descriptor.threadId, session);
    }
    return session;
  }

  isCancelPending(descriptor: SessionDescriptor): boolean {
    return this.sessions.get(descriptor.threadId)?.pendingCancel === true;
  }

  clearCancelPending(descriptor: SessionDescriptor): void {
    const session = this.sessions.get(descriptor.threadId);
    if (session) session.pendingCancel = false;
  }

  requestInterrupt(descriptor: SessionDescriptor): boolean {
    const session = this.sessions.get(descriptor.threadId);
    if (!session || !session.turnInFlight) return false;
    session.interruptRequested = true;
    void this.sdkPort.interrupt(session.admitted.admission_digest);
    return true;
  }

  async forceStopForThread(descriptor: SessionDescriptor): Promise<void> {
    const session = this.sessions.get(descriptor.threadId);
    if (!session) return;
    await this.sdkPort.interrupt(session.admitted.admission_digest);
    await this.sdkPort.close(session.admitted.admission_digest);
    await this.sdkPort.awaitTeardown(session.admitted.admission_digest);
    session.generation += 1;
    session.processGeneration = this.nextProcessGeneration++;
    session.turnInFlight = false;
    session.interruptRequested = false;
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
    if (session.turnInFlight) {
      throw new Error('CLAUDE_CODE_TURN_ALREADY_IN_FLIGHT');
    }
    const turnGeneration = session.generation;
    session.turnInFlight = true;
    session.interruptRequested = false;
    session.pendingEvents = [];

    const policy = buildClaudeCodeLaunchPolicySpec(session.admitted.harness_provider_profile);
    if (this.credentialResolver) {
      const creds = await this.credentialResolver(
        session.admitted.harness_credential_ref,
        session.admitted,
      );
      if (!creds) {
        session.pendingEvents.push({
          type: 'failed',
          error: 'Claude credential ref could not be resolved',
        });
        session.turnInFlight = false;
        return;
      }
    }

    const stream = this.sdkPort.runTurn({
      admitted: session.admitted,
      policy,
      message: input.message,
      generation: turnGeneration,
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
        if (session.generation !== turnGeneration) {
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
          };
          if (result.session_id) session.nativeSessionId = result.session_id;
          const usage: SessionUsageSummary = {
            totalCostUSD:
              typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0,
            costComplete: typeof result.total_cost_usd === 'number',
            unknownChargeCount: typeof result.total_cost_usd === 'number' ? 0 : 1,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            modelBreakdown: {},
          };
          if (typeof result.total_cost_usd === 'number') {
            session.sessionCumulativeCostUSD = result.total_cost_usd;
            session.sessionCostCurrencyKnown = true;
          }
          if (result.subtype === 'success') {
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
    }
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await this.sdkPort.close(session.admitted.admission_digest);
      await this.sdkPort.awaitTeardown(session.admitted.admission_digest);
    }
    this.sessions.clear();
    this.admittedByThread.clear();
  }
}

export const globalClaudeCodeAgentRuntime = new ClaudeCodeAgentRuntimeRegistry();
