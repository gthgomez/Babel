/** Hard cap on combined stdout + stderr bytes returned from shellExec. */
export const MAX_SHELL_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

export interface NormalizedShellOutput {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export function normalizeShellOutput(
  status: number | null,
  rawStdout: string,
  rawStderr: string,
  stdoutWasTruncated = false,
  stderrWasTruncated = false,
): NormalizedShellOutput {
  let stdout = rawStdout;
  let stderr = rawStderr;
  if (process.platform === 'win32') {
    stdout = stdout.replace(/\r\n/g, '\n');
    stderr = stderr.replace(/\r\n/g, '\n');
  }

  const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(stderr, 'utf8');
  if (stdoutBytes > MAX_SHELL_OUTPUT_BYTES || stdoutWasTruncated) {
    stdout =
      Buffer.from(stdout, 'utf8').subarray(0, MAX_SHELL_OUTPUT_BYTES).toString('utf8') +
      `\n[sandbox] stdout truncated — output exceeded ${MAX_SHELL_OUTPUT_BYTES / (1024 * 1024)} MB cap.`;
  }
  if (stderrBytes > MAX_SHELL_OUTPUT_BYTES || stderrWasTruncated) {
    stderr =
      Buffer.from(stderr, 'utf8').subarray(0, MAX_SHELL_OUTPUT_BYTES).toString('utf8') +
      `\n[sandbox] stderr truncated — output exceeded ${MAX_SHELL_OUTPUT_BYTES / (1024 * 1024)} MB cap.`;
  }
  return { exit_code: status ?? 1, stdout, stderr };
}
