/** Single quarantine message shared by daemon entrypoints and queue consumers. */
export const DAEMON_PIPELINE_QUARANTINE_MESSAGE =
  'UNSUPPORTED_OPERATION: Daemon pipeline execution is quarantined pending settlement and recovery qualification.';

/** Daemon pipeline execution remains quarantined until settlement and recovery are qualified. */
export function isDaemonPipelineQualified(): boolean {
  return false;
}

/** Clear preflight reason for refusing background work before it is queued. */
export function daemonPipelineEnqueueRejection(): string | null {
  return isDaemonPipelineQualified() ? null : DAEMON_PIPELINE_QUARANTINE_MESSAGE;
}

/** Reject the streaming IPC entry before any pipeline or inference starts. */
export function rejectUnqualifiedDaemonPipeline(
  socket: Pick<import('node:net').Socket, 'write' | 'end'>,
): boolean {
  if (isDaemonPipelineQualified()) return false;
  socket.write(
    JSON.stringify({
      type: 'pipeline_error',
      error: { code: -32000, message: DAEMON_PIPELINE_QUARANTINE_MESSAGE },
    }) + '\n',
  );
  socket.end();
  return true;
}
