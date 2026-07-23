/**
 * Fail-fast for platform-broken verifier processes (esp. Windows NTSTATUS crashes).
 * Prevents re-running the same dying command (and re-caching red receipts) forever.
 */

/** Known fatal Windows process exits observed in SWE harness thrash (unsigned). */
const FATAL_WINDOWS_EXITS = new Set<number>([
  0xc0000005 >>> 0, // STATUS_ACCESS_VIOLATION
  0xc000013a >>> 0, // STATUS_CONTROL_C_EXIT
  0xc0000142 >>> 0, // STATUS_DLL_INIT_FAILED (common Django/python crash on win32)
  0xc0000409 >>> 0, // STATUS_STACK_BUFFER_OVERRUN
  3221225477,
  3221225786,
  3221225794, // A06 repeated crash
  3221226505,
]);

/** Normalize signed Node exit codes to unsigned 32-bit. */
export function toUnsignedExitCode(exitCode: number): number {
  return exitCode < 0 ? exitCode >>> 0 : exitCode;
}

/**
 * True when exit looks like a Windows process hard-fault, not a normal test failure.
 * Normal pytest/unittest non-zero (1, 2, 4, 5) stay false.
 */
export function isFatalWindowsProcessExit(exitCode: number | null | undefined): boolean {
  if (exitCode == null || exitCode === 0) return false;
  const u = toUnsignedExitCode(exitCode);
  if (FATAL_WINDOWS_EXITS.has(u) || FATAL_WINDOWS_EXITS.has(exitCode)) return true;
  // NTSTATUS error severity bits 31–30 = 11 → 0xCxxxxxxx
  if ((u & 0xc0000000) === 0xc0000000) return true;
  return false;
}

/**
 * Record a platform-unusable verifier in the tool-call log, fire the callback,
 * and return the "platform_unusable" observation. Extracted from ChatEngine
 * to keep chatEngine.ts under size ratchet.
 */
export function logPlatformUnusableResult(input: {
  toolCallLog: Array<{
    tool: string;
    target: string;
    detail?: string;
    error?: string;
    index: number;
    exit_code?: number;
  }>;
  tool: string;
  target: string;
  exitCode: number;
  meta: { index: number };
  toolId: number;
  callbacks: { onToolComplete?: (id: number, detail?: string) => void };
}): { index: number; observation: string } {
  input.toolCallLog.push({
    tool: input.tool,
    target: input.target,
    detail: 'platform_unusable',
    error: 'platform_unusable',
    index: input.meta.index,
    exit_code: input.exitCode,
  });
  input.callbacks.onToolComplete?.(input.toolId, 'platform_unusable');
  return {
    index: input.meta.index,
    observation: formatPlatformVerifierUnusableObservation(
      input.tool,
      input.target,
      input.exitCode,
    ),
  };
}

export function formatPlatformVerifierUnusableObservation(
  tool: string,
  command: string,
  exitCode: number,
): string {
  const hex = `0x${toUnsignedExitCode(exitCode).toString(16).toUpperCase()}`;
  return [
    `### ${tool} ${command}`,
    `exit_code: ${exitCode}`,
    '```',
    `PLATFORM_VERIFIER_UNUSABLE: process died with fatal Windows exit ${exitCode} (${hex}).`,
    'Do NOT re-run this exact command — it will crash again and waste the budget.',
    'Options: try a narrower unit invocation if known safe, or stop verifying on this platform',
    'and finish with an honest summary of the patch (local gold_diff / human review on Windows).',
    '```',
  ].join('\n');
}
