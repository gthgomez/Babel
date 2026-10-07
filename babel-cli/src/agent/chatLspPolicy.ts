import type { TaskOperation } from '../config/chatTaskClass.js';
import { isReadOnlyChat } from './chatReadOnly.js';

/**
 * LSP starts project-configured processes directly on the host. Task scope may
 * narrow that capability, but only the governed execution profile grants its
 * host-process boundary; Docker does not contain the current LSP spawn path.
 */
export function canUseChatLsp(input: {
  hostFallbackAllowed: boolean;
  operation?: TaskOperation;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  return input.hostFallbackAllowed && input.operation !== 'READ_ONLY' && !isReadOnlyChat(env);
}
