import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';

export interface ClaudeSdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
}

export interface ClaudeSdkAssistantChunk {
  type: 'assistant';
  text?: string;
}

export interface ClaudeSdkResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  is_error?: boolean;
  /** Turn delta when provider reports cumulative session cost. */
  turn_cost_usd?: number;
}

export type ClaudeSdkStreamMessage =
  | ClaudeSdkUserMessage
  | ClaudeSdkAssistantChunk
  | ClaudeSdkResultMessage
  | { type: string; [key: string]: unknown };

export interface ClaudeCanUseToolRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID?: string;
  signal?: AbortSignal;
}

export type ClaudeCanUseToolDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface ClaudeCodeTurnRequest {
  sessionKey: string;
  admitted: ClaudeCodeAdmittedSession;
  policy: ClaudeCodeLaunchPolicySpec;
  message: string;
  generation: number;
  /** Full-replace child env passed to SDK query() options.env */
  childEnv: Record<string, string>;
  canUseTool: (req: ClaudeCanUseToolRequest) => Promise<ClaudeCanUseToolDecision>;
}

export interface ClaudeCodeSdkPort {
  runTurn(request: ClaudeCodeTurnRequest): AsyncIterable<ClaudeSdkStreamMessage>;
  interrupt(sessionKey: string): Promise<void>;
  close(sessionKey: string): Promise<void>;
  awaitTeardown(sessionKey: string): Promise<void>;
}
