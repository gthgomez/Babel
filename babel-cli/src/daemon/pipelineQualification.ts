/** Daemon pipeline execution remains quarantined until settlement and recovery are qualified. */
export function isDaemonPipelineQualified(): boolean {
  return false
}

/** Reject the streaming IPC entry before any pipeline or inference starts. */
export function rejectUnqualifiedDaemonPipeline(socket: Pick<import('node:net').Socket, 'write' | 'end'>): boolean {
  if (isDaemonPipelineQualified()) return false
  socket.write(JSON.stringify({ type: 'pipeline_error', error: { code: -32000, message: 'UNSUPPORTED_OPERATION: Daemon pipeline execution is quarantined pending settlement and recovery qualification.' } }) + '\n')
  socket.end()
  return true
}
