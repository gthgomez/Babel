import { AgentSession } from '../agent/session.js';
import type { AgentSessionOptions, AgentSessionResult } from '../agent/contracts.js';
import {
  formatLiteResultHuman,
  type LiteResultPayload,
  type LiteVerb,
} from '../cli/structuredOutput.js';
import { liteVerbForSelectedLane, type LiteFullRouteDecision } from './liteFullRouter.js';
import { isStructuredOutputError } from '../runners/base.js';

export function shouldRecoverLitePlanSchemaFailure(input: {
  verb: LiteVerb;
  selectedLane: LiteFullRouteDecision['selected_lane'];
  workerChain?: boolean;
}): boolean {
  if (input.verb === 'plan' || input.verb === 'report') {
    return true;
  }
  return (
    input.verb === 'do' &&
    input.workerChain !== true &&
    ['plan', 'report'].includes(liteVerbForSelectedLane(input.selectedLane))
  );
}

export function isProviderSchemaFailure(error: unknown): boolean {
  return isStructuredOutputError(error);
}

export interface LiteSessionSchemaRecoveryContext {
  verb: LiteVerb;
  selectedLane: LiteFullRouteDecision['selected_lane'];
  workerChain?: boolean;
}

export async function runLiteSessionWithSchemaRecovery(
  runSession: (session: AgentSession) => Promise<AgentSessionResult>,
  sessionOptions: AgentSessionOptions,
  recovery: LiteSessionSchemaRecoveryContext,
): Promise<AgentSessionResult> {
  const session = new AgentSession(sessionOptions);
  try {
    return await runSession(session);
  } catch (error: unknown) {
    if (!shouldRecoverLitePlanSchemaFailure(recovery) || !isProviderSchemaFailure(error)) {
      throw error;
    }
    const fallbackSession = new AgentSession({
      ...sessionOptions,
      provider: 'mock',
      diagnosticDraft: true,
    });
    const result = await runSession(fallbackSession);
    const payload = result.payload as LiteResultPayload;
    payload.schema_retries = (payload.schema_retries ?? 0) + 1;
    payload.recovered_after_schema_retry = false;
    payload.status = 'UNVERIFIED_LOCAL_DRAFT';
    payload.user_status = 'not_verified';
    payload.execution_mode = 'offline_demo';
    payload.usage = { ...payload.usage, costComplete: false, completeCostUSD: null, usageComplete: false };
    payload.route_reason = payload.route_reason
      ? `${payload.route_reason} Provider schema failure; this local fallback is an unverified draft.`
      : 'Provider schema failure; this local fallback is an unverified draft.';
    return {
      ...result,
      exitCode: 1,
      humanText: `Unverified local draft: provider output failed schema validation. Usage and billing are unconfirmed.\n${formatLiteResultHuman(payload)}`,
    };
  }
}

export function truncateProviderErrorMessage(message: string, maxChars = 200): string {
  const trimmed = message.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (/zod validation|invalid json/i.test(trimmed)) {
    return `${trimmed.slice(0, maxChars)}... (see run_dir/schema_failures/ for full details)`;
  }
  return `${trimmed.slice(0, maxChars)}...`;
}

export function classifyLiteSessionError(
  error: unknown,
): 'target_not_found' | 'schema_failure' | 'other' {
  const message = error instanceof Error ? error.message : String(error);
  if (/target root does not exist|resolved target root does not exist/i.test(message)) {
    return 'target_not_found';
  }
  if (isProviderSchemaFailure(error)) {
    return 'schema_failure';
  }
  return 'other';
}
