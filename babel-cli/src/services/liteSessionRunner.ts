import { AgentSession } from '../agent/session.js';
import type { AgentSessionOptions, AgentSessionResult } from '../agent/contracts.js';
import {
  formatLiteResultHuman,
  type LiteResultPayload,
  type LiteVerb,
} from '../cli/structuredOutput.js';
import { liteVerbForSelectedLane, type LiteFullRouteDecision } from './liteFullRouter.js';

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
  const message = error instanceof Error ? error.message : String(error);
  return /zod validation|invalid json|schema|parse/i.test(message);
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
    });
    const result = await runSession(fallbackSession);
    const payload = result.payload as LiteResultPayload;
    payload.schema_retries = (payload.schema_retries ?? 0) + 1;
    payload.recovered_after_schema_retry = true;
    payload.route_reason = payload.route_reason
      ? `${payload.route_reason} Recovered from provider schema failure with the local read-only fallback.`
      : 'Recovered from provider schema failure with the local read-only fallback.';
    return {
      ...result,
      humanText: formatLiteResultHuman(payload),
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
