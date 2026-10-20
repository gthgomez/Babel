/** Shared ACP harness RPC error identity (Command Code + OpenCode own-CLI transports). */

export const ACP_HARNESS_RPC_TIMEOUT_PREFIX = 'ACP_HARNESS_RPC_TIMEOUT:';

export function createAcpHarnessRpcTimeoutError(method: string): Error {
  return new Error(`${ACP_HARNESS_RPC_TIMEOUT_PREFIX}${method}`);
}

export function acpHarnessRpcTimeoutMethod(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error);
  if (!text.startsWith(ACP_HARNESS_RPC_TIMEOUT_PREFIX)) return undefined;
  const method = text.slice(ACP_HARNESS_RPC_TIMEOUT_PREFIX.length);
  return method || undefined;
}

export function isAcpHarnessRpcTimeoutError(error: unknown, method?: string): boolean {
  const resolved = acpHarnessRpcTimeoutMethod(error);
  if (!resolved) return false;
  return method ? resolved === method : true;
}

/** Legacy vendor-prefixed timeout strings from pre-recovery candidates. */
export function isLegacyAcpRpcTimeoutError(error: unknown, method: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes(`COMMAND_CODE_ACP_RPC_TIMEOUT:${method}`) ||
    text.includes(`OPENCODE_ACP_RPC_TIMEOUT:${method}`)
  );
}

export function isAnyAcpPromptTimeoutError(error: unknown): boolean {
  return (
    isAcpHarnessRpcTimeoutError(error, 'session/prompt') ||
    isLegacyAcpRpcTimeoutError(error, 'session/prompt')
  );
}
