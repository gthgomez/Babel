import type { TaskOperation } from '../config/chatTaskClass.js';

/**
 * Ordinary Chat has no lease-governed adapter for language-server processes.
 * Host fallback controls isolation, not action authority. Withhold both schema
 * and dispatch until LSP startup passes the same admission boundary as commands.
 * Keep this single capability projection for every supported Chat protocol.
 */
export function canUseChatLsp(_input: {
  hostFallbackAllowed: boolean;
  operation?: TaskOperation;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return false;
}
