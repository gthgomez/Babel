/**
 * Pure startup/resume hint helpers (no I/O).
 * Default launch must not force a session picker.
 */

export function shouldForceResumePicker(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['CI'] || env['BABEL_SKIP_RESUME_PICKER'] === '1') return false;
  return env['BABEL_RESUME_PICKER'] === '1';
}

export function formatResumeHint(session: {
  id: string;
  mtimeMs: number;
  preview?: string;
}, now = Date.now()): string {
  const ago = formatRelativeTime(session.mtimeMs, now);
  return `  last session: ${ago}  /resume ${session.id}  (or /resume)`;
}

export function formatRelativeTime(mtimeMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - mtimeMs);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
