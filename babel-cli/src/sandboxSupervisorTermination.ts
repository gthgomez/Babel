import { normalizeShellOutput, type NormalizedShellOutput } from './shellOutputNormalize.js';

/** spawnSync child ran but the supervisor ended it (timeout or output cap). */
export function isSpawnSyncRuntimeSupervisorError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ETIMEDOUT' ||
    code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    code === 'ENOBUFS'
  );
}

/**
 * Async child launched successfully, then the supervisor ended it (timeout) or
 * output was capped — not a could-not-launch failure.
 */
export function isChildRuntimeSupervisorError(
  error: Error,
  processStarted: boolean,
  timedOut: boolean,
): boolean {
  if (timedOut && processStarted) return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && processStarted) return true;
  if (code === 'ENOBUFS' && processStarted) return true;
  if (code === 'ETIMEDOUT' && processStarted) return true;
  return /spawn .+ etimedout/i.test(error.message) && processStarted;
}

/**
 * Child output after the supervisor ended a launched process (timeout or
 * stdio cap). The child may exit 0 after SIGTERM; the tool result must still
 * be non-success and must not carry host launch_failure.
 */
export function normalizeSupervisorTerminatedShellOutput(
  status: number | null,
  rawStdout: string,
  rawStderr: string,
  stdoutWasTruncated = false,
  stderrWasTruncated = false,
): NormalizedShellOutput {
  const exitStatus = status === 0 || status === null ? 1 : status;
  return normalizeShellOutput(exitStatus, rawStdout, rawStderr, stdoutWasTruncated, stderrWasTruncated);
}
