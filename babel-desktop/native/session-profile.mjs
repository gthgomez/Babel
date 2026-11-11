import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_POLICY_FILE = 'execution-policy.json'

/**
 * Resolve the command boundary a resumed Desktop session already proved.
 * A legacy session without a record retains the guarded Docker profile that
 * every older Desktop build used; it must not silently acquire host authority.
 */
export function resolveSessionExecutionProfile(sessionId, { sessionsDir, defaultProfile = 'host_native' } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return { profile: defaultProfile, recorded: false }
  if (!/^[\w-]{1,80}$/.test(sessionId)) throw new Error('Invalid chat session id.')
  if (typeof sessionsDir !== 'string' || !sessionsDir) throw new Error('Session storage is unavailable.')
  const file = join(sessionsDir, sessionId, SESSION_POLICY_FILE)
  let raw
  try { raw = readFileSync(file, 'utf8') }
  catch (error) {
    if (error?.code === 'ENOENT') return { profile: 'safe_repo', recorded: false }
    throw new Error('The saved execution policy cannot be read. Review the session before continuing.')
  }
  if (raw.length > 4096) throw new Error('The saved execution policy is invalid.')
  let record
  try { record = JSON.parse(raw) } catch { throw new Error('The saved execution policy is invalid.') }
  const profile = record?.profile, boundary = record?.effectiveBoundary
  if (record?.version !== 1 || !['host_native', 'safe_repo'].includes(profile) || !['host', 'docker'].includes(boundary)) {
    throw new Error('The saved execution policy is invalid.')
  }
  if ((profile === 'host_native' && boundary !== 'host') || (profile === 'safe_repo' && boundary !== 'docker')) {
    throw new Error('The saved execution policy is invalid.')
  }
  return { profile, recorded: true }
}
